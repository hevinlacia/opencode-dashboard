/**
 * Tests for `src/experienceMarkers.ts`.
 *
 * Covers:
 *   - markSession: creates a marker with status=marked
 *   - markSession: re-marking an expired/failed marker resets to marked
 *   - unmarkSession: removes a marker
 *   - getMarker / listMarkers: read operations
 *   - updateMarker: partial mutation + persistence
 *   - findProcessableMarkers: returns only `marked` status markers
 *   - TTL: markers older than 7 days are evicted on load (unless active)
 */

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  initMarkers,
  markSession,
  unmarkSession,
  getMarker,
  listMarkers,
  updateMarker,
  findProcessableMarkers,
  _resetForTest,
} from "../src/experienceMarkers.ts"

import type { ExperienceMarker } from "../src/experienceMarkers.ts"

function newTmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "opencode-markers-")), "markers.json")
}

const VALID_SID = "ses_aaaaaaaaaaaaaaaa"

test("markSession: creates a marker with status=marked", async () => {
  _resetForTest(newTmpPath())
  const m = await markSession(VALID_SID)
  assert.equal(m.sessionId, VALID_SID)
  assert.equal(m.status, "marked")
  assert.equal(m.note, null)
  assert.ok(m.markedAt)
  assert.ok(m.updatedAt)
})

test("markSession: accepts a note", async () => {
  _resetForTest(newTmpPath())
  const m = await markSession(VALID_SID, { note: "MQ idempotency fix" })
  assert.equal(m.note, "MQ idempotency fix")
})

test("markSession: rejects invalid session id", async () => {
  _resetForTest(newTmpPath())
  await assert.rejects(() => markSession("invalid-id"))
  await assert.rejects(() => markSession("ses_"))
  await assert.rejects(() => markSession(""))
})

test("markSession: re-marking a failed marker resets to marked", async () => {
  _resetForTest(newTmpPath())
  await markSession(VALID_SID)
  await updateMarker(VALID_SID, { status: "failed", errorMessage: "boom" })
  const reMarked = await markSession(VALID_SID)
  assert.equal(reMarked.status, "marked")
  assert.equal(reMarked.errorMessage, null)
})

test("markSession: re-marking a summarized marker keeps status", async () => {
  _resetForTest(newTmpPath())
  await markSession(VALID_SID)
  await updateMarker(VALID_SID, { status: "summarized", reportPath: "/tmp/report.md" })
  const reMarked = await markSession(VALID_SID)
  assert.equal(reMarked.status, "summarized")
  assert.equal(reMarked.reportPath, "/tmp/report.md")
})

test("unmarkSession: removes a marker", async () => {
  _resetForTest(newTmpPath())
  await markSession(VALID_SID)
  assert.ok(getMarker(VALID_SID))
  const removed = await unmarkSession(VALID_SID)
  assert.equal(removed, true)
  assert.equal(getMarker(VALID_SID), null)
  // Second unmark returns false.
  const removed2 = await unmarkSession(VALID_SID)
  assert.equal(removed2, false)
})

test("getMarker: returns null for unknown session", () => {
  _resetForTest(newTmpPath())
  assert.equal(getMarker("ses_unknown00000000"), null)
})

test("listMarkers: returns all markers newest-first", async () => {
  _resetForTest(newTmpPath())
  await markSession("ses_aaaaaaaaaaaaaaaa")
  await new Promise((r) => setTimeout(r, 5))
  await markSession("ses_bbbbbbbbbbbbbbbb")
  await new Promise((r) => setTimeout(r, 5))
  await markSession("ses_cccccccccccccccc")
  const all = listMarkers()
  assert.equal(all.length, 3)
  assert.equal(all[0].sessionId, "ses_cccccccccccccccc")
  assert.equal(all[1].sessionId, "ses_bbbbbbbbbbbbbbbb")
  assert.equal(all[2].sessionId, "ses_aaaaaaaaaaaaaaaa")
})

test("listMarkers: filters by status", async () => {
  _resetForTest(newTmpPath())
  await markSession("ses_aaaaaaaaaaaaaaaa")
  await markSession("ses_bbbbbbbbbbbbbbbb")
  await updateMarker("ses_bbbbbbbbbbbbbbbb", { status: "summarized" })
  const marked = listMarkers("marked")
  assert.equal(marked.length, 1)
  assert.equal(marked[0].sessionId, "ses_aaaaaaaaaaaaaaaa")
  const summarized = listMarkers("summarized")
  assert.equal(summarized.length, 1)
  assert.equal(summarized[0].sessionId, "ses_bbbbbbbbbbbbbbbb")
})

test("updateMarker: partial mutation persists", async () => {
  _resetForTest(newTmpPath())
  await markSession(VALID_SID)
  const updated = await updateMarker(VALID_SID, {
    status: "summarizing",
    summaryStartedAt: "2026-01-01T00:00:00Z",
  })
  assert.equal(updated?.status, "summarizing")
  assert.equal(updated?.summaryStartedAt, "2026-01-01T00:00:00Z")
  // Re-read to confirm persistence.
  const reread = getMarker(VALID_SID)
  assert.equal(reread?.status, "summarizing")
})

test("updateMarker: returns null for unknown session", async () => {
  _resetForTest(newTmpPath())
  const result = await updateMarker("ses_unknown00000000", { status: "failed" })
  assert.equal(result, null)
})

test("findProcessableMarkers: returns only marked markers", async () => {
  _resetForTest(newTmpPath())
  await markSession("ses_aaaaaaaaaaaaaaaa")
  await markSession("ses_bbbbbbbbbbbbbbbb")
  await updateMarker("ses_bbbbbbbbbbbbbbbb", { status: "summarizing" })
  const processable = findProcessableMarkers()
  assert.equal(processable.length, 1)
  assert.equal(processable[0].sessionId, "ses_aaaaaaaaaaaaaaaa")
})

test("persistence: markers survive reload", async () => {
  const p = newTmpPath()
  _resetForTest(p)
  await markSession(VALID_SID, { note: "test" })
  assert.ok(existsSync(p))
  // Reset memory and reload from disk.
  _resetForTest(p)
  assert.equal(getMarker(VALID_SID), null)
  await initMarkers()
  const m = getMarker(VALID_SID)
  assert.ok(m)
  assert.equal(m?.note, "test")
})

test("TTL: markers older than 7 days are evicted on load (but active ones survive)", async () => {
  const p = newTmpPath()
  _resetForTest(p)
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
  const staleMarker: ExperienceMarker = {
    sessionId: "ses_stale0000000000000",
    status: "marked",
    markedAt: eightDaysAgo,
    updatedAt: eightDaysAgo,
    note: null,
    reportPath: null,
    summaryForkSessionId: null,
    executionForkSessionId: null,
    confirmedCandidateIds: [],
    errorMessage: null,
    summaryStartedAt: null,
    summaryCompletedAt: null,
    executionStartedAt: null,
    executionCompletedAt: null,
  }
  const activeMarker: ExperienceMarker = {
    ...staleMarker,
    sessionId: "ses_active00000000000",
    status: "summarizing",
  }
  const freshMarker: ExperienceMarker = {
    ...staleMarker,
    sessionId: "ses_fresh000000000000",
    markedAt: new Date().toISOString(),
  }
  const store = {
    version: 1,
    markers: {
      [staleMarker.sessionId]: staleMarker,
      [activeMarker.sessionId]: activeMarker,
      [freshMarker.sessionId]: freshMarker,
    },
  }
  writeFileSync(p, JSON.stringify(store))
  _resetForTest(p)
  await initMarkers()
  const all = listMarkers()
  const ids = all.map((m) => m.sessionId).sort()
  // Stale `marked` marker is dropped; active `summarizing` survives; fresh survives.
  assert.deepEqual(ids, ["ses_active00000000000", "ses_fresh000000000000"])
})
