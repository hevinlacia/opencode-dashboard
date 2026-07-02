/**
 * Background scheduler for automated smart context extraction.
 *
 * Role: run one daily poll at local midnight for requirement-bound
 * sessions that were created or updated in the last 24 hours, then
 * trigger smart extract jobs based on two conditions:
 *   1. **Initial extract** — if the session has never been extracted.
 *   2. **Periodic re-extract** — if the session's `updated` timestamp
 *      has advanced since the last auto-extract.
 *
 * The scheduler reuses the existing `createExtractJob` infrastructure
 * from `extractJobs.ts`, so spawned jobs go through the same notification,
 * salvage, and history pipeline as manual clicks.
 *
 * State is persisted to
 * `~/.local/share/opencode-dashboard/auto-extract-schedule.json` so the
 * scheduler survives dashboard restarts without re-triggering extracts
 * that already ran.
 *
 * Public surface:
 *   - startAutoExtractScheduler(): schedule the next local midnight poll
 *   - stopAutoExtractScheduler(): stop the scheduled poll (for tests)
 *   - pollOnce(): run one poll cycle (exported for testing)
 *   - shouldTriggerInitial(entry): pure predicate
 *   - shouldTriggerPeriodic(entry, sessionUpdated): pure predicate
 *   - isSessionRecentForDailyWindow(session, now): 24h recency filter
 *   - msUntilNextLocalHour(hour, now): daily schedule helper
 *   - syncSchedule(requirements, store): pure reconciliation
 *   - _resetForTest(path): test-only path override
 *
 * Constraints / safety:
 *   - Only `node:` built-ins + project modules.
 *   - Never reads or writes `.env` / secret files.
 *   - Session ids are validated before any job creation.
 *   - Skips sessions that already have a running extract job.
 *
 * Read-this-with:
 *   - `src/extractJobs.ts` (createExtractJob — the job spawn mechanism).
 *   - `src/autoExtract.ts` (buildAutoExtractPrompt — the prompt builder).
 *   - `src/requirements.ts` (listRequirementsByProject, associations).
 *   - `src/sessions.ts` (scanSessions — SessionInfo with timestamps).
 *   - `src/experienceAutoSummary.ts` (the analogous background worker
 *     pattern for experience summaries).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { listRequirementsByProject, type Requirement } from "./requirements.ts"
import { scanSessions, type SessionInfo } from "./sessions.ts"
import { getConfig } from "./config.ts"
import {
  createExtractJob,
  findRunningJobForSession,
  type JobMode,
} from "./extractJobs.ts"
import { buildAutoExtractPrompt, type ContextFiles } from "./autoExtract.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 24 hours in milliseconds. */
export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

/** Scheduler fires once per day at local 00:00. */
export const DAILY_EXTRACT_HOUR = 0

/** Recency window checked at each daily poll. */
export const RECENT_SESSION_WINDOW_MS = TWENTY_FOUR_HOURS_MS

/** Back-compat export for the schedulers page: next poll is daily. */
export const POLL_INTERVAL_MS = TWENTY_FOUR_HOURS_MS

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduleEntry {
  sessionId: string
  reqId: string
  /** When the session was created (ms epoch). Captured at bind time. */
  sessionCreatedAt: number
  /** Whether the initial 24h-after-creation extract has been done. */
  initialExtractDone: boolean
  /** Timestamp of the last auto-extract (ms epoch). Null if never. */
  lastExtractAt: number | null
  /** Session's `updated` timestamp at the time of the last extract. */
  lastSessionUpdated: number | null
}

interface ScheduleStore {
  version: 1
  sessions: Record<string, ScheduleEntry>
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const DEFAULT_STORE_PATH = join(
  homedir(),
  ".local",
  "share",
  "opencode-dashboard",
  "auto-extract-schedule.json",
)

let _storePath = DEFAULT_STORE_PATH

/** Test-only override for the schedule store path. */
export function _resetForTest(path: string): void {
  _storePath = path
}

function emptyStore(): ScheduleStore {
  return { version: 1, sessions: {} }
}

async function loadStore(): Promise<ScheduleStore> {
  if (!existsSync(_storePath)) return emptyStore()
  try {
    const raw = await readFile(_storePath, "utf-8")
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return emptyStore()
    const sessions = (parsed as { sessions?: unknown }).sessions
    if (!sessions || typeof sessions !== "object") return emptyStore()
    const out: Record<string, ScheduleEntry> = {}
    for (const [sid, raw] of Object.entries(sessions as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue
      const e = raw as Partial<ScheduleEntry>
      if (typeof e.sessionId !== "string") continue
      out[sid] = {
        sessionId: e.sessionId,
        reqId: typeof e.reqId === "string" ? e.reqId : "",
        sessionCreatedAt: typeof e.sessionCreatedAt === "number" ? e.sessionCreatedAt : 0,
        initialExtractDone: e.initialExtractDone === true,
        lastExtractAt: typeof e.lastExtractAt === "number" ? e.lastExtractAt : null,
        lastSessionUpdated: typeof e.lastSessionUpdated === "number" ? e.lastSessionUpdated : null,
      }
    }
    return { version: 1, sessions: out }
  } catch {
    return emptyStore()
  }
}

async function saveStore(store: ScheduleStore): Promise<void> {
  const dir = dirname(_storePath)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  await writeFile(_storePath, JSON.stringify(store, null, 2) + "\n", "utf-8")
}

// ---------------------------------------------------------------------------
// Pure predicates (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Whether the initial daily extract should fire.
 *
 * The daily poll already filters to sessions created or updated in the
 * last 24 hours, so this only checks whether the initial extract has
 * been completed and whether we have a non-zero creation timestamp.
 */
export function shouldTriggerInitial(
  entry: ScheduleEntry,
): boolean {
  if (entry.initialExtractDone) return false
  if (entry.sessionCreatedAt <= 0) return false
  return true
}

/**
 * Whether periodic daily re-extract should fire.
 *
 * True when:
 *   - the session's `updated` has advanced beyond `lastSessionUpdated`
 *     (i.e. new content arrived)
 *
 * If `lastExtractAt` is null (never extracted), the initial-extract
 * path handles it — this function returns false to avoid double-trigger.
 */
export function shouldTriggerPeriodic(
  entry: ScheduleEntry,
  sessionUpdated: number,
): boolean {
  if (entry.lastExtractAt === null) return false
  if (entry.lastSessionUpdated === null) return true
  return sessionUpdated > entry.lastSessionUpdated
}

/** True when a session was created or updated in the last 24 hours. */
export function isSessionRecentForDailyWindow(
  session: SessionInfo,
  now: number = Date.now(),
): boolean {
  const latest = Math.max(session.updated || 0, session.created || 0)
  if (latest <= 0) return false
  return now - latest <= RECENT_SESSION_WINDOW_MS
}

/** Milliseconds until the next local occurrence of `hour` (0-23). */
export function msUntilNextLocalHour(hour: number, now: Date = new Date()): number {
  const h = Math.max(0, Math.min(23, Math.floor(hour)))
  const next = new Date(now)
  next.setHours(h, 0, 0, 0)
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1)
  }
  return next.getTime() - now.getTime()
}

// ---------------------------------------------------------------------------
// Schedule reconciliation (pure, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Reconcile the schedule store with the current set of requirement-session
 * associations.
 *
 * - Sessions present in associations but missing from the store are **added**
 *   with `initialExtractDone=false`.
 * - Sessions in the store but no longer in any requirement are **removed**.
 * - Sessions that moved to a different requirement get their `reqId` updated.
 *
 * Returns the new store; does NOT mutate the input.
 */
export function syncSchedule(
  requirements: Requirement[],
  store: ScheduleStore,
  sessionInfoMap: Map<string, SessionInfo>,
): ScheduleStore {
  // Build a sessionId → reqId map from the requirements.
  const assocMap = new Map<string, string>()
  for (const req of requirements) {
    for (const sid of req.sessionIds) {
      assocMap.set(sid, req.id)
    }
  }

  const out: Record<string, ScheduleEntry> = {}

  // Keep or update entries for sessions still associated.
  for (const [sid, reqId] of assocMap) {
    const existing = store.sessions[sid]
    const info = sessionInfoMap.get(sid)
    const createdAt = info?.created ?? existing?.sessionCreatedAt ?? 0
    if (existing) {
      out[sid] = {
        ...existing,
        reqId,
        sessionCreatedAt: createdAt || existing.sessionCreatedAt,
      }
    } else {
      out[sid] = {
        sessionId: sid,
        reqId,
        sessionCreatedAt: createdAt,
        initialExtractDone: false,
        lastExtractAt: null,
        lastSessionUpdated: null,
      }
    }
  }

  return { version: 1, sessions: out }
}

// ---------------------------------------------------------------------------
// Context file reader (duplicated from server.tsx to keep autoExtract.ts pure)
// ---------------------------------------------------------------------------

async function readContextFiles(reqDir: string): Promise<ContextFiles> {
  const readSafe = async (name: string): Promise<string> => {
    const p = join(reqDir, name)
    if (!existsSync(p)) return ""
    try {
      return await readFile(p, "utf-8")
    } catch {
      return ""
    }
  }
  const [meta, memory, branch, config, test, notes, review] = await Promise.all([
    readSafe("meta.md"),
    readSafe("memory.md"),
    readSafe("branch.md"),
    readSafe("config-changes.md"),
    readSafe("test.md"),
    readSafe("notes.md"),
    readSafe("review.md"),
  ])
  return { meta, memory, branch, config, test, notes, review }
}

// ---------------------------------------------------------------------------
// Trigger logic
// ---------------------------------------------------------------------------

/**
 * Trigger an auto-extract job for a session if no job is already running.
 *
 * Reads the requirement's context files, builds the prompt, and calls
 * `createExtractJob`. On success, updates the schedule entry. On conflict
 * (job already running), silently skips.
 *
 * Returns true if a job was started, false if skipped.
 */
async function triggerAutoExtract(
  entry: ScheduleEntry,
  req: Requirement,
  session: SessionInfo,
  model: string,
): Promise<boolean> {
  // Skip if a job is already running for this session.
  if (findRunningJobForSession(entry.sessionId)) return false

  if (!req.reqDir) return false

  const files = await readContextFiles(req.reqDir)
  const prompt = buildAutoExtractPrompt(req, files)

  try {
    createExtractJob({
      reqId: entry.reqId,
      sessionId: entry.sessionId,
      prompt,
      mode: "auto" as JobMode,
      model,
      autoAdopt: false,
      reqDir: req.reqDir,
    })
  } catch {
    // JobConflictError or other — skip silently.
    return false
  }

  // The notification ("⏰ 定时智能提取进行中…") is created by
  // createExtractJob itself; no need for a separate one here.

  return true
}

// ---------------------------------------------------------------------------
// Background worker
// ---------------------------------------------------------------------------

let _timer: ReturnType<typeof setTimeout> | null = null

/**
 * Start the background scheduler. Runs once per day at local midnight.
 *
 * Safe to call multiple times — if already running, does nothing.
 * The timer is `unref`'d so it doesn't keep the process alive.
 */
export function startAutoExtractScheduler(): void {
  if (_timer) return
  scheduleNextDailyPoll()
}

function scheduleNextDailyPoll(): void {
  _timer = setTimeout(() => {
    void pollOnce()
      .catch(() => {})
      .finally(() => {
        _timer = null
        scheduleNextDailyPoll()
      })
  }, msUntilNextLocalHour(DAILY_EXTRACT_HOUR))
  if (typeof _timer.unref === "function") _timer.unref()
}

/** Stop the background scheduler. */
export function stopAutoExtractScheduler(): void {
  if (_timer) {
    clearInterval(_timer)
    _timer = null
  }
}

/** Whether the scheduler interval is currently active. */
export function isAutoExtractSchedulerRunning(): boolean {
  return _timer !== null
}

/**
 * Single poll cycle. Exported for testing.
 *
 * Steps:
 *   1. Check the config toggle — bail if disabled.
 *   2. Load all requirements with their associated sessions.
 *   3. Force-scan recent sessions to get fresh `updated` timestamps.
 *   4. Reconcile the schedule store (add new bindings, drop unbound).
 *   5. For each recent session, check the two trigger conditions and fire
 *      auto-extract jobs for those that qualify.
 *   6. Persist the updated schedule store.
 */
export async function pollOnce(): Promise<void> {
  const cfg = await getConfig()
  if (!cfg.autoExtractSchedule) return

  const projects = await listRequirementsByProject()
  const allReqs = projects.flatMap((p) => p.requirements)
  // Skip the synthetic default requirement — it has no reqDir.
  const realReqs = allReqs.filter((r) => r.id !== "__default__" && r.reqDir)

  // No requirements — nothing to do.
  if (realReqs.length === 0) return

  const sessions = await scanSessions(true, RECENT_SESSION_WINDOW_MS)
  const sessionMap = new Map<string, SessionInfo>()
  for (const s of sessions) {
    sessionMap.set(s.id, s)
  }

  const store = await loadStore()
  const synced = syncSchedule(realReqs, store, sessionMap)

  const now = Date.now()
  let dirty = false

  for (const entry of Object.values(synced.sessions)) {
    const session = sessionMap.get(entry.sessionId)
    if (!session) continue
    if (!isSessionRecentForDailyWindow(session, now)) continue

    // Find the requirement for this session.
    const req = realReqs.find((r) => r.id === entry.reqId)
    if (!req) continue

    const doInitial = shouldTriggerInitial(entry)
    const doPeriodic = shouldTriggerPeriodic(
      entry,
      session.updated || session.created || 0,
    )

    if (!doInitial && !doPeriodic) continue

    const triggered = await triggerAutoExtract(entry, req, session, cfg.extractModel)
    if (triggered) {
      // Update the entry to reflect that an extract has been started.
      entry.initialExtractDone = true
      entry.lastExtractAt = now
      entry.lastSessionUpdated = session.updated || session.created || 0
      dirty = true
    }
  }

  if (dirty) {
    await saveStore(synced)
  } else if (JSON.stringify(synced) !== JSON.stringify(store)) {
    // Schedule was reconciled even if no extracts fired (e.g. new bindings).
    await saveStore(synced)
  }
}
