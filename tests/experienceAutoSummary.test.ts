/**
 * Tests for `src/experienceAutoSummary.ts`.
 *
 * Covers:
 *   - buildSummaryPrompt: produces a prompt with the session id
 *   - buildExecutionPrompt: produces a prompt with report path + IDs
 *   - computeIdleMs: returns ms since session.updated
 *   - triggerSummaryForMarker: happy path (stdout → report → summarized)
 *   - triggerSummaryForMarker: failure path (timeout → failed)
 *   - triggerSummaryForMarker: salvage path (timeout + salvage → summarized)
 *   - triggerExecutionForMarker: happy path (exit 0 → executed)
 *   - triggerExecutionForMarker: failure path (non-zero → failed)
 */

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildSummaryPrompt,
  buildExecutionPrompt,
  computeIdleMs,
  isSessionRecentForDailyWindow,
  msUntilNextLocalHour,
  triggerSummaryForMarker,
  triggerExecutionForMarker,
  IDLE_THRESHOLD_MS,
} from "../src/experienceAutoSummary.ts"
import {
  markSession,
  updateMarker,
  getMarker,
  _resetForTest as _resetMarkers,
} from "../src/experienceMarkers.ts"
import { _resetForTest as _resetNotifications } from "../src/notifications.ts"
import type { ExtractResult } from "../src/sessionExtract.ts"
import type { SalvageResult } from "../src/forkSalvage.ts"
import type { SessionInfo } from "../src/sessions.ts"

function newTmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "opencode-auto-summary-")), "markers.json")
}

function newNotifPath(): string {
  return join(mkdtempSync(join(tmpdir(), "opencode-auto-summary-notif-")), "notifications.json")
}

function resetStores(): void {
  _resetMarkers(newTmpPath())
  _resetNotifications(newNotifPath())
}

const VALID_SID = "ses_aaaaaaaaaaaaaaaa"

function fakeRunner(result: ExtractResult, delayMs = 5): (opts: { sessionId: string; prompt: string }) => Promise<ExtractResult> {
  return () =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(result), delayMs)
      if (typeof t.unref === "function") t.unref()
    })
}

const noSalvage = async (): Promise<SalvageResult | null> => null

function fakeSalvageHit(result: SalvageResult): () => Promise<SalvageResult | null> {
  return async () => result
}

async function waitFor(fn: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ---------------------------------------------------------------------------

test("buildSummaryPrompt: includes session id and report format header", () => {
  const prompt = buildSummaryPrompt(VALID_SID)
  assert.match(prompt, /ses_aaaaaaaaaaaaaaaa/)
  assert.match(prompt, /Experience Summary Report/)
  assert.match(prompt, /候选清单/)
})

test("buildExecutionPrompt: includes report path and confirmed IDs", () => {
  const prompt = buildExecutionPrompt("/tmp/opencode/handoff/auto-summary/ses_x/report.md", ["C1", "C3"])
  assert.match(prompt, /\/tmp\/opencode\/handoff\/auto-summary\/ses_x\/report\.md/)
  assert.match(prompt, /C1/)
  assert.match(prompt, /C3/)
})

test("computeIdleMs: returns ms since session.updated", () => {
  const now = Date.now()
  const session: SessionInfo = {
    id: VALID_SID,
    title: "test",
    created: now - 7200_000,
    updated: now - 3600_000, // 1 hour ago
    projectId: "test",
    directory: "",
    status: "idle",
    source: "db",
  }
  const idle = computeIdleMs(session, now)
  assert.ok(Math.abs(idle - 3600_000) < 100, `expected ~3600000, got ${idle}`)
})

test("computeIdleMs: returns Infinity for null session", () => {
  assert.equal(computeIdleMs(null), Infinity)
})

test("computeIdleMs: returns Infinity for session with no timestamps", () => {
  const session: SessionInfo = {
    id: VALID_SID,
    title: "test",
    created: 0,
    updated: 0,
    projectId: "test",
    directory: "",
    status: "stale",
    source: "fs",
  }
  assert.equal(computeIdleMs(session), Infinity)
})

test("IDLE_THRESHOLD_MS is 1 hour", () => {
  assert.equal(IDLE_THRESHOLD_MS, 60 * 60 * 1000)
})

test("isSessionRecentForDailyWindow: true when updated within 24h", () => {
  const now = Date.now()
  const session: SessionInfo = {
    id: VALID_SID,
    title: "test",
    created: now - 7 * 24 * 60 * 60 * 1000,
    updated: now - 60_000,
    projectId: "test",
    directory: "",
    status: "idle",
    source: "db",
  }
  assert.equal(isSessionRecentForDailyWindow(session, now), true)
})

test("isSessionRecentForDailyWindow: false when not touched in 24h", () => {
  const now = Date.now()
  const session: SessionInfo = {
    id: VALID_SID,
    title: "test",
    created: now - 2 * 24 * 60 * 60 * 1000,
    updated: now - 24 * 60 * 60 * 1000 - 1,
    projectId: "test",
    directory: "",
    status: "stale",
    source: "db",
  }
  assert.equal(isSessionRecentForDailyWindow(session, now), false)
})

test("msUntilNextLocalHour: computes the next 01:00 run", () => {
  const before = new Date(2026, 6, 1, 0, 30, 0, 0)
  assert.equal(msUntilNextLocalHour(1, before), 30 * 60 * 1000)
  const after = new Date(2026, 6, 1, 1, 1, 0, 0)
  assert.equal(msUntilNextLocalHour(1, after), (23 * 60 + 59) * 60 * 1000)
})

// ---------------------------------------------------------------------------

test("triggerSummaryForMarker: happy path transitions to summarized", async () => {
  resetStores()
  const marker = await markSession(VALID_SID)
  await triggerSummaryForMarker(marker, {
    runFn: fakeRunner({
      stdout: "# Experience Summary Report\n\n## 元信息\n- Session: ses_aaaa",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
    }),
    salvageFn: noSalvage,
  })
  const final = getMarker(VALID_SID)
  assert.equal(final?.status, "summarized")
  assert.ok(final?.reportPath)
  assert.ok(final?.reportPath?.includes(VALID_SID))
  assert.ok(final?.reportPath?.endsWith("report.md"))
  assert.ok(final?.summaryCompletedAt)
})

test("triggerSummaryForMarker: timeout transitions to failed", async () => {
  resetStores()
  const marker = await markSession(VALID_SID)
  await triggerSummaryForMarker(marker, {
    runFn: fakeRunner({
      stdout: "",
      stderr: "",
      exitCode: null,
      durationMs: 1,
      timedOut: true,
    }),
    salvageFn: noSalvage,
  })
  const final = getMarker(VALID_SID)
  assert.equal(final?.status, "failed")
  assert.match(final!.errorMessage!, /timed out/)
})

test("triggerSummaryForMarker: salvage from fork transitions to summarized", async () => {
  resetStores()
  const marker = await markSession(VALID_SID)
  await triggerSummaryForMarker(marker, {
    runFn: fakeRunner({
      stdout: "",
      stderr: "",
      exitCode: null,
      durationMs: 1,
      timedOut: true,
    }),
    salvageFn: fakeSalvageHit({
      forkSessionId: "ses_forkfromsalvage1",
      forkTitle: "X (fork #1)",
      forkDurationMs: 18_000,
      text: "## 目标\n救回来的摘要正文。",
    }),
  })
  const final = getMarker(VALID_SID)
  assert.equal(final?.status, "summarized")
  assert.equal(final?.summaryForkSessionId, "ses_forkfromsalvage1")
  assert.ok(final?.reportPath)
})

test("triggerSummaryForMarker: spawn error transitions to failed", async () => {
  resetStores()
  const marker = await markSession(VALID_SID)
  await triggerSummaryForMarker(marker, {
    runFn: async () => { throw new Error("ENOENT") },
    salvageFn: noSalvage,
  })
  const final = getMarker(VALID_SID)
  assert.equal(final?.status, "failed")
  assert.match(final!.errorMessage!, /ENOENT/)
})

// ---------------------------------------------------------------------------

test("triggerExecutionForMarker: happy path transitions to executed", async () => {
  resetStores()
  await markSession(VALID_SID)
  // Simulate that summary already completed.
  await updateMarker(VALID_SID, {
    status: "summarized",
    reportPath: "/tmp/opencode/handoff/auto-summary/ses_aaaa/report.md",
  })
  await triggerExecutionForMarker(VALID_SID, ["C1", "C3"], {
    runFn: fakeRunner({
      stdout: "Result: EXECUTED",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
    }),
  })
  const final = getMarker(VALID_SID)
  assert.equal(final?.status, "executed")
  assert.deepEqual(final?.confirmedCandidateIds, ["C1", "C3"])
  assert.ok(final?.executionCompletedAt)
})

test("triggerExecutionForMarker: non-zero exit transitions to failed", async () => {
  resetStores()
  await markSession(VALID_SID)
  await updateMarker(VALID_SID, {
    status: "summarized",
    reportPath: "/tmp/opencode/handoff/auto-summary/ses_aaaa/report.md",
  })
  await triggerExecutionForMarker(VALID_SID, ["C1"], {
    runFn: fakeRunner({
      stdout: "",
      stderr: "error",
      exitCode: 1,
      durationMs: 1,
      timedOut: false,
    }),
  })
  const final = getMarker(VALID_SID)
  assert.equal(final?.status, "failed")
  assert.match(final!.errorMessage!, /code 1/)
})

test("triggerExecutionForMarker: throws if marker has no reportPath", async () => {
  resetStores()
  await markSession(VALID_SID)
  // Marker is in `marked` status with no reportPath.
  await assert.rejects(
    () => triggerExecutionForMarker(VALID_SID, ["C1"]),
    /No report path/,
  )
})

test("triggerExecutionForMarker: throws if no confirmed IDs", async () => {
  resetStores()
  await markSession(VALID_SID)
  await updateMarker(VALID_SID, {
    status: "summarized",
    reportPath: "/tmp/opencode/handoff/auto-summary/ses_aaaa/report.md",
  })
  await assert.rejects(
    () => triggerExecutionForMarker(VALID_SID, []),
    /No confirmed/,
  )
})
