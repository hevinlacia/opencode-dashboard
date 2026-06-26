/**
 * Tests for `src/extractJobs.ts`.
 *
 * Covers:
 *   - createExtractJob: seeds a record with state=running and an id
 *   - finalize path: state=done with stdout / state=failed for non-zero
 *     exit / state=failed for timeout / state=failed for empty stdout
 *   - per-session mutex: second start for same sid throws JobConflictError
 *   - findRunningJobForSession: returns running jobs, ignores finished
 *   - getExtractJob: returns null after the job is evicted (we simulate
 *     by mutating doneAt directly through a second job + a fast TTL
 *     check is left out — the production TTL is 30min, not worth
 *     wall-clock testing).
 */

import { test } from "node:test"
import { strict as assert } from "node:assert"

import {
  createExtractJob,
  findRunningJobForSession,
  findRecentJobForSession,
  getExtractJob,
  checkExtractGuard,
  EXTRACT_DEBOUNCE_MS,
  JobConflictError,
  JOB_MAX_RUNNING_MS,
  _resetExtractJobs,
} from "../src/extractJobs.ts"
import type { ExtractResult } from "../src/sessionExtract.ts"
import type { SalvageResult } from "../src/forkSalvage.ts"
import { _resetForTest as _resetNotifications, getNotifications } from "../src/notifications.ts"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Redirect notification writes to a temp file so test artifact
// notifications don't leak into the production store at
// ~/.local/share/opencode-dashboard/notifications.json.
const _notifTmpPath = join(mkdtempSync(join(tmpdir(), "opencode-extract-job-test-")), "notifications.json")
_resetNotifications(_notifTmpPath)
_resetExtractJobs()

function fakeRunner(result: ExtractResult, delayMs = 5): (opts: { sessionId: string; prompt: string }) => Promise<ExtractResult> {
  return () =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(result), delayMs)
      // Allow process exit even if a long-delay test forgot to wait.
      if (typeof t.unref === "function") t.unref()
    })
}

/**
 * Default salvage stub for tests that do not exercise the salvage
 * path. Resolves with `null` immediately so the job moves into its
 * regular failure / success state without touching SQLite.
 */
const noSalvage = async (): Promise<SalvageResult | null> => null

/**
 * Salvage stub that simulates a successful recovery: opencode's spawn
 * timed out, but the fork session in the DB has a finished assistant
 * reply.
 */
function fakeSalvageHit(result: SalvageResult): () => Promise<SalvageResult | null> {
  return async () => result
}

async function waitFor(fn: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

test("createExtractJob: seeds a running job with id and timestamps", () => {
  _resetExtractJobs()
  const job = createExtractJob({
    reqId: "req-1",
    sessionId: "ses_aaaaaaaaaaaaaaaa",
    prompt: "p",
    runFn: fakeRunner({ stdout: "## 目标\nok", stderr: "", exitCode: 0, durationMs: 1, timedOut: false }),
    salvageFn: noSalvage,
  })
  assert.equal(job.state, "running")
  assert.match(job.id, /^[a-f0-9]{12}$/)
  assert.equal(job.reqId, "req-1")
  assert.equal(job.sessionId, "ses_aaaaaaaaaaaaaaaa")
  assert.equal(job.stdout, "")
  assert.equal(job.doneAt, null)
})

test("createExtractJob: finalizes to state=done on successful run", async () => {
  _resetExtractJobs()
  const job = createExtractJob({
    reqId: "req-2",
    sessionId: "ses_bbbbbbbbbbbbbbbb",
    prompt: "p",
    runFn: fakeRunner({ stdout: "summary body", stderr: "", exitCode: 0, durationMs: 1, timedOut: false }),
    salvageFn: noSalvage,
  })
  await waitFor(() => (getExtractJob(job.id)?.state ?? "running") !== "running")
  const final = getExtractJob(job.id)
  assert.equal(final?.state, "done")
  assert.equal(final?.stdout, "summary body")
  assert.equal(final?.errorMessage, null)
  assert.ok((final?.doneAt ?? 0) >= final!.startedAt)
})

test("createExtractJob: finalizes to state=failed on non-zero exit code", async () => {
  _resetExtractJobs()
  const job = createExtractJob({
    reqId: "req-3",
    sessionId: "ses_cccccccccccccccc",
    prompt: "p",
    runFn: fakeRunner({ stdout: "", stderr: "boom", exitCode: 2, durationMs: 1, timedOut: false }),
    salvageFn: noSalvage,
  })
  await waitFor(() => (getExtractJob(job.id)?.state ?? "running") !== "running")
  const final = getExtractJob(job.id)
  assert.equal(final?.state, "failed")
  assert.match(final!.errorMessage!, /退出码 2/)
})

test("createExtractJob: finalizes to state=failed on timeout", async () => {
  _resetExtractJobs()
  const job = createExtractJob({
    reqId: "req-4",
    sessionId: "ses_dddddddddddddddd",
    prompt: "p",
    runFn: fakeRunner({ stdout: "", stderr: "", exitCode: null, durationMs: 1, timedOut: true }),
    salvageFn: noSalvage,
  })
  await waitFor(() => (getExtractJob(job.id)?.state ?? "running") !== "running")
  const final = getExtractJob(job.id)
  assert.equal(final?.state, "failed")
  // The timeout descriptor falls into the "no output, short stderr"
  // bucket here because the fake runner returned empty buffers.
  assert.match(final!.errorMessage!, /没有任何输出/)
  assert.match(final!.errorMessage!, /被强制中断/)
  assert.equal(final?.timedOut, true)
})

test("createExtractJob: finalizes to state=failed on empty stdout", async () => {
  _resetExtractJobs()
  const job = createExtractJob({
    reqId: "req-5",
    sessionId: "ses_eeeeeeeeeeeeeeee",
    prompt: "p",
    runFn: fakeRunner({ stdout: "", stderr: "", exitCode: 0, durationMs: 1, timedOut: false }),
    salvageFn: noSalvage,
  })
  await waitFor(() => (getExtractJob(job.id)?.state ?? "running") !== "running")
  const final = getExtractJob(job.id)
  assert.equal(final?.state, "failed")
  assert.match(final!.errorMessage!, /没有输出/)
})

test("timeout description: LLM-finished-but-process-stuck case mentions captured bytes and survival", async () => {
  _resetExtractJobs()
  // Simulates the real failure we saw: stdout already has a full
  // markdown summary, stderr shows token usage / a finish reason,
  // yet the spawn was killed by our timeout. The message should
  // tell the user the bytes are usable.
  const job = createExtractJob({
    reqId: "req-timeout-finished",
    sessionId: "ses_timeoutfinished0",
    prompt: "p",
    runFn: fakeRunner({
      stdout: "## 目标\n做完了\n\n## 关键决策\n- a",
      stderr: "tokens: input=86460 output=764, finish=stop",
      exitCode: null,
      durationMs: 90_000,
      timedOut: true,
    }),
    salvageFn: noSalvage,
  })
  await waitFor(() => (getExtractJob(job.id)?.state ?? "running") !== "running")
  const final = getExtractJob(job.id)
  assert.equal(final?.state, "failed")
  assert.match(final!.errorMessage!, /LLM 已生成完毕/)
  assert.match(final!.errorMessage!, /opencode 子进程/)
  // The byte count should appear so the user knows the partial body is real.
  assert.match(final!.errorMessage!, /\d+ 字节/)
})

test("timeout description: cold-start no-output case names the likely causes", async () => {
  _resetExtractJobs()
  const job = createExtractJob({
    reqId: "req-timeout-coldstart",
    sessionId: "ses_timeoutcoldstart0",
    prompt: "p",
    runFn: fakeRunner({
      stdout: "",
      stderr: "",
      exitCode: null,
      durationMs: 300_000,
      timedOut: true,
    }),
    salvageFn: noSalvage,
  })
  await waitFor(() => (getExtractJob(job.id)?.state ?? "running") !== "running")
  const final = getExtractJob(job.id)
  assert.equal(final?.state, "failed")
  assert.match(final!.errorMessage!, /没有任何输出/)
  assert.match(final!.errorMessage!, /provider 鉴权|session 找不到|模型加载/)
})

test("timeout description: mid-stream case mentions partial bytes and 'can merge'", async () => {
  _resetExtractJobs()
  const job = createExtractJob({
    reqId: "req-timeout-midstream",
    sessionId: "ses_timeoutmidstream0",
    prompt: "p",
    runFn: fakeRunner({
      stdout: "## 目标\n写到一半就被砍",
      stderr: "",
      exitCode: null,
      durationMs: 300_000,
      timedOut: true,
    }),
    salvageFn: noSalvage,
  })
  await waitFor(() => (getExtractJob(job.id)?.state ?? "running") !== "running")
  const final = getExtractJob(job.id)
  assert.equal(final?.state, "failed")
  assert.match(final!.errorMessage!, /LLM 正在生成中/)
  assert.match(final!.errorMessage!, /合并|重试/)
})

test("createExtractJob: refuses concurrent start for same sessionId", () => {
  _resetExtractJobs()
  createExtractJob({
    reqId: "req-6",
    sessionId: "ses_ffffffffffffffff",
    prompt: "p",
    // 5 minutes — long enough to stay running through this test.
    runFn: fakeRunner({ stdout: "x", stderr: "", exitCode: 0, durationMs: 1, timedOut: false }, 5 * 60_000),
    salvageFn: noSalvage,
  })
  assert.throws(
    () =>
      createExtractJob({
        reqId: "req-6",
        sessionId: "ses_ffffffffffffffff",
        prompt: "p",
        runFn: fakeRunner({ stdout: "y", stderr: "", exitCode: 0, durationMs: 1, timedOut: false }),
        salvageFn: noSalvage,
      }),
    (err: unknown) => err instanceof JobConflictError,
  )
})

test("createExtractJob: allows new start for the same sessionId after the previous job finishes", async () => {
  _resetExtractJobs()
  const first = createExtractJob({
    reqId: "req-7",
    sessionId: "ses_gggggggggggggggg",
    prompt: "p1",
    runFn: fakeRunner({ stdout: "ok1", stderr: "", exitCode: 0, durationMs: 1, timedOut: false }),
    salvageFn: noSalvage,
  })
  await waitFor(() => getExtractJob(first.id)?.state === "done")

  const second = createExtractJob({
    reqId: "req-7",
    sessionId: "ses_gggggggggggggggg",
    prompt: "p2",
    runFn: fakeRunner({ stdout: "ok2", stderr: "", exitCode: 0, durationMs: 1, timedOut: false }),
    salvageFn: noSalvage,
  })
  assert.notEqual(second.id, first.id)
  assert.equal(second.state, "running")
})

test("findRunningJobForSession: returns the running job; null after it finishes", async () => {
  _resetExtractJobs()
  const job = createExtractJob({
    reqId: "req-8",
    sessionId: "ses_hhhhhhhhhhhhhhhh",
    prompt: "p",
    runFn: fakeRunner({ stdout: "ok", stderr: "", exitCode: 0, durationMs: 1, timedOut: false }, 30),
    salvageFn: noSalvage,
  })
  // While running:
  const inflight = findRunningJobForSession("ses_hhhhhhhhhhhhhhhh")
  assert.ok(inflight)
  assert.equal(inflight!.id, job.id)
  // After done:
  await waitFor(() => getExtractJob(job.id)?.state === "done")
  assert.equal(findRunningJobForSession("ses_hhhhhhhhhhhhhhhh"), null)
})

test("getExtractJob: returns null for unknown ids", () => {
  _resetExtractJobs()
  assert.equal(getExtractJob("does-not-exist"), null)
})

test("salvage: timeout job is promoted to done when fork session has assistant reply", async () => {
  _resetExtractJobs()
  const job = createExtractJob({
    reqId: "req-salvage-1",
    sessionId: "ses_salvage1111111",
    prompt: "请用中文总结本次会话",
    runFn: fakeRunner({
      stdout: "",
      stderr: "",
      exitCode: null,
      durationMs: 300_000,
      timedOut: true,
    }),
    salvageFn: fakeSalvageHit({
      forkSessionId: "ses_forkfromsalvage1",
      forkTitle: "X (fork #1)",
      forkDurationMs: 18_000,
      text: "## 目标\n救回来的摘要正文。\n\n## 关键决策\n- a",
    }),
  })
  await waitFor(() => (getExtractJob(job.id)?.state ?? "running") !== "running")
  const final = getExtractJob(job.id)
  assert.equal(final?.state, "done")
  assert.equal(final?.salvagedFromFork, true)
  assert.equal(final?.forkSessionId, "ses_forkfromsalvage1")
  assert.equal(final?.forkTitle, "X (fork #1)")
  assert.match(final!.stdout, /## 目标/)
  assert.equal(final?.errorMessage, null)
})

test("salvage: timeout job stays failed when fork has no assistant reply", async () => {
  _resetExtractJobs()
  const job = createExtractJob({
    reqId: "req-salvage-2",
    sessionId: "ses_salvage2222222",
    prompt: "请用中文总结本次会话",
    runFn: fakeRunner({
      stdout: "",
      stderr: "",
      exitCode: null,
      durationMs: 300_000,
      timedOut: true,
    }),
    // No fork found (e.g. opencode died before creating one):
    salvageFn: noSalvage,
  })
  await waitFor(() => (getExtractJob(job.id)?.state ?? "running") !== "running")
  const final = getExtractJob(job.id)
  assert.equal(final?.state, "failed")
  assert.equal(final?.salvagedFromFork, false)
  assert.equal(final?.forkSessionId, null)
  assert.match(final!.errorMessage!, /被强制中断/)
})

test("salvage: success path is unaffected by salvageFn", async () => {
  _resetExtractJobs()
  let salvageCalls = 0
  const job = createExtractJob({
    reqId: "req-salvage-3",
    sessionId: "ses_salvage3333333",
    prompt: "请用中文总结本次会话",
    runFn: fakeRunner({
      stdout: "## 目标\n直接成功",
      stderr: "",
      exitCode: 0,
      durationMs: 1000,
      timedOut: false,
    }),
    salvageFn: async () => { salvageCalls++; return null },
  })
  await waitFor(() => (getExtractJob(job.id)?.state ?? "running") !== "running")
  const final = getExtractJob(job.id)
  assert.equal(final?.state, "done")
  assert.equal(final?.salvagedFromFork, false)
  assert.equal(final?.forkSessionId, null)
  assert.equal(salvageCalls, 0, "salvage should NOT be called on the happy path")
})

// ---------------------------------------------------------------------------
// Auto-adopt tests
// ---------------------------------------------------------------------------

function fakeAutoOutput(opts: {
  updates?: { filename: string; content: string }[]
  appends?: { filename: string; content: string }[]
  summary?: string
}): string {
  const parts: string[] = []
  for (const u of opts.updates ?? []) {
    parts.push(`===UPDATE: ${u.filename}===`, u.content, "")
  }
  for (const a of opts.appends ?? []) {
    parts.push(`===APPEND: ${a.filename}===`, a.content, "")
  }
  parts.push("===SUMMARY===", opts.summary ?? "test summary")
  return parts.join("\n")
}

test("autoAdopt: writes file updates to reqDir on successful auto-extract", async () => {
  _resetExtractJobs()
  const reqDir = mkdtempSync(join(tmpdir(), "auto-adopt-"))
  writeFileSync(join(reqDir, "branch.md"), "old content")

  const job = createExtractJob({
    reqId: "req-auto-1",
    sessionId: "ses_autoadopt111111",
    prompt: "p",
    mode: "auto",
    autoAdopt: true,
    reqDir,
    runFn: fakeRunner({
      stdout: fakeAutoOutput({
        updates: [{ filename: "branch.md", content: "new content" }],
        appends: [{ filename: "notes.md", content: "## 新摘要\nbody" }],
        summary: "更新了 branch.md，追加了 notes.md",
      }),
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
    }),
    salvageFn: noSalvage,
  })
  await waitFor(() => (getExtractJob(job.id)?.state ?? "running") !== "running")
  const final = getExtractJob(job.id)
  assert.equal(final?.state, "done")
  assert.equal(final?.autoAdopt, true)
  assert.equal(readFileSync(join(reqDir, "branch.md"), "utf-8"), "new content")
  assert.ok(readFileSync(join(reqDir, "notes.md"), "utf-8").includes("新摘要"))
  const notifs = getNotifications()
  const notif = notifs.find((n) => n.jobId === job.id)
  assert.ok(notif)
  assert.match(notif!.title, /定时提取已自动采纳/)
  assert.match(notif!.subtitle, /更新 branch\.md/)
})

test("autoAdopt: notification says 'no changes' when output has no updates", async () => {
  _resetExtractJobs()
  const reqDir = mkdtempSync(join(tmpdir(), "auto-adopt-noop-"))

  const job = createExtractJob({
    reqId: "req-auto-2",
    sessionId: "ses_autoadopt222222",
    prompt: "p",
    mode: "auto",
    autoAdopt: true,
    reqDir,
    runFn: fakeRunner({
      stdout: fakeAutoOutput({ summary: "无需更新" }),
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
    }),
    salvageFn: noSalvage,
  })
  await waitFor(() => (getExtractJob(job.id)?.state ?? "running") !== "running")
  const final = getExtractJob(job.id)
  assert.equal(final?.state, "done")
  const notifs = getNotifications()
  const notif = notifs.find((n) => n.jobId === job.id)
  assert.ok(notif)
  assert.match(notif!.title, /无需更新/)
})

test("autoAdopt: salvage path also auto-adopts", async () => {
  _resetExtractJobs()
  const reqDir = mkdtempSync(join(tmpdir(), "auto-adopt-salvage-"))

  const job = createExtractJob({
    reqId: "req-auto-3",
    sessionId: "ses_autoadopt333333",
    prompt: "请用中文总结本次会话",
    mode: "auto",
    autoAdopt: true,
    reqDir,
    runFn: fakeRunner({
      stdout: "",
      stderr: "",
      exitCode: null,
      durationMs: 300_000,
      timedOut: true,
    }),
    salvageFn: fakeSalvageHit({
      forkSessionId: "ses_forkauto1",
      forkTitle: "X (fork #1)",
      forkDurationMs: 18_000,
      text: fakeAutoOutput({
        appends: [{ filename: "notes.md", content: "## 从 fork 救回的摘要" }],
        summary: "从 fork 救回",
      }),
    }),
  })
  await waitFor(() => (getExtractJob(job.id)?.state ?? "running") !== "running")
  const final = getExtractJob(job.id)
  assert.equal(final?.state, "done")
  assert.equal(final?.salvagedFromFork, true)
  assert.ok(readFileSync(join(reqDir, "notes.md"), "utf-8").includes("从 fork 救回的摘要"))
  const notifs = getNotifications()
  const notif = notifs.find((n) => n.jobId === job.id)
  assert.ok(notif)
  assert.match(notif!.title, /定时提取已自动采纳.*fork 救回/)
})

test("autoAdopt: notification has no actionHref (no preview page needed)", async () => {
  _resetExtractJobs()
  const reqDir = mkdtempSync(join(tmpdir(), "auto-adopt-nohref-"))

  const job = createExtractJob({
    reqId: "req-auto-4",
    sessionId: "ses_autoadopt444444",
    prompt: "p",
    mode: "auto",
    autoAdopt: true,
    reqDir,
    runFn: fakeRunner({
      stdout: fakeAutoOutput({ summary: "nothing" }),
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
    }),
    salvageFn: noSalvage,
  })
  await waitFor(() => (getExtractJob(job.id)?.state ?? "running") !== "running")
  const notifs = getNotifications()
  const notif = notifs.find((n) => n.jobId === job.id)
  assert.ok(notif)
  assert.equal(notif!.actionHref, null)
})

// ---------------------------------------------------------------------------
// Zombie reaper tests
// ---------------------------------------------------------------------------

test("zombie reaper: force-fails jobs that exceed JOB_MAX_RUNNING_MS", () => {
  _resetExtractJobs()
  const job = createExtractJob({
    reqId: "req-zombie-1",
    sessionId: "ses_zombie111111111",
    prompt: "p",
    runFn: fakeRunner(
      { stdout: "late", stderr: "", exitCode: 0, durationMs: 1, timedOut: false },
      10 * 60_000,
    ),
    salvageFn: noSalvage,
    nowFn: () => Date.now() - JOB_MAX_RUNNING_MS - 60_000,
  })
  assert.equal(job.state, "running")
  const final = getExtractJob(job.id)
  assert.equal(final?.state, "failed")
  assert.match(final!.errorMessage!, /zombie job reaper/)
  const notifs = getNotifications()
  const notif = notifs.find((n) => n.jobId === job.id)
  assert.ok(notif)
  assert.match(notif!.title, /超时未响应/)
  assert.equal(notif!.state, "failed")
})

test("zombie reaper: does not affect jobs still within timeout", () => {
  _resetExtractJobs()
  createExtractJob({
    reqId: "req-zombie-2",
    sessionId: "ses_zombie222222222",
    prompt: "p",
    runFn: fakeRunner(
      { stdout: "ok", stderr: "", exitCode: 0, durationMs: 1, timedOut: false },
      5_000,
    ),
    salvageFn: noSalvage,
  })
  const final = getExtractJob(getExtractJob("ses_zombie222222222")?.id ?? "")
  // The job should still be running (not reaped).
  // Note: getExtractJob by sessionId doesn't work, we need to find it differently.
  // Actually we can use findRunningJobForSession.
  const running = findRunningJobForSession("ses_zombie222222222")
  assert.ok(running)
  assert.equal(running!.state, "running")
})

// ---------------------------------------------------------------------------
// Extract guard tests (debounce + no-new-content)
// ---------------------------------------------------------------------------

test("findRecentJobForSession: returns most recent job within window", async () => {
  _resetExtractJobs()
  const job = createExtractJob({
    reqId: "req-recent-1",
    sessionId: "ses_recentjob111111",
    prompt: "p",
    runFn: fakeRunner({ stdout: "ok", stderr: "", exitCode: 0, durationMs: 1, timedOut: false }),
    salvageFn: noSalvage,
  })
  await waitFor(() => getExtractJob(job.id)?.state === "done")
  const found = findRecentJobForSession("ses_recentjob111111", EXTRACT_DEBOUNCE_MS)
  assert.ok(found)
  assert.equal(found!.id, job.id)
})

test("findRecentJobForSession: returns null outside window", async () => {
  _resetExtractJobs()
  const job = createExtractJob({
    reqId: "req-recent-2",
    sessionId: "ses_recentjob222222",
    prompt: "p",
    runFn: fakeRunner({ stdout: "ok", stderr: "", exitCode: 0, durationMs: 1, timedOut: false }),
    salvageFn: noSalvage,
    nowFn: () => Date.now() - EXTRACT_DEBOUNCE_MS - 60_000,
  })
  await waitFor(() => getExtractJob(job.id)?.state === "done")
  const found = findRecentJobForSession("ses_recentjob222222", EXTRACT_DEBOUNCE_MS)
  assert.equal(found, null)
})

test("checkExtractGuard: allows first-time extract (no history)", () => {
  const result = checkExtractGuard({
    recentJob: null,
    lastExtract: null,
    sessionUpdated: 0,
    now: 1_000_000,
  })
  assert.equal(result.ok, true)
})

test("checkExtractGuard: rejects when recent job is within debounce window", () => {
  const now = 1_000_000
  const recentJob = { startedAt: now - 30_000 } as any
  const result = checkExtractGuard({
    recentJob,
    lastExtract: null,
    sessionUpdated: 0,
    now,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, "debounce")
  assert.match(result.message, /30秒前刚触发过提取/)
})

test("checkExtractGuard: allows when recent job is outside debounce window", () => {
  const now = 1_000_000
  const recentJob = { startedAt: now - EXTRACT_DEBOUNCE_MS - 1000 } as any
  const result = checkExtractGuard({
    recentJob,
    lastExtract: null,
    sessionUpdated: 0,
    now,
  })
  assert.equal(result.ok, true)
})

test("checkExtractGuard: rejects no-new-content when session not updated since last extract", () => {
  const lastExtractDoneAt = 1_000_000
  const result = checkExtractGuard({
    recentJob: null,
    lastExtract: { doneAt: lastExtractDoneAt, mode: "auto" },
    sessionUpdated: lastExtractDoneAt,
    now: lastExtractDoneAt + 600_000,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, "no-new-content")
  assert.match(result.message, /无新对话/)
})

test("checkExtractGuard: allows when session has new content since last extract", () => {
  const lastExtractDoneAt = 1_000_000
  const result = checkExtractGuard({
    recentJob: null,
    lastExtract: { doneAt: lastExtractDoneAt, mode: "summary" },
    sessionUpdated: lastExtractDoneAt + 60_000,
    now: lastExtractDoneAt + 600_000,
  })
  assert.equal(result.ok, true)
})

test("checkExtractGuard: debounce takes priority over no-new-content", () => {
  const now = 1_000_000
  const recentJob = { startedAt: now - 10_000 } as any
  const result = checkExtractGuard({
    recentJob,
    lastExtract: { doneAt: now - 20_000, mode: "auto" },
    sessionUpdated: now - 20_000,
    now,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, "debounce")
})
