/**
 * Session → requirement context extractor.
 *
 * Role: build a fixed-template Chinese prompt that asks OpenCode to
 * summarize a given session's whole history under a target requirement,
 * spawn `opencode run --session <id>` to generate the summary, and
 * append the (human-confirmed) summary into the requirement's notes.md.
 *
 * Public surface:
 *   - buildExtractPrompt(req): build the fixed-template prompt string
 *   - runExtractSummary({sessionId, prompt, model, timeoutMs}): spawn
 *     opencode and return stdout (or throw with stderr/exit-code info)
 *   - appendSummaryToNotes(notesPath, sessionId, body): atomically
 *     append a timestamped section to notes.md, creating the file if
 *     absent
 *
 * Constraints / safety:
 *   - Spawns `opencode` via child_process.spawn with a fixed argv (no
 *     shell). Both sessionId and reqId are pre-validated by callers.
 *   - Never reads or prints `.env` / secret files.
 *   - notes.md is treated as free-form Markdown — we append, we don't
 *     parse/rewrite existing content.
 *
 * Read-this-with:
 *   - `src/requirements.ts` (Requirement type, notesPath lookup)
 *   - `src/server.tsx` (routes that drive the preview/commit flow)
 */

import { spawn } from "node:child_process"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname } from "node:path"

import type { Requirement } from "./requirements.ts"
import { runQueuedOpencodeProcess } from "./opencodeProcessQueue.ts"

/** Cap stdout we keep in memory; opencode summaries are tiny (< 4KB). */
const MAX_STDOUT_BYTES = 256 * 1024
/** Cap stderr we keep for error reporting. */
const MAX_STDERR_BYTES = 16 * 1024
/**
 * Default timeout for `opencode run --session ... --fork`.
 *
 * A fork has to load the full session history before generating, so on
 * long mq-migration sessions with a slow model 1–2 minutes is common
 * and 3+ minutes is not unusual. 300s leaves enough headroom without
 * letting a truly stuck spawn hang forever.
 */
export const DEFAULT_EXTRACT_TIMEOUT_MS = 300_000

/**
 * Default model used for the summarization spawn.
 *
 * Hardcoded to `litellm-local/deepseek-v4-flash-auto` because:
 *   - the prompt is small and structured; flash is more than capable
 *   - using the user's daily-driver (heavier) model frequently hit the
 *     2-minute timeout on long sessions
 *   - keeping it out of opencode's model-auto-pick avoids a 5-30s
 *     warm-up before generation even starts
 *
 * Callers can override this via RunExtractOptions.model; keeping the
 * constant exported gives tests and config defaults one fallback value.
 */
export const EXTRACT_MODEL = "litellm-local/deepseek-v4-flash-auto"

/**
 * Build the fixed-template prompt sent to `opencode run --session <id>`.
 *
 * Why fixed-template:
 *   - users want predictable, comparable summaries across sessions
 *   - the dashboard is not the place to expose prompt engineering knobs
 *
 * The prompt is intentionally short and *output-shape-constrained* so
 * the assistant doesn't ramble. Keep the section list and "不超过 50 行"
 * wording in sync with the documented behaviour in AGENTS.md.
 */
export function buildExtractPrompt(req: Pick<Requirement, "id" | "title" | "status">): string {
  const title = (req.title || "").trim() || req.id
  const status = (req.status || "").trim() || "未知"
  return [
    "请用中文总结本次会话，作为需求《" + title + "》（当前状态：" + status + "）的上下文沉淀。",
    "",
    "严格按以下 5 个区块输出，每个区块用二级标题（##）开头；总篇幅不超过 50 行：",
    "",
    "## 目标",
    "本次会话试图为该需求达成的目标，一两句话。",
    "",
    "## 关键决策",
    "用项目符号列出做出的设计/取舍决定，每条一行。",
    "",
    "## 影响的文件/模块",
    "列出本次涉及修改、查阅、调试的关键文件路径或模块名（不需要 diff）。",
    "",
    "## 已完成的验证",
    "列出已运行过的测试、构建、命令或人工验证，及其结果。",
    "",
    "## 待办 / 风险",
    "列出未完成项、阻塞、需后续确认的点；没有就写「无」。",
    "",
    "不要复述会话原文，不要写客套话，不要 markdown 代码块包裹整篇输出。",
  ].join("\n")
}

export interface ExtractResult {
  /** Trimmed stdout from opencode (the summary itself). */
  stdout: string
  /** Trimmed stderr (warnings, logs). May be empty. */
  stderr: string
  /** Process exit code; 0 on success, non-zero or null on failure. */
  exitCode: number | null
  /** Wall-clock duration in ms. */
  durationMs: number
  /** True if the spawn or wait timed out. */
  timedOut: boolean
}

export interface RunExtractOptions {
  sessionId: string
  prompt: string
  /** Model to pass to `opencode run -m`; defaults to EXTRACT_MODEL. */
  model?: string
  /** Override for tests; if set, used as the executable instead of "opencode". */
  opencodeBin?: string
  timeoutMs?: number
  /** Optional spawn override (tests). Must match child_process.spawn signature. */
  spawnFn?: typeof spawn
}

/**
 * Run `opencode run --session <id> --fork -m <model> <prompt>` and
 * capture stdout.
 *
 * Critical: we always pass `--fork`. Without it, `opencode run --session`
 * appends the prompt and the assistant's summary reply as two new
 * messages to the *original* session, permanently polluting its history.
 * `--fork` tells opencode to clone the session first and run the prompt
 * on the clone, leaving the original session byte-identical.
 *
  * Why we pass `-m`: the prompt is short + structured, and a fast model
  * avoids hitting our timeout on long sessions. The dashboard settings
  * page can override the fallback `EXTRACT_MODEL`.
 *
 * Errors / edge cases:
 *   - opencode missing / exits non-zero → resolves with exitCode set and
 *     timedOut=false; caller decides how to surface it (we don't throw
 *     so the preview page can show stderr to the user).
 *   - timeout → SIGKILL the process, resolve with timedOut=true.
 *   - stdout is truncated to MAX_STDOUT_BYTES; stderr to MAX_STDERR_BYTES.
 */
export function runExtractSummary(opts: RunExtractOptions): Promise<ExtractResult> {
  const bin = opts.opencodeBin || "opencode"
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS
  const model = opts.model && opts.model.trim() ? opts.model.trim() : EXTRACT_MODEL
  const startedAt = Date.now()

  return runQueuedOpencodeProcess({
    bin,
    args: ["run", "--session", opts.sessionId, "--fork", "-m", model, opts.prompt],
    spawnOptions: { stdio: ["ignore", "pipe", "pipe"] },
    timeoutMs,
    spawnFn: opts.spawnFn,
  }).then((result) => ({
    stdout: result.stdout.length > MAX_STDOUT_BYTES ? result.stdout.slice(0, MAX_STDOUT_BYTES) : result.stdout,
    stderr: result.stderr.length > MAX_STDERR_BYTES ? result.stderr.slice(0, MAX_STDERR_BYTES) : result.stderr,
    exitCode: result.exitCode,
    durationMs: Date.now() - startedAt,
    timedOut: result.timedOut,
  }))
}

/**
 * Append a session summary as a new section to notes.md. Creates the
 * file (and parent dir) if missing. Always prepends a leading blank
 * line so successive appends don't run together.
 *
 * Why we don't try to dedupe by session id: the user can edit the body
 * before commit. Two appends for the same session id = the user
 * deliberately re-extracted; that's allowed. The timestamp in the
 * heading keeps sections distinguishable.
 */
export async function appendSummaryToNotes(
  notesPath: string,
  sessionId: string,
  body: string,
  now: Date = new Date(),
): Promise<void> {
  const dir = dirname(notesPath)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
  const heading = `## Session ${sessionId} 摘要 (${formatLocalIso(now)})`
  const trimmedBody = body.trim()
  const section = `\n\n${heading}\n\n${trimmedBody}\n`
  if (!existsSync(notesPath)) {
    // Start the file with a top-level heading so it stays consistent
    // with the other hermes-managed notes.md files.
    const initial = `# Session 摘要 / 上下文沉淀\n${section}`
    await writeFile(notesPath, initial, "utf-8")
    return
  }
  await appendFile(notesPath, section, "utf-8")
}

/** Format `Date` as a local-time ISO-like string without seconds-precision noise. */
function formatLocalIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    d.getFullYear() +
    "-" + pad(d.getMonth() + 1) +
    "-" + pad(d.getDate()) +
    " " + pad(d.getHours()) +
    ":" + pad(d.getMinutes())
  )
}
