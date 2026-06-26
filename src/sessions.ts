/**
 * Read OpenCode sessions from the local SQLite store at
 * `~/.local/share/opencode/opencode.db`, with a CLI fallback and a
 * filesystem fallback derived from `~/.local/share/opencode/storage/session_diff/*.json`.
 *
 * Also provides `updateSessionTitle()` — the sole write operation to
 * opencode.db, used by the auto-extract pipeline to update a session's
 * title based on the extraction summary.
 *
 * Intentionally avoids reading any .env / secret files. The CLI and
 * `sqlite3` invocations never shell-eval user-controlled content; the
 * fallback only inspects file names and mtime.
 */

import { spawn } from "node:child_process"
import { readdir, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const MAX_SESSIONS = 200
export const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/
export const SESSION_STORAGE_DIR = join(homedir(), ".local", "share", "opencode", "storage", "session_diff")
export const DEFAULT_DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db")
const SESSION_LIST_TIMEOUT_MS = 5_000
const SQLITE_TIMEOUT_MS = 5_000

export type SessionStatus = "running" | "idle" | "stale"

export type SessionInfo = {
  id: string
  title: string
  created: number
  updated: number
  projectId: string
  directory: string
  /** Derived from `updated` recency. */
  status: SessionStatus
  /** Source of the row: "db" (preferred) / "cli" / "fs" (fallback). */
  source: "db" | "cli" | "fs"
  /** SQLite-only metadata (populated when source === "db" or CLI happens to expose them). */
  agent?: string
  /** Raw relative `path` column from the session table. */
  path?: string
  /** Best-effort human-readable worktree string for the UI. */
  worktree?: string
  modelId?: string
  modelProvider?: string
  modelVariant?: string
  tokensInput?: number
  tokensOutput?: number
  tokensReasoning?: number
  tokensCacheRead?: number
  tokensCacheWrite?: number
  cost?: number
  /** SQLite parent_id column; null/undefined for top-level sessions. */
  parentId?: string | null
}

type RawSession = {
  id?: unknown
  title?: unknown
  created?: unknown
  updated?: unknown
  projectId?: unknown
  directory?: unknown
  path?: unknown
  agent?: unknown
  model?: unknown
  cost?: unknown
  tokensInput?: unknown
  tokensOutput?: unknown
  tokensReasoning?: unknown
  tokensCacheRead?: unknown
  tokensCacheWrite?: unknown
  parentId?: unknown
}

function toNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v)
  return 0
}

function safeTruncate(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s
}

function statusFromUpdated(updated: number, now = Date.now()): SessionStatus {
  if (!updated) return "stale"
  const ageMs = now - updated
  if (ageMs < 5 * 60_000) return "running"      // < 5 min
  if (ageMs < 24 * 60 * 60_000) return "idle"    // < 24 h
  return "stale"
}

/**
 * Parse a SQLite `model` column. The column is a JSON-encoded
 * `{"id":"...","providerID":"...","variant":"..."}` string; if parsing
 * fails the raw text is preserved as `modelId` so callers can still
 * surface a hint to the user.
 *
 * Exported for unit testing.
 */
export function parseModelString(raw: unknown): {
  modelId?: string
  modelProvider?: string
  modelVariant?: string
} {
  if (typeof raw !== "string" || raw.length === 0) return {}
  try {
    const obj = JSON.parse(raw) as { id?: unknown; providerID?: unknown; variant?: unknown }
    if (!obj || typeof obj !== "object") {
      return { modelId: raw }
    }
    return {
      modelId: typeof obj.id === "string" ? obj.id : raw,
      modelProvider: typeof obj.providerID === "string" ? obj.providerID : undefined,
      modelVariant: typeof obj.variant === "string" ? obj.variant : undefined,
    }
  } catch {
    return { modelId: raw }
  }
}

/**
 * Derive a human-readable worktree string for a session.
 *
 * Preference order:
 *   1. `directory` (absolute path) -> render as `~/<relative>` when under $HOME.
 *   2. `path` (relative form, no leading slash) -> `~/<path>` when it looks like a home child.
 *   3. `directory` as-is (absolute path from a different mount).
 *   4. `path` as-is.
 *   5. `none` placeholder so the UI never has to special-case missing data.
 *
 * Exported for unit testing.
 */
export function deriveWorktree(args: { directory?: string | null; path?: string | null }): string {
  const home = homedir()
  const directory = typeof args.directory === "string" && args.directory.length > 0 ? args.directory : ""
  const relPath = typeof args.path === "string" && args.path.length > 0 ? args.path : ""

  // 1) Absolute directory under $HOME -> render as ~/...
  if (directory) {
    if (home && (directory === home || directory.startsWith(home + "/"))) {
      return directory === home ? "~" : "~/" + directory.slice(home.length + 1)
    }
    // Absolute directory not under $HOME: keep the absolute form so the
    // user can see at a glance that the session lives on another mount.
    return directory
  }
  // 2) No directory; use the relative `path` column with a ~/ prefix
  //    so the rendering stays consistent with the home-relative case.
  if (relPath) {
    return "~/" + relPath.replace(/^\/+/, "")
  }
  // 3) Nothing useful in either column; let the UI render a placeholder.
  return "none"
}

function normalizeSession(raw: RawSession, source: "db" | "cli" | "fs"): SessionInfo | null {
  const id = typeof raw.id === "string" ? raw.id : ""
  if (!SESSION_ID_RE.test(id)) return null
  const updated = toNumber(raw.updated)
  const created = toNumber(raw.created)
  const title = typeof raw.title === "string" ? safeTruncate(raw.title) : "(untitled)"
  const projectId = typeof raw.projectId === "string" && raw.projectId.length > 0 ? raw.projectId : "global"
  const directory = typeof raw.directory === "string" ? raw.directory : ""
  const path = typeof raw.path === "string" ? raw.path : undefined
  const agent = typeof raw.agent === "string" && raw.agent.length > 0 ? raw.agent : undefined
  const parentId = typeof raw.parentId === "string" && raw.parentId.length > 0 ? raw.parentId : null
  const tokens = {
    input: toNumber(raw.tokensInput),
    output: toNumber(raw.tokensOutput),
    reasoning: toNumber(raw.tokensReasoning),
    cacheRead: toNumber(raw.tokensCacheRead),
    cacheWrite: toNumber(raw.tokensCacheWrite),
  }
  const cost = toNumber(raw.cost)
  const model = parseModelString(raw.model)
  const worktree = source === "fs" ? undefined : deriveWorktree({ directory, path: path ?? null })

  const out: SessionInfo = {
    id,
    title,
    created,
    updated,
    projectId,
    directory,
    status: statusFromUpdated(updated || created),
    source,
  }
  if (path) out.path = path
  if (agent) out.agent = agent
  if (parentId) out.parentId = parentId
  if (worktree) out.worktree = worktree
  if (model.modelId) out.modelId = model.modelId
  if (model.modelProvider) out.modelProvider = model.modelProvider
  if (model.modelVariant) out.modelVariant = model.modelVariant
  if (tokens.input) out.tokensInput = tokens.input
  if (tokens.output) out.tokensOutput = tokens.output
  if (tokens.reasoning) out.tokensReasoning = tokens.reasoning
  if (tokens.cacheRead) out.tokensCacheRead = tokens.cacheRead
  if (tokens.cacheWrite) out.tokensCacheWrite = tokens.cacheWrite
  if (cost) out.cost = cost
  return out
}

// ---------------------------------------------------------------------------
// Source 1: SQLite (preferred) — `sqlite3 -json <db> "<query>"`
// ---------------------------------------------------------------------------

const SQLITE_QUERY = `
select
  id            as id,
  project_id    as projectId,
  directory     as directory,
  path          as path,
  title         as title,
  time_created  as created,
  time_updated  as updated,
  agent         as agent,
  parent_id     as parentId,
  model         as model,
  cost          as cost,
  tokens_input        as tokensInput,
  tokens_output       as tokensOutput,
  tokens_reasoning    as tokensReasoning,
  tokens_cache_read   as tokensCacheRead,
  tokens_cache_write  as tokensCacheWrite
from session
where time_archived is null
order by time_updated desc
limit ${MAX_SESSIONS}
`.trim()

function runSqliteScan(dbPath: string): Promise<SessionInfo[] | null> {
  return new Promise((resolve) => {
    if (!existsSync(dbPath)) {
      resolve(null)
      return
    }
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn("sqlite3", ["-json", dbPath, SQLITE_QUERY], {
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch {
      resolve(null)
      return
    }
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      try { proc.kill() } catch { /* noop */ }
    }, SQLITE_TIMEOUT_MS)
    proc.stdout?.on("data", (d) => { stdout += d.toString("utf-8") })
    proc.stderr?.on("data", (d) => { stderr += d.toString("utf-8") })
    proc.on("error", () => {
      clearTimeout(timer)
      resolve(null)
    })
    proc.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        if (process.env.DEBUG_OPENCODE_DASH) {
          console.warn(`[sessions] sqlite3 exited code=${code} stderr=${stderr.slice(0, 200)}`)
        }
        resolve(null)
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(stdout)
      } catch {
        resolve(null)
        return
      }
      if (!Array.isArray(parsed)) {
        resolve(null)
        return
      }
      const out: SessionInfo[] = []
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue
        const norm = normalizeSession(item as RawSession, "db")
        if (norm) out.push(norm)
      }
      resolve(out)
    })
  })
}

// ---------------------------------------------------------------------------
// Source 2: opencode CLI fallback
// ---------------------------------------------------------------------------

function runOpencodeList(): Promise<SessionInfo[] | null> {
  return new Promise((resolve) => {
    const args = ["session", "list", "--format", "json", "--max-count", String(MAX_SESSIONS)]
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn("opencode", args, { stdio: ["ignore", "pipe", "pipe"] })
    } catch {
      resolve(null)
      return
    }
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      try { proc.kill() } catch { /* noop */ }
    }, SESSION_LIST_TIMEOUT_MS)
    proc.stdout?.on("data", (d) => { stdout += d.toString("utf-8") })
    proc.stderr?.on("data", (d) => { stderr += d.toString("utf-8") })
    proc.on("error", () => {
      clearTimeout(timer)
      resolve(null)
    })
    proc.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        if (process.env.DEBUG_OPENCODE_DASH) {
          console.warn(`[sessions] opencode exited code=${code} stderr=${stderr.slice(0, 200)}`)
        }
        resolve(null)
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(stdout)
      } catch {
        resolve(null)
        return
      }
      if (!Array.isArray(parsed)) {
        resolve(null)
        return
      }
      const out: SessionInfo[] = []
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue
        const norm = normalizeSession(item as RawSession, "cli")
        if (norm) out.push(norm)
      }
      resolve(out)
    })
  })
}

// ---------------------------------------------------------------------------
// Source 3: filesystem fallback
// ---------------------------------------------------------------------------

async function readSessionDiffFallback(): Promise<SessionInfo[]> {
  if (!existsSync(SESSION_STORAGE_DIR)) return []
  let entries: Array<import("node:fs").Dirent<string>>
  try {
    entries = await readdir(SESSION_STORAGE_DIR, { withFileTypes: true }) as Array<import("node:fs").Dirent<string>>
  } catch {
    return []
  }
  const out: SessionInfo[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const name: string = String(entry.name)
    const m = name.match(/^(ses_[A-Za-z0-9]+)\.json$/)
    if (!m) continue
    const id = m[1]
    if (!SESSION_ID_RE.test(id)) continue
    let st
    try {
      st = await stat(join(SESSION_STORAGE_DIR, name))
    } catch {
      continue
    }
    const updated = Math.floor(st.mtimeMs)
    out.push({
      id,
      title: `session ${id.slice(4, 14)}`,
      created: Math.floor(st.ctimeMs),
      updated,
      projectId: "global",
      directory: "",
      status: statusFromUpdated(updated),
      source: "fs",
    })
  }
  out.sort((a, b) => b.updated - a.updated)
  return out.slice(0, MAX_SESSIONS)
}

// ---------------------------------------------------------------------------
// Cache + scan orchestration
// ---------------------------------------------------------------------------

let cache: { at: number; data: SessionInfo[] } | null = null
const CACHE_TTL_MS = 4_000

/**
 * Filter sessions whose `updated` (or `created` as fallback) timestamp
 * is older than `Date.now() - maxAgeMs`. A non-positive or non-finite
 * `maxAgeMs` disables the filter and returns the input as-is.
 *
 * Exported for unit testing — kept side-effect-free so different time
 * windows can reuse the same cached unfiltered list in `scanSessions`.
 */
export function applyAgeFilter(sessions: SessionInfo[], maxAgeMs?: number): SessionInfo[] {
  if (!maxAgeMs || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return sessions
  const cutoff = Date.now() - maxAgeMs
  return sessions.filter((s) => (s.updated || s.created || 0) >= cutoff)
}

export async function scanSessions(force = false, maxAgeMs?: number): Promise<SessionInfo[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return applyAgeFilter(cache.data, maxAgeMs)
  }
  // 1) SQLite is the cheapest and richest source.
  let list = await runSqliteScan(DEFAULT_DB_PATH)
  // 2) Fall back to the opencode CLI for environments that don't ship sqlite3.
  if (!list) list = await runOpencodeList()
  // 3) Last resort: filesystem mtime scan.
  if (!list) list = await readSessionDiffFallback()
  list.sort((a, b) => b.updated - a.updated)
  // Cache the *unfiltered* list so different `maxAgeMs` windows can
  // reuse it within CACHE_TTL_MS without re-scanning the DB.
  cache = { at: Date.now(), data: list }
  return applyAgeFilter(list, maxAgeMs)
}

export function clearSessionCache(): void {
  cache = null
}

/**
 * Update a session's title in opencode's SQLite database.
 *
 * Uses the same `.param set` stdin-feeding protocol as `forkSalvage.ts`
 * for SQL-injection-safe parameter binding. After a successful write,
 * the session cache is cleared so the next `scanSessions()` reflects
 * the new title.
 *
 * Constraints:
 *   - Only writes to the fixed `DEFAULT_DB_PATH`.
 *   - Session id is validated via `SESSION_ID_RE` before the query.
 *   - Title is truncated to 200 chars (matching `safeTruncate` on read).
 *   - Never throws; errors are silently swallowed (best-effort update).
 */
export async function updateSessionTitle(sessionId: string, title: string): Promise<boolean> {
  if (!SESSION_ID_RE.test(sessionId)) return false
  const trimmed = title.trim()
  if (!trimmed) return false
  const safeTitle = trimmed.length > 200 ? trimmed.slice(0, 199) + "…" : trimmed
  if (!existsSync(DEFAULT_DB_PATH)) return false

  return new Promise<boolean>((resolve) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn("sqlite3", [DEFAULT_DB_PATH], {
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch {
      resolve(false)
      return
    }

    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL") } catch { /* noop */ }
    }, SQLITE_TIMEOUT_MS)

    proc.on("error", () => {
      clearTimeout(timer)
      resolve(false)
    })
    proc.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) {
        clearSessionCache()
        resolve(true)
      } else {
        resolve(false)
      }
    })

    const script =
      `.param init\n` +
      `.param set :id ${JSON.stringify(sessionId)}\n` +
      `.param set :title ${JSON.stringify(safeTitle)}\n` +
      `UPDATE session SET title = :title WHERE id = :id;\n` +
      `.quit\n`
    try {
      proc.stdin?.write(script)
      proc.stdin?.end()
    } catch {
      // close handler will resolve(false).
    }
  })
}

export async function getSession(id: string): Promise<SessionInfo | null> {
  if (!SESSION_ID_RE.test(id)) return null
  const all = await scanSessions()
  return all.find((s) => s.id === id) ?? null
}

/** Counters shown on the dashboard top strip. */
export function summarizeSessions(sessions: SessionInfo[]): {
  total: number
  running: number
  idle: number
  stale: number
} {
  let running = 0
  let idle = 0
  let stale = 0
  for (const s of sessions) {
    if (s.status === "running") running++
    else if (s.status === "idle") idle++
    else stale++
  }
  return { total: sessions.length, running, idle, stale }
}

/**
 * Group sessions into top-level and a children map keyed by parent id.
 *
 * - Top-level: sessions with no parentId, OR whose parentId does not
 *   match any session id in the input (orphan children whose parent
 *   was archived or otherwise missing from the scan).
 * - childrenByParent: parentId -> list of child sessions, sorted by
 *   `updated` descending so the freshest child is first.
 */
export function groupSessionsByParent(sessions: SessionInfo[]): {
  top: SessionInfo[]
  childrenByParent: Map<string, SessionInfo[]>
} {
  const idSet = new Set<string>()
  for (const s of sessions) idSet.add(s.id)

  const childrenByParent = new Map<string, SessionInfo[]>()
  const top: SessionInfo[] = []

  for (const s of sessions) {
    const pid = s.parentId
    if (typeof pid === "string" && pid.length > 0 && idSet.has(pid)) {
      const list = childrenByParent.get(pid)
      if (list) list.push(s)
      else childrenByParent.set(pid, [s])
    } else {
      top.push(s)
    }
  }

  for (const list of childrenByParent.values()) {
    list.sort((a, b) => b.updated - a.updated)
  }

  return { top, childrenByParent }
}

/**
 * Resolve a safe working directory for a session.
 * Rules:
 *  - If the session reports a directory and it exists, return it.
 *  - Otherwise, fall back to $HOME or process.cwd().
 *  - Reject any path that contains ".." segments.
 */
export function resolveCwd(candidate?: string | null): string {
  if (candidate && typeof candidate === "string") {
    if (candidate.includes("..")) return process.cwd()
    if (existsSync(candidate)) return candidate
  }
  return process.env.HOME || homedir() || process.cwd()
}

/** Validate a session id string before using it in a command line. */
export function isValidSessionId(id: string | null | undefined): id is string {
  return typeof id === "string" && SESSION_ID_RE.test(id)
}
