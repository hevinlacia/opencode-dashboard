/**
 * Persistent store for manually-marked experience-summary sessions.
 *
 * Role: track sessions the user explicitly flagged for experience
 * summarization. The dashboard's background worker polls this store,
 * waits for the session to go idle for ≥1 hour, then forks the session
 * to generate an experience report. After the user reviews and confirms
 * candidates from the report, the worker spawns a second fork to execute
 * the confirmed items.
 *
 * Public surface:
 *   - initMarkers(): load from disk at startup
 *   - markSession(sessionId, opts?): create a marker
 *   - unmarkSession(sessionId): remove a marker
 *   - getMarker(sessionId): read one marker
 *   - listMarkers(filter?): list markers, optionally filtered by status
 *   - updateMarker(sessionId, partial): mutate a marker in-place
 *   - findProcessableMarkers(now): return markers that are within the
 *     7-day window, still in `marked` status, and whose session has been
 *     idle for ≥1 hour (idle check is done by the caller via sessions.ts)
 *   - _resetForTest(path): test-only path override
 *
 * Constraints / safety:
 *   - Only `node:` built-ins.
 *   - Never reads or writes `.env` / secret files.
 *   - Session ids are validated against `^ses_[A-Za-z0-9]+$` before any
 *     write.
 *   - 7-day TTL: markers older than 7 days are evicted on load unless
 *     they are in an active state (summarizing, confirming).
 *
 * Read-this-with:
 *   - `src/experienceAutoSummary.ts` (the background worker that polls
 *     this store and drives the fork/summarize/execute lifecycle).
 *   - `src/sessions.ts` (SessionInfo for idle-time computation).
 *   - `src/server.tsx` (the API routes that expose mark/unmark/list).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MarkerStatus =
  | "marked"          // user flagged; waiting for idle condition
  | "summarizing"     // fork summary job in progress
  | "summarized"      // report ready; waiting for user review
  | "confirming"      // user confirmed; execution fork in progress
  | "executed"        // execution completed
  | "failed"          // something went wrong
  | "expired"         // 7-day window passed without completion

export interface ExperienceMarker {
  sessionId: string
  status: MarkerStatus
  /** ISO timestamp when the user marked the session. */
  markedAt: string
  /** ISO timestamp of the last status transition. */
  updatedAt: string
  /** Optional note the user attached when marking. */
  note: string | null
  /** Path to the generated report.md (set when status reaches `summarized`). */
  reportPath: string | null
  /** Fork session id from the summary spawn (for tracing). */
  summaryForkSessionId: string | null
  /** Fork session id from the execution spawn. */
  executionForkSessionId: string | null
  /** Confirmed candidate IDs from the report (set by user via UI). */
  confirmedCandidateIds: string[]
  /** Error message when status === "failed". */
  errorMessage: string | null
  /** ISO timestamp when the summary job started. */
  summaryStartedAt: string | null
  /** ISO timestamp when the summary job completed. */
  summaryCompletedAt: string | null
  /** ISO timestamp when the execution job started. */
  executionStartedAt: string | null
  /** ISO timestamp when the execution job completed. */
  executionCompletedAt: string | null
}

interface PersistedStore {
  version: 1
  markers: Record<string, ExperienceMarker>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 7 days in ms. Markers older than this are evicted unless active. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000

const DEFAULT_STORE_PATH = join(
  homedir(),
  ".local",
  "share",
  "opencode-dashboard",
  "experience-markers.json",
)

const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/

/** Marker statuses that are considered "active" and exempt from TTL. */
const ACTIVE_STATUSES: ReadonlySet<MarkerStatus> = new Set([
  "summarizing",
  "confirming",
])

let _storePath: string = DEFAULT_STORE_PATH
let _markers = new Map<string, ExperienceMarker>()

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function ensureDir(): Promise<void> {
  const dir = dirname(_storePath)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

async function loadFromDisk(): Promise<void> {
  _markers.clear()
  if (!existsSync(_storePath)) return
  try {
    const raw = await readFile(_storePath, "utf-8")
    const store: PersistedStore = JSON.parse(raw)
    const now = Date.now()
    for (const m of Object.values(store.markers || {})) {
      if (!isValidMarker(m)) continue
      // TTL: drop markers older than 7 days unless they're active.
      const age = now - Date.parse(m.markedAt)
      if (age > TTL_MS && !ACTIVE_STATUSES.has(m.status)) {
        continue
      }
      _markers.set(m.sessionId, m)
    }
  } catch {
    _markers.clear()
  }
}

async function saveToDisk(): Promise<void> {
  await ensureDir()
  const markers: Record<string, ExperienceMarker> = {}
  for (const [sid, m] of _markers) {
    markers[sid] = m
  }
  const store: PersistedStore = { version: 1, markers }
  await writeFile(_storePath, JSON.stringify(store, null, 2), "utf-8")
}

function isValidMarker(m: unknown): m is ExperienceMarker {
  if (!m || typeof m !== "object") return false
  const o = m as Record<string, unknown>
  return (
    typeof o.sessionId === "string" &&
    SESSION_ID_RE.test(o.sessionId) &&
    typeof o.status === "string" &&
    typeof o.markedAt === "string" &&
    typeof o.updatedAt === "string"
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Initialize (load from disk). Call once at server startup. */
export async function initMarkers(): Promise<void> {
  await loadFromDisk()
}

/**
 * Mark a session for experience summarization.
 * If a marker already exists and is not in a terminal state, it is
 * updated (note replaced, status reset to `marked` only if it was
 * `expired` or `failed`).
 */
export async function markSession(
  sessionId: string,
  opts?: { note?: string },
): Promise<ExperienceMarker> {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`)
  }
  const now = new Date().toISOString()
  const existing = _markers.get(sessionId)
  const isReset = existing && (existing.status === "expired" || existing.status === "failed")
  const marker: ExperienceMarker = existing
    ? {
        ...existing,
        note: opts?.note ?? existing.note,
        // Reset to `marked` if the marker was expired or failed; keep
        // other statuses (summarizing, summarized, etc.) intact so we
        // don't lose progress.
        status: isReset ? "marked" : existing.status,
        // Clear error fields when resetting.
        errorMessage: isReset ? null : existing.errorMessage,
        updatedAt: now,
      }
    : {
        sessionId,
        status: "marked",
        markedAt: now,
        updatedAt: now,
        note: opts?.note ?? null,
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
  _markers.set(sessionId, marker)
  await saveToDisk()
  return { ...marker }
}

/** Remove a marker entirely. */
export async function unmarkSession(sessionId: string): Promise<boolean> {
  if (!SESSION_ID_RE.test(sessionId)) return false
  const existed = _markers.delete(sessionId)
  if (existed) await saveToDisk()
  return existed
}

/** Read one marker. */
export function getMarker(sessionId: string): ExperienceMarker | null {
  return _markers.get(sessionId) ?? null
}

/** List markers, optionally filtered by status. */
export function listMarkers(status?: MarkerStatus): ExperienceMarker[] {
  const all = Array.from(_markers.values())
  const filtered = status ? all.filter((m) => m.status === status) : all
  // Newest-first by markedAt.
  return filtered.sort((a, b) => b.markedAt.localeCompare(a.markedAt))
}

/**
 * Mutate a marker in-place and persist.
 * Returns the updated marker or null if not found.
 */
export async function updateMarker(
  sessionId: string,
  partial: Partial<Omit<ExperienceMarker, "sessionId" | "markedAt">>,
): Promise<ExperienceMarker | null> {
  const m = _markers.get(sessionId)
  if (!m) return null
  const updated: ExperienceMarker = {
    ...m,
    ...partial,
    sessionId: m.sessionId,
    markedAt: m.markedAt,
    updatedAt: new Date().toISOString(),
  }
  _markers.set(sessionId, updated)
  await saveToDisk()
  return { ...updated }
}

/**
 * Return markers that are eligible for processing by the background
 * worker: status === "marked", within the 7-day window, and not already
 * being processed.
 *
 * The caller is responsible for checking the session's idle time
 * (via `sessions.ts`) before starting a summary job.
 */
export function findProcessableMarkers(): ExperienceMarker[] {
  const now = Date.now()
  const out: ExperienceMarker[] = []
  for (const m of _markers.values()) {
    if (m.status !== "marked") continue
    const age = now - Date.parse(m.markedAt)
    if (age > TTL_MS) {
      // Mark as expired; will be cleaned up on next save.
      m.status = "expired"
      continue
    }
    out.push(m)
  }
  // Persist any expirations we just set.
  if (out.length < _markers.size) {
    saveToDisk().catch(() => {})
  }
  return out
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Override the persistent store path. Also clears the in-memory map. */
export function _resetForTest(path: string): void {
  _storePath = path
  _markers.clear()
}
