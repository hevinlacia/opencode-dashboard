/**
 * Nightly scheduler for automated smart context extraction.
 *
 * Role: at midnight (local time) each night, sweep all requirement-bound
 * sessions and trigger auto-extract for those that have NEVER been
 * smart-extracted. Already-extracted sessions are skipped permanently —
 * ongoing file maintenance is handled by the in-session prompt-based
 * instructions injected via `buildInjectionContext`.
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
 *   - startAutoExtractScheduler(): start the nightly midnight poll loop
 *   - stopAutoExtractScheduler(): stop the poll loop (for tests)
 *   - pollOnce(): run one poll cycle (exported for testing)
 *   - shouldTriggerInitial(entry, now): pure predicate
 *   - syncSchedule(requirements, store): pure reconciliation
 *   - msUntilMidnight(now): calculate delay to next midnight
 *   - _resetForTest(path): test-only path override
 *
 * Constraints / safety:
 *   - Only `node:` built-ins + project modules.
 *   - Never reads or writes `.env` / secret files.
 *   - Session ids are validated before any job creation.
 *   - Skips sessions that already have a running extract job.
 *   - Cross-checks extract history to skip manually-extracted sessions.
 *
 * Read-this-with:
 *   - `src/extractJobs.ts` (createExtractJob — the job spawn mechanism).
 *   - `src/autoExtract.ts` (buildAutoExtractPrompt — the prompt builder).
 *   - `src/requirements.ts` (listRequirementsByProject, associations).
 *   - `src/sessions.ts` (scanSessions — SessionInfo with timestamps).
 *   - `src/extractHistory.ts` (getLastExtractForSession — skip check).
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
import { getLastExtractForSession } from "./extractHistory.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum session age before the nightly sweep will extract it (1 hour). */
export const MIN_SESSION_AGE_MS = 60 * 60 * 1000

/** Retained for backward compatibility — no longer used in trigger logic. */
export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduleEntry {
  sessionId: string
  reqId: string
  /** When the session was created (ms epoch). Captured at bind time. */
  sessionCreatedAt: number
  /** Whether the initial nightly extract has been done. */
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
 * Whether the nightly sweep should extract this session.
 *
 * True when:
 *   - `initialExtractDone` is false, AND
 *   - the session is at least `MIN_SESSION_AGE_MS` old (or age is unknown)
 *
 * The 1-hour minimum prevents extracting brand-new sessions that likely
 * have too little content to be worth forking. Retroactive bindings
 * (sessionCreatedAt = 0 or very old) always qualify.
 */
export function shouldTriggerInitial(
  entry: ScheduleEntry,
  now: number = Date.now(),
): boolean {
  if (entry.initialExtractDone) return false
  if (entry.sessionCreatedAt <= 0) return true
  return now - entry.sessionCreatedAt >= MIN_SESSION_AGE_MS
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
  const [meta, branch, config, test, notes] = await Promise.all([
    readSafe("meta.md"),
    readSafe("branch.md"),
    readSafe("config-changes.md"),
    readSafe("test.md"),
    readSafe("notes.md"),
  ])
  return { meta, branch, config, test, notes }
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
      autoAdopt: true,
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
// Midnight scheduling
// ---------------------------------------------------------------------------

/**
 * Calculate milliseconds until the next local midnight.
 *
 * Uses the system's local timezone (via `Date` constructors), so on a
 * machine in UTC+8, midnight is at 00:00 CST.
 */
export function msUntilMidnight(now: number = Date.now()): number {
  const date = new Date(now)
  const nextMidnight = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + 1, // tomorrow
    0, 0, 0, 0, // 00:00:00.000 local
  )
  return nextMidnight.getTime() - now
}

// ---------------------------------------------------------------------------
// Background worker
// ---------------------------------------------------------------------------

let _timer: ReturnType<typeof setTimeout> | null = null
let _startupTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Start the nightly scheduler. Fires at midnight (local time) each day.
 *
 * Also runs a startup poll 30 s after the server boots, to catch
 * sessions that should have been extracted while the dashboard was
 * down. Since extract history is the source of truth, this is safe —
 * already-extracted sessions won't be re-triggered.
 *
 * Safe to call multiple times — if already running, does nothing.
 * Both timers are `unref`'d so they don't keep the process alive.
 */
export function startAutoExtractScheduler(): void {
  if (_timer) return

  // Startup poll: catch missed midnight runs.
  _startupTimer = setTimeout(() => {
    void pollOnce().catch(() => {})
  }, 30_000)
  if (typeof _startupTimer.unref === "function") _startupTimer.unref()

  // Schedule the recurring midnight poll.
  scheduleNextMidnight()
}

function scheduleNextMidnight(): void {
  const delay = msUntilMidnight()
  _timer = setTimeout(() => {
    void pollOnce().catch(() => {})
    scheduleNextMidnight()
  }, delay)
  if (typeof _timer.unref === "function") _timer.unref()
}

/** Stop the nightly scheduler and clear the startup poll. */
export function stopAutoExtractScheduler(): void {
  if (_timer) {
    clearTimeout(_timer)
    _timer = null
  }
  if (_startupTimer) {
    clearTimeout(_startupTimer)
    _startupTimer = null
  }
}

/** Whether the scheduler is currently active. */
export function isAutoExtractSchedulerRunning(): boolean {
  return _timer !== null
}

/**
 * Single poll cycle. Exported for testing.
 *
 * Steps:
 *   1. Check the config toggle — bail if disabled.
 *   2. Load all requirements with their associated sessions.
 *   3. Force-scan sessions to get fresh `updated` timestamps.
 *   4. Reconcile the schedule store (add new bindings, drop unbound).
 *   5. For each session, check if it has already been smart-extracted
 *      (via extract history cross-check). Skip if so.
 *   6. For un-extracted sessions that pass the minimum-age check,
 *      fire auto-extract jobs.
 *   7. Persist the updated schedule store.
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

  const sessions = await scanSessions(true)
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

    // Find the requirement for this session.
    const req = realReqs.find((r) => r.id === entry.reqId)
    if (!req) continue

    // Fast-path: if the schedule entry already says done, skip.
    if (!shouldTriggerInitial(entry, now)) continue

    // Source-of-truth cross-check: extract history records ALL successful
    // extracts (including manual ones). If the session was already
    // extracted, mark the entry as done and skip.
    const lastExtract = await getLastExtractForSession(entry.sessionId)
    if (lastExtract) {
      entry.initialExtractDone = true
      dirty = true
      continue
    }

    const triggered = await triggerAutoExtract(entry, req, session, cfg.extractModel)
    if (triggered) {
      // Don't set initialExtractDone here — the extract job is async and
      // might fail. The next poll will check extract history and only
      // mark done if the job actually succeeded.
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
