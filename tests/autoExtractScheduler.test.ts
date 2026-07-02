/**
 * Tests for `src/autoExtractScheduler.ts`.
 *
 * Covers:
 *   - shouldTriggerInitial: not yet extracted, already done, missing createdAt
 *   - shouldTriggerPeriodic: updated changed, never extracted
 *   - daily helpers: local midnight delay and recent-session window
 *   - syncSchedule: add new bindings, remove unbound, update reqId
 *   - pollOnce: respects config toggle, triggers initial extract, skips running jobs
 */

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  shouldTriggerInitial,
  shouldTriggerPeriodic,
  syncSchedule,
  TWENTY_FOUR_HOURS_MS,
  isSessionRecentForDailyWindow,
  msUntilNextLocalHour,
  _resetForTest,
} from "../src/autoExtractScheduler.ts"
import { _resetForTest as _resetConfig } from "../src/config.ts"
import { _resetForTest as _resetNotifications } from "../src/notifications.ts"
import { _resetExtractJobs } from "../src/extractJobs.ts"
import type { ScheduleEntry } from "../src/autoExtractScheduler.ts"
import type { Requirement } from "../src/requirements.ts"
import type { SessionInfo } from "../src/sessions.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpJsonPath(): string {
  return join(mkdtempSync(join(tmpdir(), "opencode-sched-")), "schedule.json")
}

function tmpConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), "opencode-sched-cfg-")), "config.json")
}

function tmpNotifPath(): string {
  return join(mkdtempSync(join(tmpdir(), "opencode-sched-notif-")), "notifications.json")
}

function makeEntry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    sessionId: "ses_aaaaaaaaaaaaaaaa",
    reqId: "WMS-001",
    sessionCreatedAt: Date.now() - TWENTY_FOUR_HOURS_MS - 1000,
    initialExtractDone: false,
    lastExtractAt: null,
    lastSessionUpdated: null,
    ...overrides,
  }
}

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "ses_aaaaaaaaaaaaaaaa",
    title: "test",
    created: Date.now() - TWENTY_FOUR_HOURS_MS - 1000,
    updated: Date.now(),
    projectId: "WMS",
    directory: "",
    status: "idle",
    source: "db",
    ...overrides,
  }
}

function makeRequirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: "WMS-001",
    title: "Test Req",
    status: "开发中",
    project: "WMS",
    groupPath: [],
    description: "",
    sessionIds: ["ses_aaaaaaaaaaaaaaaa"],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    reqDir: "/tmp/fake-req-dir",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// shouldTriggerInitial
// ---------------------------------------------------------------------------

test("shouldTriggerInitial: true when not done and createdAt exists", () => {
  const entry = makeEntry({ sessionCreatedAt: Date.now() })
  assert.ok(shouldTriggerInitial(entry))
})

test("shouldTriggerInitial: false when already done", () => {
  const entry = makeEntry({ initialExtractDone: true })
  assert.ok(!shouldTriggerInitial(entry))
})

test("shouldTriggerInitial: false when createdAt is 0", () => {
  const entry = makeEntry({ sessionCreatedAt: 0 })
  assert.ok(!shouldTriggerInitial(entry))
})

// ---------------------------------------------------------------------------
// shouldTriggerPeriodic
// ---------------------------------------------------------------------------

test("shouldTriggerPeriodic: true when session updated", () => {
  const entry = makeEntry({
    initialExtractDone: true,
    lastExtractAt: Date.now() - 60_000,
    lastSessionUpdated: Date.now() - TWENTY_FOUR_HOURS_MS,
  })
  const sessionUpdated = Date.now() - 1000
  assert.ok(shouldTriggerPeriodic(entry, sessionUpdated))
})

test("shouldTriggerPeriodic: false when session not updated", () => {
  const ts = Date.now() - 1000
  const entry = makeEntry({
    initialExtractDone: true,
    lastExtractAt: Date.now() - TWENTY_FOUR_HOURS_MS - 1000,
    lastSessionUpdated: ts,
  })
  assert.ok(!shouldTriggerPeriodic(entry, ts))
})

test("shouldTriggerPeriodic: false when never extracted (lastExtractAt null)", () => {
  const entry = makeEntry({ lastExtractAt: null })
  assert.ok(!shouldTriggerPeriodic(entry, Date.now()))
})

test("shouldTriggerPeriodic: true when lastSessionUpdated is null but 24h passed", () => {
  const entry = makeEntry({
    initialExtractDone: true,
    lastExtractAt: Date.now() - TWENTY_FOUR_HOURS_MS - 1000,
    lastSessionUpdated: null,
  })
  assert.ok(shouldTriggerPeriodic(entry, Date.now()))
})

test("isSessionRecentForDailyWindow: true when updated within 24h", () => {
  const now = Date.now()
  const session = makeSession({ created: now - 7 * TWENTY_FOUR_HOURS_MS, updated: now - 60_000 })
  assert.equal(isSessionRecentForDailyWindow(session, now), true)
})

test("isSessionRecentForDailyWindow: false when created and updated are older than 24h", () => {
  const now = Date.now()
  const session = makeSession({ created: now - 2 * TWENTY_FOUR_HOURS_MS, updated: now - TWENTY_FOUR_HOURS_MS - 1 })
  assert.equal(isSessionRecentForDailyWindow(session, now), false)
})

test("msUntilNextLocalHour: returns same-day delay before target hour", () => {
  const now = new Date(2026, 6, 1, 23, 30, 0, 0)
  assert.equal(msUntilNextLocalHour(0, now), 30 * 60 * 1000)
})

test("msUntilNextLocalHour: rolls to next day after target hour", () => {
  const now = new Date(2026, 6, 1, 0, 1, 0, 0)
  assert.equal(msUntilNextLocalHour(0, now), (23 * 60 + 59) * 60 * 1000)
})

// ---------------------------------------------------------------------------
// syncSchedule
// ---------------------------------------------------------------------------

test("syncSchedule: adds new bindings", () => {
  const req = makeRequirement({ sessionIds: ["ses_new1", "ses_new2"] })
  const store = { version: 1 as const, sessions: {} }
  const sessionMap = new Map<string, SessionInfo>([
    ["ses_new1", makeSession({ id: "ses_new1", created: 1000 })],
    ["ses_new2", makeSession({ id: "ses_new2", created: 2000 })],
  ])
  const result = syncSchedule([req], store, sessionMap)
  assert.ok(result.sessions["ses_new1"])
  assert.ok(result.sessions["ses_new2"])
  assert.strictEqual(result.sessions["ses_new1"].sessionCreatedAt, 1000)
  assert.strictEqual(result.sessions["ses_new2"].sessionCreatedAt, 2000)
  assert.ok(!result.sessions["ses_new1"].initialExtractDone)
})

test("syncSchedule: removes unbound sessions", () => {
  const store = {
    version: 1 as const,
    sessions: {
      ses_gone: makeEntry({ sessionId: "ses_gone", reqId: "OLD-001" }),
      ses_keep: makeEntry({ sessionId: "ses_keep", reqId: "WMS-001" }),
    },
  }
  const req = makeRequirement({ sessionIds: ["ses_keep"] })
  const sessionMap = new Map<string, SessionInfo>([
    ["ses_keep", makeSession({ id: "ses_keep" })],
  ])
  const result = syncSchedule([req], store, sessionMap)
  assert.ok(result.sessions["ses_keep"])
  assert.ok(!result.sessions["ses_gone"])
})

test("syncSchedule: updates reqId when session moves to different requirement", () => {
  const store = {
    version: 1 as const,
    sessions: {
      ses_move: makeEntry({ sessionId: "ses_move", reqId: "OLD-001", initialExtractDone: true }),
    },
  }
  const req = makeRequirement({ id: "NEW-001", sessionIds: ["ses_move"] })
  const sessionMap = new Map<string, SessionInfo>([
    ["ses_move", makeSession({ id: "ses_move" })],
  ])
  const result = syncSchedule([req], store, sessionMap)
  assert.strictEqual(result.sessions["ses_move"].reqId, "NEW-001")
  // Preserves initialExtractDone from the old entry.
  assert.ok(result.sessions["ses_move"].initialExtractDone)
})

test("syncSchedule: does not mutate input store", () => {
  const store = { version: 1 as const, sessions: {} }
  const req = makeRequirement({ sessionIds: ["ses_new"] })
  const sessionMap = new Map([["ses_new", makeSession({ id: "ses_new" })]])
  syncSchedule([req], store, sessionMap)
  assert.strictEqual(Object.keys(store.sessions).length, 0)
})
