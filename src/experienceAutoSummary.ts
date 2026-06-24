/**
 * Background worker for auto-summarizing marked sessions.
 *
 * Role: poll the marker store for sessions the user flagged. When a
 * marked session has been idle for ≥1 hour, fork it to generate an
 * experience report. After the user reviews the report and confirms
 * candidates, spawn a second fork to execute the confirmed items.
 *
 * Lifecycle (driven by marker status):
 *   marked → summarizing → summarized → confirming → executed
 *                                     ↘ failed
 *
 * The summary fork runs `opencode run --session <id> --fork -m <model>`
 * with a prompt that asks the agent to produce a standard
 * experience-summary report (parseable by `src/parser.ts`). The report
 * is written to `/tmp/opencode/handoff/auto-summary/<sid>/report.md`.
 *
 * The execution fork runs the same command with a prompt that tells
 * the agent to read the report, execute only the confirmed candidate
 * IDs, and use the appropriate writer/maintainer skills.
 *
 * Public surface:
 *   - startAutoSummaryWorker(): start the periodic poll loop
 *   - stopAutoSummaryWorker(): stop the poll loop (for tests)
 *   - triggerSummaryForMarker(marker): manually trigger summary (for
 *     tests or API-driven initiation)
 *   - triggerExecutionForMarker(sessionId, confirmedIds): manually
 *     trigger execution (called from the confirm API)
 *   - buildSummaryPrompt(sessionId): build the fork prompt
 *   - buildExecutionPrompt(reportPath, confirmedIds): build the exec prompt
 *
 * Constraints / safety:
 *   - Only `node:` built-ins + `sessionExtract.ts` (reuses the
 *     spawn/fork/timeout/salvage infrastructure).
 *   - Never reads or writes `.env` / secret files.
 *   - Session ids are validated before any spawn.
 *
 * Read-this-with:
 *   - `src/experienceMarkers.ts` (the marker store this worker polls).
 *   - `src/sessionExtract.ts` (runExtractSummary — the spawn mechanism).
 *   - `src/sessions.ts` (SessionInfo for idle-time computation).
 *   - `src/scanner.ts` (report scanning — the worker writes reports to
 *     the same handoff directory the scanner reads from).
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  findProcessableMarkers,
  updateMarker,
  getMarker,
  type ExperienceMarker,
} from "./experienceMarkers.ts"
import {
  runExtractSummary,
  EXTRACT_MODEL,
  type ExtractResult,
  type RunExtractOptions,
} from "./sessionExtract.ts"
import {
  salvageFromFork,
} from "./forkSalvage.ts"
import { scanSessions, type SessionInfo } from "./sessions.ts"
import {
  createNotification,
  updateNotification,
} from "./notifications.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Session must be idle for ≥1 hour before auto-summary triggers. */
export const IDLE_THRESHOLD_MS = 60 * 60 * 1000

/** Poll interval for the background worker. */
export const POLL_INTERVAL_MS = 5 * 60 * 1000

/** Handoff directory for auto-summary reports. */
const HANDOFF_DIR = "/tmp/opencode/handoff/auto-summary"

/** Timeout for summary/execution forks (longer than extract: these are full-session summaries). */
const FORK_TIMEOUT_MS = 600_000 // 10 minutes

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Build the prompt sent to the fork session for experience summary.
 *
 * The prompt asks the agent to produce a report in the same format as
 * `experience-summarizer` so `src/parser.ts` can parse it.
 */
export function buildSummaryPrompt(sessionId: string): string {
  return [
    `你是经验总结助手。请回顾本会话（session ${sessionId}）的完整历史，提取可沉淀的经验候选，并按指定格式输出报告。`,
    "",
    "## 输出格式（严格遵守）",
    "",
    "# Experience Summary Report",
    "",
    "## 元信息",
    `- Session: ${sessionId}`,
    "- Artifact: (none)",
    "- Summary scope: full session",
    `- Generated: ${new Date().toISOString()}`,
    "",
    "## 中高价值候选",
    "",
    "### 候选清单",
    "1. `[C1]` [标题]",
    "   价值评级: 高/中（[依据]）",
    "   验证依据: [runtime-derivable | code-derivable | code-derivable exception] — [证据]",
    "   来源: [知识/测试状态图/Skill 改进/自动化脚本/主子 agent 互动优化]",
    "   目标文件或目录: [path]",
    "   变更摘要: [要写什么]",
    "   后续处理 skill: [writer/maintainer skill]",
    "   关键证据: [证据引用]",
    "   执行注意事项: [边界、不要写什么、依赖前提]",
    "",
    "### 主/子 agent 互动优化候选",
    "- 仅列中/高价值项；如果没有，写 `None`。",
    "",
    "## Low-value omitted",
    "- <count and one-line reason, or `0`>",
    "",
    "## Risks/gaps",
    "- <missing evidence, ambiguity, or `None known`>",
    "",
    "## 规则",
    "- 只保留中/高价值候选，丢弃低价值候选。",
    "- 优先评高有 runtime/执行证据的经验（查过日志/DB/API、跑过测试、真实排障问题）。",
    "- 仅靠读代码可推出的结论默认最高到中；除非有发布/安全/数据风险等长期风险才可评高，并标注 [code-derivable exception]。",
    "- 不记录 token、Cookie、密码、私钥、真实连接密钥或敏感环境变量。",
    "- 不要写客套话，不要用 markdown 代码块包裹整篇输出。",
  ].join("\n")
}

/**
 * Build the prompt sent to the fork session for confirmed-item execution.
 *
 * The agent reads the report file, matches the confirmed candidate IDs,
 * and executes each one using the appropriate writer/maintainer skill.
 */
export function buildExecutionPrompt(reportPath: string, confirmedIds: string[]): string {
  return [
    `你是经验总结执行助手。用户已审阅报告并确认了以下候选：${confirmedIds.join(", ")}`,
    "",
    `报告文件路径: ${reportPath}`,
    "",
    "## 执行规则",
    "",
    "1. 读取报告文件，匹配确认的候选 ID。",
    "2. 对每个确认候选，提取目标文件/目录、变更摘要、后续处理 skill。",
    "3. 使用对应的 writer/maintainer skill 执行每个确认候选。",
    "4. 只执行确认的候选 ID，不执行未确认、低价值或范围外项。",
    "5. 不修改 meta.md 中的 Status 行。",
    "6. 不记录 token、Cookie、密码、私钥、真实连接密钥或敏感环境变量。",
    "",
    "## 输出格式",
    "",
    "返回紧凑的执行结果：",
    "",
    "```",
    "Result:",
    "- `EXECUTED`, `PARTIAL_EXECUTED`, or `BLOCKED` with one sentence.",
    "",
    "Executed:",
    "- `[C1]` [title]: done — <files changed>",
    "",
    "Not executed:",
    "- <candidate ID and reason, or `None`>",
    "```",
    "",
    "不要写客套话，不要输出原始报告内容。",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Idle-time computation
// ---------------------------------------------------------------------------

/**
 * Compute how long a session has been idle (ms since last `updated`).
 * Returns Infinity if the session can't be found.
 */
export function computeIdleMs(session: SessionInfo | null, now = Date.now()): number {
  if (!session) return Infinity
  const updated = session.updated || session.created || 0
  if (!updated) return Infinity
  return Math.max(0, now - updated)
}

// ---------------------------------------------------------------------------
// Summary trigger
// ---------------------------------------------------------------------------

/**
 * Trigger a summary fork for a marker.
 *
 * Spawns `opencode run --session <id> --fork -m <model>` with the
 * summary prompt, waits for completion, and writes the report to
 * `/tmp/opencode/handoff/auto-summary/<sid>/report.md`.
 *
 * The marker is transitioned:
 *   marked → summarizing → summarized (on success)
 *                       → failed (on failure)
 *
 * On timeout/failure, the salvage path from `forkSalvage.ts` is tried
 * to recover partial output from the fork session.
 */
export async function triggerSummaryForMarker(
  marker: ExperienceMarker,
  opts?: {
    model?: string
    runFn?: (opts: RunExtractOptions) => Promise<ExtractResult>
    salvageFn?: typeof salvageFromFork
  },
): Promise<void> {
  const sessionId = marker.sessionId
  const dir = join(HANDOFF_DIR, sessionId)
  const reportPath = join(dir, "report.md")
  const model = opts?.model ?? EXTRACT_MODEL
  const salvageFn = opts?.salvageFn ?? salvageFromFork

  // Transition to summarizing.
  await updateMarker(sessionId, {
    status: "summarizing",
    summaryStartedAt: new Date().toISOString(),
    summaryCompletedAt: null,
    reportPath: null,
    summaryForkSessionId: null,
    errorMessage: null,
  })

  // Notify the user that the summary fork has started.
  const notifId = createNotification({
    type: "extract",
    title: "正在 fork session 生成经验报告…",
    subtitle: `session ${sessionId}`,
    state: "running",
    sessionId,
    actionHref: null,
  })

  const prompt = buildSummaryPrompt(sessionId)
  const runner = opts?.runFn ?? runExtractSummary

  let result: ExtractResult
  try {
    result = await runner({
      sessionId,
      prompt,
      model,
      timeoutMs: FORK_TIMEOUT_MS,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await updateMarker(sessionId, {
      status: "failed",
      errorMessage: `Spawn error: ${msg}`,
      summaryCompletedAt: new Date().toISOString(),
    })
    updateNotification(notifId, {
      title: "✗ 经验报告生成失败",
      subtitle: `session ${sessionId} · Spawn error: ${msg}`,
      state: "failed",
    })
    return
  }

  // Happy path: stdout has the report.
  if (!result.timedOut && result.exitCode === 0 && result.stdout.length > 0) {
    await mkdir(dir, { recursive: true })
    await writeFile(reportPath, result.stdout, "utf-8")
    await updateMarker(sessionId, {
      status: "summarized",
      reportPath,
      summaryCompletedAt: new Date().toISOString(),
      errorMessage: null,
    })
    updateNotification(notifId, {
      title: "✓ 经验报告已生成",
      subtitle: `session ${sessionId} · 点击查看候选`,
      state: "done",
      actionHref: `/report?path=${encodeURIComponent(reportPath)}`,
    })
    return
  }

  // Salvage path: try to recover from the fork session.
  let salvage: Awaited<ReturnType<typeof salvageFromFork>> = null
  try {
    salvage = await salvageFn({
      sourceSessionId: sessionId,
      startedAt: Date.parse(marker.summaryStartedAt ?? new Date().toISOString()),
      promptAnchor: prompt.slice(0, 30),
    })
  } catch {
    salvage = null
  }

  if (salvage && salvage.text.length > 0) {
    await mkdir(dir, { recursive: true })
    await writeFile(reportPath, salvage.text, "utf-8")
    await updateMarker(sessionId, {
      status: "summarized",
      reportPath,
      summaryForkSessionId: salvage.forkSessionId,
      summaryCompletedAt: new Date().toISOString(),
      errorMessage: null,
    })
    updateNotification(notifId, {
      title: "✓ 经验报告已生成（从 fork 救回）",
      subtitle: `session ${sessionId} · 点击查看候选`,
      state: "done",
      actionHref: `/report?path=${encodeURIComponent(reportPath)}`,
    })
    return
  }

  // Failure.
  const errorMsg = result.timedOut
    ? `Summary fork timed out after ${Math.round(FORK_TIMEOUT_MS / 1000)}s`
    : result.exitCode !== 0
    ? `Summary fork exited with code ${result.exitCode}`
    : "Summary fork produced no output"

  await updateMarker(sessionId, {
    status: "failed",
    errorMessage: errorMsg,
    summaryCompletedAt: new Date().toISOString(),
  })
  updateNotification(notifId, {
    title: "✗ 经验报告生成失败",
    subtitle: `session ${sessionId} · ${errorMsg}`,
    state: "failed",
  })
}

// ---------------------------------------------------------------------------
// Execution trigger
// ---------------------------------------------------------------------------

/**
 * Trigger an execution fork for confirmed candidates.
 *
 * Spawns `opencode run --session <id> --fork -m <model>` with the
 * execution prompt. The marker is transitioned:
 *   summarized → confirming → executed (on success)
 *                          → failed (on failure)
 */
export async function triggerExecutionForMarker(
  sessionId: string,
  confirmedIds: string[],
  opts?: {
    model?: string
    runFn?: (opts: RunExtractOptions) => Promise<ExtractResult>
  },
): Promise<void> {
  const marker = getMarker(sessionId)
  if (!marker) throw new Error(`No marker for session ${sessionId}`)
  if (!marker.reportPath) throw new Error("No report path for marker")
  if (confirmedIds.length === 0) throw new Error("No confirmed candidate IDs")

  const model = opts?.model ?? EXTRACT_MODEL
  const prompt = buildExecutionPrompt(marker.reportPath, confirmedIds)
  const runner = opts?.runFn ?? runExtractSummary

  await updateMarker(sessionId, {
    status: "confirming",
    confirmedCandidateIds: confirmedIds,
    executionStartedAt: new Date().toISOString(),
    executionCompletedAt: null,
    executionForkSessionId: null,
    errorMessage: null,
  })

  // Notify the user that the execution fork has started.
  const execNotifId = createNotification({
    type: "extract",
    title: "正在 fork session 执行确认候选…",
    subtitle: `session ${sessionId} · ${confirmedIds.length} 个候选`,
    state: "running",
    sessionId,
    actionHref: null,
  })

  let result: ExtractResult
  try {
    result = await runner({
      sessionId,
      prompt,
      model,
      timeoutMs: FORK_TIMEOUT_MS,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await updateMarker(sessionId, {
      status: "failed",
      errorMessage: `Execution spawn error: ${msg}`,
      executionCompletedAt: new Date().toISOString(),
    })
    updateNotification(execNotifId, {
      title: "✗ 候选执行失败",
      subtitle: `session ${sessionId} · ${msg}`,
      state: "failed",
    })
    return
  }

  if (!result.timedOut && result.exitCode === 0) {
    await updateMarker(sessionId, {
      status: "executed",
      executionCompletedAt: new Date().toISOString(),
      errorMessage: null,
    })
    updateNotification(execNotifId, {
      title: "✓ 候选执行完成",
      subtitle: `session ${sessionId} · ${confirmedIds.join(", ")}`,
      state: "done",
    })
    return
  }

  const errorMsg = result.timedOut
    ? `Execution fork timed out after ${Math.round(FORK_TIMEOUT_MS / 1000)}s`
    : `Execution fork exited with code ${result.exitCode}`

  await updateMarker(sessionId, {
    status: "failed",
    errorMessage: errorMsg,
    executionCompletedAt: new Date().toISOString(),
  })
  updateNotification(execNotifId, {
    title: "✗ 候选执行失败",
    subtitle: `session ${sessionId} · ${errorMsg}`,
    state: "failed",
  })
}

// ---------------------------------------------------------------------------
// Background worker
// ---------------------------------------------------------------------------

let _timer: ReturnType<typeof setInterval> | null = null

/**
 * Start the background worker. Polls every `POLL_INTERVAL_MS` for
 * processable markers whose sessions have been idle for ≥1 hour.
 *
 * Safe to call multiple times — if already running, does nothing.
 */
export function startAutoSummaryWorker(): void {
  if (_timer) return
  _timer = setInterval(() => {
    void pollOnce().catch(() => {})
  }, POLL_INTERVAL_MS)
  // Don't keep the process alive just for the worker.
  if (typeof _timer.unref === "function") _timer.unref()
  // Run one poll immediately on startup.
  void pollOnce().catch(() => {})
}

/** Stop the background worker. */
export function stopAutoSummaryWorker(): void {
  if (_timer) {
    clearInterval(_timer)
    _timer = null
  }
}

/**
 * Single poll cycle: find processable markers, check idle time, and
 * trigger summary for those idle ≥1 hour.
 *
 * Exported for testing.
 */
export async function pollOnce(): Promise<void> {
  const markers = findProcessableMarkers()
  if (markers.length === 0) return

  const sessions = await scanSessions(true)
  const now = Date.now()

  for (const marker of markers) {
    const session = sessions.find((s) => s.id === marker.sessionId) ?? null
    const idleMs = computeIdleMs(session, now)
    if (idleMs >= IDLE_THRESHOLD_MS) {
      // Session is idle long enough — trigger summary.
      // Fire and forget; the marker store tracks progress.
      void triggerSummaryForMarker(marker).catch(() => {})
    }
  }
}
