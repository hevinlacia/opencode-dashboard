/**
 * In-memory job store for asynchronous `opencode run` extract jobs.
 *
 * Role: track "extract context from session" tasks that run in the
 * background after the user clicks the button. The detail page polls
 * `/api/extract/job/:id` until the job is `done` or `failed`, then
 * navigates to the preview page which reads the stdout out of this
 * same store.
 *
 * Public surface:
 *   - createExtractJob({reqId,sessionId,prompt,model,autoAdopt,reqDir}) → starts
 *     the spawn and returns the freshly-stored job (state="running"). Throws
 *     if a job for the same sessionId is already running globally. When
 *     `autoAdopt` is true, finalizeJob auto-writes parsed file diffs to
 *     `reqDir` instead of directing the user to a preview page.
 *   - getExtractJob(jobId) → snapshot of the job, or null when missing
 *     (e.g. evicted by TTL).
 *   - findRunningJobForSession(sessionId) → for the mutex/UI restore.
 *   - JOB_MAX_RUNNING_MS → max wall-clock for a running job before the
 *     zombie reaper force-fails it.
 *   - findRecentJobForSession(sessionId, withinMs) → most recent job
 *     for a session within the time window (for debounce).
 *   - checkExtractGuard(opts) → pure guard for debounce + no-new-content.
 *   - EXTRACT_DEBOUNCE_MS → debounce window (5 min).
 *   - _resetExtractJobs() → test-only reset of the singleton state.
 *
 * Constraints / safety:
 *   - Process-local Map; on dashboard restart all jobs are lost. We
 *     intentionally do NOT persist to disk — these tasks are short
 *     (≤120s) and re-runnable.
 *   - createExtractJob does its own spawn; it does NOT take a spawn fn
 *     parameter beyond a test injection point because we want one
 *     well-defined integration with `runExtractSummary`.
 *
 * Read-this-with:
 *   - `src/sessionExtract.ts` (the underlying spawn / prompt logic).
 *   - `src/server.tsx` routes `/api/requirement/extract-context` and
 *     `/api/extract/job/:id`.
 */

import { randomBytes } from "node:crypto"
import { writeFile, appendFile } from "node:fs/promises"
import { join } from "node:path"

import {
  runExtractSummary,
  DEFAULT_EXTRACT_TIMEOUT_MS,
  EXTRACT_MODEL,
  type ExtractResult,
  type RunExtractOptions,
} from "./sessionExtract.ts"
import { updateSessionTitle } from "./sessions.ts"
import {
  salvageFromFork,
  type SalvageResult,
} from "./forkSalvage.ts"
import {
  createNotification,
  updateNotification,
} from "./notifications.ts"
import {
  parseAutoExtractOutput,
  filterAllowed,
} from "./autoExtract.ts"
import {
  appendExtractHistory,
  buildExtractHistoryRecord,
} from "./extractHistory.ts"

export type JobState = "running" | "done" | "failed"
export type JobMode = "summary" | "auto"

export interface ExtractJob {
  id: string
  reqId: string
  sessionId: string
  state: JobState
  /** "summary" = plain markdown extract; "auto" = structured per-file diff. */
  mode: JobMode
  /** Model passed to `opencode run -m` for this extract job. */
  model: string
  startedAt: number
  doneAt: number | null
  /** Available once state !== "running". Empty string until then. */
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  /** Human-readable error message when state==="failed". */
  errorMessage: string | null
  /**
   * Set when we recovered the assistant's text from a fork session in
   * opencode's SQLite (typically after a spawn timeout). The preview
   * page surfaces this so the user can either merge the salvaged text
   * to notes.md or open the fork to see the full thread.
   */
  forkSessionId: string | null
  forkTitle: string | null
  salvagedFromFork: boolean
  /**
   * Parsed result for mode="auto" jobs. Populated by finalizeJob
   * after the spawn completes and the output is parsed.
   */
  autoResult: import("./autoExtract.ts").AutoExtractResult | null
  /**
   * When true, finalizeJob auto-writes the parsed file updates/appends
   * to `reqDir` instead of directing the user to a preview page.
   * Used by the scheduled auto-extract scheduler.
   */
  autoAdopt: boolean
  /**
   * Requirement directory for auto-adopt file writes. Null for manual
   * jobs that go through the preview/commit flow.
   */
  reqDir: string | null
  /**
   * Internal: anchor text stored on the job at creation time so the
   * salvage step in `finalizeJob` can identify the right fork in the
   * database. Not serialized to the API.
   */
  _promptAnchor: string
  /**
   * Internal: salvage implementation (test seam). Not serialized.
   */
  _salvageFn: ((opts: { sourceSessionId: string; startedAt: number; promptAnchor: string }) => Promise<SalvageResult | null>) | null
  /**
   * Internal: notification id in the notification center so finalizeJob
   * can update the bell badge when state transitions. Not serialized.
   */
  _notificationId: string | null
}

/** TTL after which a finished job is evicted from memory. */
export const JOB_TTL_MS = 30 * 60 * 1000

/**
 * Max wall-clock a job may stay in "running" state before the zombie
 * reaper force-transitions it to "failed". Set to 3× the spawn timeout
 * so normal slow jobs are not affected, but truly stuck jobs (e.g. the
 * child's pipe is held open by a grandchild) don't linger forever.
 */
export const JOB_MAX_RUNNING_MS = 3 * DEFAULT_EXTRACT_TIMEOUT_MS

const _jobs = new Map<string, ExtractJob>()

/** Generate a short, URL-safe job id (12 hex chars). */
function newJobId(): string {
  return randomBytes(6).toString("hex")
}

/**
 * Drop done/failed jobs older than JOB_TTL_MS. Also force-fails
 * "running" jobs that have exceeded `JOB_MAX_RUNNING_MS` — these are
 * zombie jobs where the underlying spawn's pipe never closed (e.g. a
 * grandchild process holds stdout open). Without this reaper, the job
 * and its notification stay "running" forever.
 */
function evictStale(now: number): void {
  for (const [id, j] of _jobs) {
    if (j.state === "running") {
      if (now - j.startedAt > JOB_MAX_RUNNING_MS) {
        j.state = "failed"
        j.doneAt = now
        j.errorMessage = "任务超时未响应（zombie job reaper）"
        if (j._notificationId) {
          updateNotification(j._notificationId, {
            title: "✗ 任务超时未响应",
            subtitle: `session ${j.sessionId} · 已运行超过 ${Math.round(JOB_MAX_RUNNING_MS / 60_000)} 分钟未完成`,
            state: "failed",
          })
        }
      }
      continue
    }
    if (j.doneAt && now - j.doneAt > JOB_TTL_MS) {
      _jobs.delete(id)
    }
  }
}

/**
 * Return the in-flight job for `sessionId` if one exists.
 *
 * Why this exists: the UI policy is "one extract per session id at a
 * time" — we use this to (a) refuse duplicate start requests, and (b)
 * let a freshly-loaded page re-attach to an already-running job (e.g.
 * the user navigated away mid-run and came back).
 */
export function findRunningJobForSession(sessionId: string): ExtractJob | null {
  evictStale(Date.now())
  for (const j of _jobs.values()) {
    if (j.state === "running" && j.sessionId === sessionId) return j
  }
  return null
}

/**
 * Return the most recent job (any state) for `sessionId` that was
 * started within `withinMs` ago. Used for debounce: prevents rapid
 * re-triggering of extracts for the same session.
 */
export function findRecentJobForSession(sessionId: string, withinMs: number): ExtractJob | null {
  evictStale(Date.now())
  const now = Date.now()
  let best: ExtractJob | null = null
  for (const j of _jobs.values()) {
    if (j.sessionId !== sessionId) continue
    if (now - j.startedAt > withinMs) continue
    if (!best || j.startedAt > best.startedAt) best = j
  }
  return best
}

// ---------------------------------------------------------------------------
// Extract guard (debounce + no-new-content)
// ---------------------------------------------------------------------------

/** Debounce window: prevent re-triggering extracts within this period. */
export const EXTRACT_DEBOUNCE_MS = 5 * 60 * 1000

export interface ExtractGuardResult {
  ok: boolean
  reason: string
  message: string
}

/**
 * Pure guard function: decide whether a new extract should be allowed.
 *
 * Two checks:
 *   1. **Debounce**: if a job was started within `debounceMs` ago, reject.
 *   2. **No new content**: if the session was successfully extracted
 *      before and `sessionUpdated` hasn't advanced past `lastExtractDoneAt`,
 *      reject — there's nothing new to extract.
 *
 * Both checks are skipped when their inputs are null (no recent job /
 * no prior extract), so the guard degrades to "allow" for first-time
 * extracts.
 */
export function checkExtractGuard(opts: {
  recentJob: ExtractJob | null
  lastExtract: { doneAt: number; mode: string } | null
  sessionUpdated: number
  now: number
  debounceMs?: number
}): ExtractGuardResult {
  const debounceMs = opts.debounceMs ?? EXTRACT_DEBOUNCE_MS

  // 1. Debounce: a job was started very recently (within the debounce window).
  if (opts.recentJob && opts.now - opts.recentJob.startedAt < debounceMs) {
    const elapsed = Math.round((opts.now - opts.recentJob.startedAt) / 1000)
    return {
      ok: false,
      reason: "debounce",
      message: `${elapsed}秒前刚触发过提取，${Math.ceil((debounceMs - (opts.now - opts.recentJob.startedAt)) / 60_000)}分钟后再试`,
    }
  }

  // 2. No new content: session was extracted before and hasn't been updated since.
  if (opts.lastExtract && opts.lastExtract.doneAt > 0) {
    if (opts.sessionUpdated <= opts.lastExtract.doneAt) {
      return {
        ok: false,
        reason: "no-new-content",
        message: "自上次提取以来无新对话，无需重复提取",
      }
    }
  }

  return { ok: true, reason: "ok", message: "" }
}

export function getExtractJob(jobId: string): ExtractJob | null {
  evictStale(Date.now())
  return _jobs.get(jobId) ?? null
}

export interface CreateExtractJobOptions {
  reqId: string
  sessionId: string
  prompt: string
  /** "summary" (default) or "auto" for structured per-file diff. */
  mode?: JobMode
  /** Model passed to `opencode run -m`. Defaults to EXTRACT_MODEL. */
  model?: string
  /** Test-only override to bypass real opencode spawn. */
  runFn?: (opts: RunExtractOptions) => Promise<ExtractResult>
  /** Test-only override for the wall-clock used in startedAt. */
  nowFn?: () => number
  /**
   * Test-only override for the SQLite salvage step. Production code
   * uses the real `salvageFromFork`.
   */
  salvageFn?: typeof salvageFromFork
  /**
   * First N characters of the prompt that uniquely identify our
   * dashboard's request in opencode's `part.data`. Defaults to the
   * first 30 chars of `prompt`. Exposed for tests so they can match
   * against a stub.
   */
  promptAnchor?: string
  /**
   * When true, the job auto-writes parsed file updates to `reqDir`
   * on completion instead of directing the user to a preview page.
   * Used by the scheduled auto-extract scheduler.
   */
  autoAdopt?: boolean
  /**
   * Requirement directory for auto-adopt file writes. Required when
   * `autoAdopt` is true.
   */
  reqDir?: string
}

export class JobConflictError extends Error {
  constructor(public existingJobId: string) {
    super(`A job for this session is already running: ${existingJobId}`)
    this.name = "JobConflictError"
  }
}

/**
 * Start an extract job. Returns the seeded job record (state=running)
 * synchronously; the underlying `runExtractSummary` runs in the
 * background and mutates the same record on completion.
 *
 * Throws `JobConflictError` if another job for the same `sessionId` is
 * already running. Callers translate this into a user-visible 409.
 */
export function createExtractJob(opts: CreateExtractJobOptions): ExtractJob {
  const now = opts.nowFn ? opts.nowFn() : Date.now()
  evictStale(now)
  const conflict = findRunningJobForSession(opts.sessionId)
  if (conflict) throw new JobConflictError(conflict.id)

  const promptAnchor =
    opts.promptAnchor ?? opts.prompt.slice(0, 30)
  const model = opts.model && opts.model.trim() ? opts.model.trim() : EXTRACT_MODEL

  const job: ExtractJob = {
    id: newJobId(),
    reqId: opts.reqId,
    sessionId: opts.sessionId,
    state: "running",
    mode: opts.mode ?? "summary",
    model,
    startedAt: now,
    doneAt: null,
    stdout: "",
    stderr: "",
    exitCode: null,
    timedOut: false,
    errorMessage: null,
    forkSessionId: null,
    forkTitle: null,
    salvagedFromFork: false,
    autoResult: null,
    autoAdopt: opts.autoAdopt ?? false,
    reqDir: opts.reqDir ?? null,
    _promptAnchor: promptAnchor,
    _salvageFn: opts.salvageFn ?? salvageFromFork,
    _notificationId: null,
  }
  _jobs.set(job.id, job)

  // Add a "running" notification card for this job. Subsequent state
  // transitions (done/failed/salvaged) are pushed via updateNotification.
  // For autoAdopt jobs (scheduler), the notification has no actionHref
  // because the user doesn't need to visit a preview page.
  const notifId = createNotification({
    type: "extract",
    title: opts.autoAdopt ? "⏰ 定时智能提取进行中…" : "正在生成会话摘要…",
    subtitle: `session ${opts.sessionId}`,
    state: "running",
    jobId: job.id,
    reqId: opts.reqId,
    sessionId: opts.sessionId,
    actionHref: opts.autoAdopt ? null : `/requirement/extract?jobId=${encodeURIComponent(job.id)}`,
  })
  job._notificationId = notifId

  const runner = opts.runFn ?? runExtractSummary
  // Fire and forget; the promise updates the job in-place on resolve.
  runner({ sessionId: opts.sessionId, prompt: opts.prompt, model })
    .then((result) => { void finalizeJob(job.id, result) })
    .catch((err: unknown) => {
      void finalizeJob(job.id, {
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: null,
        durationMs: Date.now() - job.startedAt,
        timedOut: false,
      })
    })

  return { ...job }
}

async function persistJobHistory(job: ExtractJob): Promise<void> {
  const record = buildExtractHistoryRecord(job)
  if (!record) return
  await appendExtractHistory(record)
}

/**
 * Auto-adopt: write the parsed file updates/appends directly to `reqDir`,
 * skipping the manual preview/commit flow.
 *
 * Returns a human-readable description of what was written (or why it
 * was skipped). Never throws — errors are captured in the description.
 */
async function applyAutoAdopt(j: ExtractJob): Promise<string> {
  if (!j.reqDir) return "无法自动采纳：缺少需求目录"
  if (!j.autoResult) {
    const parsed = parseAutoExtractOutput(j.stdout)
    j.autoResult = filterAllowed(parsed)
  }
  const { updates, appends, summary } = j.autoResult
  if (updates.length === 0 && appends.length === 0) {
    return summary || "无需更新"
  }
  const written: string[] = []
  for (const u of updates) {
    try {
      const filePath = join(j.reqDir, u.filename)
      if (!filePath.startsWith(j.reqDir + "/")) continue
      await writeFile(filePath, u.content, "utf-8")
      written.push(`更新 ${u.filename}`)
    } catch {
      written.push(`更新 ${u.filename} 失败`)
    }
  }
  for (const a of appends) {
    try {
      const filePath = join(j.reqDir, a.filename)
      if (!filePath.startsWith(j.reqDir + "/")) continue
      await appendFile(filePath, "\n\n" + a.content + "\n", "utf-8")
      written.push(`追加 ${a.filename}`)
    } catch {
      written.push(`追加 ${a.filename} 失败`)
    }
  }
  const desc = written.length > 0 ? written.join("、") : "无变更"
  return summary ? `${desc}｜${summary}` : desc
}

/**
 * Finalize a job once `runExtractSummary` resolves.
 *
 * The "happy path" (exit 0, non-empty stdout, no timeout) is trivial.
 * Anything else triggers a salvage attempt: we ask `salvageFromFork`
 * whether opencode wrote a fork session that contains the assistant
 * reply for our prompt. If it did, we promote the job to `state=done`
 * with the salvaged text — the user gets their summary even though
 * our spawn was killed. The fork id and title are recorded on the job
 * so the preview page can link there.
 *
 * Async because salvage spawns `sqlite3`. We `void` the returned
 * promise at the call site because nothing awaits it; the dashboard's
 * polling endpoint will see the updated job once finalize resolves.
 */
async function finalizeJob(jobId: string, result: ExtractResult): Promise<void> {
  const j = _jobs.get(jobId)
  if (!j) return
  // Guard against double-finalization: the zombie reaper in evictStale
  // may have already force-failed this job while the runner promise
  // was still pending.
  if (j.state !== "running") return
  j.stdout = result.stdout
  j.stderr = result.stderr
  j.exitCode = result.exitCode
  j.timedOut = result.timedOut
  j.doneAt = Date.now()

  // Happy path: opencode handed us the body directly.
  if (!result.timedOut && result.exitCode === 0 && result.stdout.length > 0) {
    j.state = "done"
    j.errorMessage = null
    // For "auto" mode, parse the structured output into per-file diffs.
    if (j.mode === "auto") {
      const parsed = parseAutoExtractOutput(result.stdout)
      j.autoResult = filterAllowed(parsed)
    }
    if (j._notificationId) {
      const dur = ((j.doneAt - j.startedAt) / 1000).toFixed(1)
      if (j.autoAdopt && j.mode === "auto") {
        // Auto-adopt: write files directly and notify what was adopted.
        const adoptDesc = await applyAutoAdopt(j)
        const hasChanges = j.autoResult != null &&
          (j.autoResult.updates.length > 0 || j.autoResult.appends.length > 0)
        // Update session title with the extraction summary so the user
        // can see at a glance what this session is about and that it
        // has been extracted.
        const summary = j.autoResult?.summary?.trim()
        if (summary) {
          void updateSessionTitle(j.sessionId, summary)
        }
        updateNotification(j._notificationId, {
          title: hasChanges
            ? `✓ 定时提取已自动采纳（${dur}s）`
            : `✓ 定时提取完成，无需更新（${dur}s）`,
          subtitle: `session ${j.sessionId} · ${adoptDesc}`,
          state: "done",
        })
      } else {
        const title = j.mode === "auto"
          ? `✓ 上下文分析完成（${dur}s）`
          : `✓ 摘要生成完成（${dur}s）`
        const subtitle = j.mode === "auto"
          ? `session ${j.sessionId} · 进入预览页查看文件变更建议`
          : `session ${j.sessionId} · 进入预览页确认后写入 notes.md`
        updateNotification(j._notificationId, {
          title,
          subtitle,
          state: "done",
          actionHref: j.mode === "auto"
            ? `/requirement/auto-extract?jobId=${encodeURIComponent(j.id)}`
            : `/requirement/extract?jobId=${encodeURIComponent(j.id)}`,
        })
      }
    }
    await persistJobHistory(j)
    return
  }

  // Attempt to salvage from the fork session opencode may have written
  // before our spawn was killed. The salvage is opportunistic; on any
  // error we fall through to the regular failure path.
  let salvage: SalvageResult | null = null
  if (j._salvageFn) {
    try {
      salvage = await j._salvageFn({
        sourceSessionId: j.sessionId,
        startedAt: j.startedAt,
        promptAnchor: j._promptAnchor,
      })
    } catch {
      // Treat any salvage error as "no salvage" — never throw out of
      // the background runner.
      salvage = null
    }
  }

  if (salvage && salvage.text.length > 0) {
    j.stdout = salvage.text
    j.forkSessionId = salvage.forkSessionId
    j.forkTitle = salvage.forkTitle
    j.salvagedFromFork = true
    j.state = "done"
    j.errorMessage = null
    // For auto mode, parse the salvaged text into structured diffs.
    if (j.mode === "auto") {
      const parsed = parseAutoExtractOutput(salvage.text)
      j.autoResult = filterAllowed(parsed)
    }
    if (j._notificationId) {
      const dur = ((j.doneAt - j.startedAt) / 1000).toFixed(1)
      if (j.autoAdopt && j.mode === "auto") {
        const adoptDesc = await applyAutoAdopt(j)
        const hasChanges = j.autoResult != null &&
          (j.autoResult.updates.length > 0 || j.autoResult.appends.length > 0)
        const summary = j.autoResult?.summary?.trim()
        if (summary) {
          void updateSessionTitle(j.sessionId, summary)
        }
        updateNotification(j._notificationId, {
          title: hasChanges
            ? `✓ 定时提取已自动采纳（fork 救回，${dur}s）`
            : `✓ 定时提取完成，无需更新（fork 救回，${dur}s）`,
          subtitle: `session ${j.sessionId} · ${adoptDesc}`,
          state: "done",
        })
      } else {
        updateNotification(j._notificationId, {
          title: `✓ 已从 fork 救回摘要（${dur}s）`,
          subtitle: `session ${j.sessionId} · 进程超时但 LLM 已写完`,
          state: "done",
        })
      }
    }
    await persistJobHistory(j)
    return
  }

  j.state = "failed"
  if (result.timedOut) {
    j.errorMessage = describeTimeout(result)
  } else if (result.exitCode !== 0) {
    j.errorMessage = `opencode 退出码 ${result.exitCode ?? "null"}`
  } else {
    j.errorMessage = "opencode 没有输出"
  }
  if (j._notificationId) {
    updateNotification(j._notificationId, {
      title: "✗ 生成失败",
      subtitle: j.errorMessage || "未知错误",
      state: "failed",
    })
  }
  await persistJobHistory(j)
}

/**
 * Build a precise timeout description.
 *
 * We hit SIGKILL when wall-clock exceeds `DEFAULT_EXTRACT_TIMEOUT_MS`,
 * but "timeout" can mean very different things:
 *
 *   - **CLI start stall**: stdout is empty and stderr has < 1 line.
 *     opencode never got to load the session or invoke the model.
 *     Likely a wrong --model, missing provider key, or session id
 *     drift between SQLite and the running daemon.
 *   - **Model truly took too long**: stdout already started streaming
 *     markdown (we usually see "## 目标" within the first 3-10s once
 *     generation begins). The model is too slow on this much input.
 *   - **CLI post-processing stuck**: stdout has a complete-looking
 *     summary AND stderr shows a tokens/cost summary line, but the
 *     process didn't exit before the timeout. This is the one that
 *     burned us on minimax-latest-auto with 86k input tokens — the
 *     LLM finished but opencode kept the pipe open. The fix is to
 *     either raise the timeout further or salvage the partial stdout
 *     in the preview page (we already keep stdout in the job record).
 *
 * In all three cases we still hand the captured stdout/stderr to the
 * preview page; this string only adjusts the headline so the user
 * doesn't have to guess "did the model fail or did I just kill a
 * working process".
 */
function describeTimeout(result: ExtractResult): string {
  const seconds = Math.round(result.durationMs / 1000)
  const limit = Math.round(DEFAULT_EXTRACT_TIMEOUT_MS / 1000)
  const stdoutHasMarkdown = /(^|\n)#{1,3}\s/.test(result.stdout)
  const stderrMentionsFinish =
    /tokens?\b|cost\b|usage\b|finish/i.test(result.stderr) ||
    /\b(stop|completed|done)\b/i.test(result.stderr)

  if (result.stdout.length === 0 && result.stderr.length < 200) {
    return `opencode 在 ${seconds}s 内没有任何输出就被强制中断（上限 ${limit}s）。可能是模型加载、provider 鉴权或 session 找不到。`
  }
  if (stdoutHasMarkdown && stderrMentionsFinish) {
    return `LLM 已生成完毕（捕获到 ${result.stdout.length} 字节摘要），但 opencode 子进程 ${seconds}s 仍未退出，被强制中断（上限 ${limit}s）。摘要文本仍可在预览页中合并到 notes.md。`
  }
  if (stdoutHasMarkdown) {
    return `LLM 正在生成中（已捕获 ${result.stdout.length} 字节），但 ${seconds}s 仍未完成，被强制中断（上限 ${limit}s）。可在预览页中合并已有的部分文本，或重试。`
  }
  return `opencode 在 ${seconds}s 内未完成，被强制中断（上限 ${limit}s）。`
}

/** Test-only. Drops all in-memory jobs. */
export function _resetExtractJobs(): void {
  _jobs.clear()
}
