/**
 * Background scheduler for automated smart context extraction.
 *
 * Role: periodically poll all requirement-bound sessions and trigger
 * auto-extract jobs based on two conditions:
 *   1. **Initial extract** — 24 h after a session was *created*, if it
 *      has been bound to a requirement and not yet auto-extracted.
 *   2. **Periodic re-extract** — every 24 h, if the session's `updated`
 *      timestamp has advanced since the last auto-extract (i.e. the
 *      session received new content).
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
 *   - startAutoExtractScheduler(): start the periodic poll loop
 *   - stopAutoExtractScheduler(): stop the poll loop (for tests)
 *   - pollOnce(): run one poll cycle (exported for testing)
 *   - shouldTriggerInitial(entry, sessionCreatedAt, now): pure predicate
 *   - shouldTriggerPeriodic(entry, sessionUpdated, now): pure predicate
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

/** Poll interval for the background worker. */
export const POLL_INTERVAL_MS = 10 * 60 * 1000

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
 * Whether the initial 24h-after-creation extract should fire.
 *
 * True when:
 *   - `initialExtractDone` is false, AND
 *   - `now - sessionCreatedAt >= 24h`
 *
 * If the session was created more than 24h before binding (common for
 * retroactive association), this returns true immediately so the first
 * extract runs on the next poll.
 */
export function shouldTriggerInitial(
  entry: ScheduleEntry,
  now: number = Date.now(),
): boolean {
  if (entry.initialExtractDone) return false
  if (entry.sessionCreatedAt <= 0) return false
  return now - entry.sessionCreatedAt >= TWENTY_FOUR_HOURS_MS
}

/**
 * Whether the periodic 24h re-extract should fire.
 *
 * True when:
 *   - at least 24h has passed since `lastExtractAt`, AND
 *   - the session's `updated` has advanced beyond
 *     `lastSessionUpdated` (i.e. new content arrived)
 *
 * If `lastExtractAt` is null (never extracted), the initial-extract
 * path handles it — this function returns false to avoid double-trigger.
 */
export function shouldTriggerPeriodic(
  entry: ScheduleEntry,
  sessionUpdated: number,
  now: number = Date.now(),
): boolean {
  if (entry.lastExtractAt === null) return false
  if (now - entry.lastExtractAt < TWENTY_FOUR_HOURS_MS) return false
  if (entry.lastSessionUpdated === null) return true
  return sessionUpdated > entry.lastSessionUpdated
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
// Background worker
// ---------------------------------------------------------------------------

let _timer: ReturnType<typeof setInterval> | null = null

/**
 * Start the background scheduler. Polls every `POLL_INTERVAL_MS`.
 *
 * Safe to call multiple times — if already running, does nothing.
 * The timer is `unref`'d so it doesn't keep the process alive.
 */
export function startAutoExtractScheduler(): void {
  if (_timer) return
  // Run one poll shortly after startup (not immediately, to let the
  // session scanner warm up and the server bind to the port).
  setTimeout(() => {
    void pollOnce().catch(() => {})
  }, 30_000)

  _timer = setInterval(() => {
    void pollOnce().catch(() => {})
  }, POLL_INTERVAL_MS)
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
 *   3. Force-scan sessions to get fresh `updated` timestamps.
 *   4. Reconcile the schedule store (add new bindings, drop unbound).
 *   5. For each session, check the two trigger conditions and fire
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

    const doInitial = shouldTriggerInitial(entry, now)
    const doPeriodic = shouldTriggerPeriodic(
      entry,
      session.updated || session.created || 0,
      now,
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
