/**
 * Tests for `src/autoExtractScheduler.ts`.
 *
 * Covers:
 *   - shouldTriggerInitial: 1h minimum age, already done, unknown createdAt
 *   - msUntilMidnight: delay calculation correctness
 *   - syncSchedule: add new bindings, remove unbound, update reqId
 */

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  shouldTriggerInitial,
  syncSchedule,
  msUntilMidnight,
  MIN_SESSION_AGE_MS,
  TWENTY_FOUR_HOURS_MS,
  _resetForTest,
} from "../src/autoExtractScheduler.ts"
import type { ScheduleEntry } from "../src/autoExtractScheduler.ts"
import type { Requirement } from "../src/requirements.ts"
import type { SessionInfo } from "../src/sessions.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpJsonPath(): string {
  return join(mkdtempSync(join(tmpdir(), "opencode-sched-")), "schedule.json")
}

function makeEntry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    sessionId: "ses_aaaaaaaaaaaaaaaa",
    reqId: "WMS-001",
    sessionCreatedAt: Date.now() - MIN_SESSION_AGE_MS - 1000,
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
    created: Date.now() - MIN_SESSION_AGE_MS - 1000,
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

test("shouldTriggerInitial: true when session is older than 1h and not done", () => {
  const entry = makeEntry({ sessionCreatedAt: Date.now() - MIN_SESSION_AGE_MS - 1 })
  assert.ok(shouldTriggerInitial(entry))
})

test("shouldTriggerInitial: false when session is younger than 1h", () => {
  const entry = makeEntry({ sessionCreatedAt: Date.now() - 60_000 })
  assert.ok(!shouldTriggerInitial(entry))
})

test("shouldTriggerInitial: false when already done", () => {
  const entry = makeEntry({ initialExtractDone: true })
  assert.ok(!shouldTriggerInitial(entry))
})

test("shouldTriggerInitial: true when createdAt is 0 (unknown age)", () => {
  const entry = makeEntry({ sessionCreatedAt: 0 })
  assert.ok(shouldTriggerInitial(entry))
})

test("shouldTriggerInitial: true when session created long ago (retroactive binding)", () => {
  const entry = makeEntry({ sessionCreatedAt: Date.now() - 7 * 24 * 60 * 60 * 1000 })
  assert.ok(shouldTriggerInitial(entry))
})

test("shouldTriggerInitial: true at exact 1h boundary", () => {
  const entry = makeEntry({ sessionCreatedAt: Date.now() - MIN_SESSION_AGE_MS })
  assert.ok(shouldTriggerInitial(entry))
})

// ---------------------------------------------------------------------------
// msUntilMidnight
// ---------------------------------------------------------------------------

test("msUntilMidnight: returns positive value", () => {
  const delay = msUntilMidnight()
  assert.ok(delay > 0, "delay should be positive")
  assert.ok(delay <= 24 * 60 * 60 * 1000, "delay should not exceed 24h")
})

test("msUntilMidnight: at 23:59, delay is about 1 minute", () => {
  // Construct a date at 23:59:00 local time today.
  const now = new Date()
  const nearMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23, 59, 0, 0,
  ).getTime()
  const delay = msUntilMidnight(nearMidnight)
  // Should be about 60 seconds (allow small tolerance for test execution).
  assert.ok(delay > 50_000 && delay < 70_000, `expected ~60s, got ${delay}ms`)
})

test("msUntilMidnight: at 00:00:01, delay is about 24h minus 1s", () => {
  const now = new Date()
  const justAfterMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0, 0, 1, 0,
  ).getTime()
  const delay = msUntilMidnight(justAfterMidnight)
  const expected = 24 * 60 * 60 * 1000 - 1000
  assert.ok(
    Math.abs(delay - expected) < 1000,
    `expected ~${expected}ms, got ${delay}ms`,
  )
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
