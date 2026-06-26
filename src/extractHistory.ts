/**
 * Persistent extract-job history for requirement pages.
 *
 * Role: keep a compact audit trail of completed context-extract jobs so
 * a requirement can be reviewed after the in-memory job store or server
 * process is gone.
 *
 * Public surface:
 *   - appendExtractHistory(record)
 *   - buildExtractHistoryRecord(job)
 *   - getExtractHistoryForRequirement(reqId, limit)
 *   - _resetExtractHistoryForTest(path)
 *
 * Constraints / safety:
 *   - Stores concise snippets only, not full session transcripts.
 *   - Only writes under `~/.local/share/opencode-dashboard/` by default.
 *
 * Read-this-with:
 *   - `src/extractJobs.ts` writes records when jobs finish.
 *   - `src/server.tsx` renders recent records on requirement detail pages.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import type { AutoExtractResult } from "./autoExtract.ts"

export type ExtractHistoryState = "done" | "failed"
export type ExtractHistoryMode = "summary" | "auto"

export interface ExtractHistoryRecord {
  id: string
  reqId: string
  sessionId: string
  mode: ExtractHistoryMode
  state: ExtractHistoryState
  model: string
  startedAt: number
  doneAt: number
  exitCode: number | null
  timedOut: boolean
  errorMessage: string | null
  salvagedFromFork: boolean
  forkSessionId: string | null
  forkTitle: string | null
  summary: string
  stdoutSnippet: string
  stderrSnippet: string
  autoFileCount: number
}

interface ExtractHistoryStore {
  version: 1
  records: ExtractHistoryRecord[]
}

interface ExtractHistoryJobLike {
  id: string
  reqId: string
  sessionId: string
  mode: ExtractHistoryMode
  state: "running" | ExtractHistoryState
  model?: string
  startedAt: number
  doneAt: number | null
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  errorMessage: string | null
  forkSessionId: string | null
  forkTitle: string | null
  salvagedFromFork: boolean
  autoResult: AutoExtractResult | null
}

const DEFAULT_HISTORY_PATH = join(
  homedir(),
  ".local",
  "share",
  "opencode-dashboard",
  "extract-history.json",
)
const MAX_RECORDS = 500
const MAX_SNIPPET = 2000
const MAX_SUMMARY = 500

let _historyPath = DEFAULT_HISTORY_PATH

function clip(text: string, max: number): string {
  const trimmed = text.replace(/^\uFEFF/, "").trim()
  return trimmed.length > max ? trimmed.slice(0, max - 1) + "…" : trimmed
}

async function ensureDir(): Promise<void> {
  const dir = dirname(_historyPath)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
}

async function loadStore(): Promise<ExtractHistoryStore> {
  if (!existsSync(_historyPath)) return { version: 1, records: [] }
  try {
    const raw = await readFile(_historyPath, "utf-8")
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return { version: 1, records: [] }
    const records = Array.isArray((parsed as { records?: unknown }).records)
      ? (parsed as { records: unknown[] }).records
      : []
    const out: ExtractHistoryRecord[] = []
    for (const item of records) {
      if (!item || typeof item !== "object") continue
      const r = item as Partial<ExtractHistoryRecord>
      if (!r.id || !r.reqId || !r.sessionId) continue
      if (r.state !== "done" && r.state !== "failed") continue
      if (r.mode !== "summary" && r.mode !== "auto") continue
      out.push({
        id: String(r.id),
        reqId: String(r.reqId),
        sessionId: String(r.sessionId),
        mode: r.mode,
        state: r.state,
        model: typeof r.model === "string" ? r.model : "",
        startedAt: typeof r.startedAt === "number" ? r.startedAt : 0,
        doneAt: typeof r.doneAt === "number" ? r.doneAt : 0,
        exitCode: typeof r.exitCode === "number" ? r.exitCode : null,
        timedOut: r.timedOut === true,
        errorMessage: typeof r.errorMessage === "string" ? r.errorMessage : null,
        salvagedFromFork: r.salvagedFromFork === true,
        forkSessionId: typeof r.forkSessionId === "string" ? r.forkSessionId : null,
        forkTitle: typeof r.forkTitle === "string" ? r.forkTitle : null,
        summary: typeof r.summary === "string" ? clip(r.summary, MAX_SUMMARY) : "",
        stdoutSnippet: typeof r.stdoutSnippet === "string" ? clip(r.stdoutSnippet, MAX_SNIPPET) : "",
        stderrSnippet: typeof r.stderrSnippet === "string" ? clip(r.stderrSnippet, MAX_SNIPPET) : "",
        autoFileCount: typeof r.autoFileCount === "number" ? r.autoFileCount : 0,
      })
    }
    return { version: 1, records: out }
  } catch {
    return { version: 1, records: [] }
  }
}

async function saveStore(store: ExtractHistoryStore): Promise<void> {
  await ensureDir()
  const records = store.records
    .slice()
    .sort((a, b) => b.doneAt - a.doneAt)
    .slice(0, MAX_RECORDS)
  await writeFile(_historyPath, JSON.stringify({ version: 1, records }, null, 2) + "\n", "utf-8")
}

function summarizeStdout(stdout: string): string {
  const flattened = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("## "))
    .join(" ")
  return clip(flattened || stdout, MAX_SUMMARY)
}

/** Build a compact history record from a completed extract job. */
export function buildExtractHistoryRecord(job: ExtractHistoryJobLike): ExtractHistoryRecord | null {
  if (job.state !== "done" && job.state !== "failed") return null
  const autoFileCount = job.autoResult
    ? job.autoResult.updates.length + job.autoResult.appends.length
    : 0
  const summary = job.mode === "auto"
    ? clip(job.autoResult?.summary ?? job.errorMessage ?? "", MAX_SUMMARY)
    : summarizeStdout(job.stdout || job.errorMessage || "")
  return {
    id: job.id,
    reqId: job.reqId,
    sessionId: job.sessionId,
    mode: job.mode,
    state: job.state,
    model: job.model ?? "",
    startedAt: job.startedAt,
    doneAt: job.doneAt ?? Date.now(),
    exitCode: job.exitCode,
    timedOut: job.timedOut,
    errorMessage: job.errorMessage,
    salvagedFromFork: job.salvagedFromFork,
    forkSessionId: job.forkSessionId,
    forkTitle: job.forkTitle,
    summary,
    stdoutSnippet: clip(job.stdout, MAX_SNIPPET),
    stderrSnippet: clip(job.stderr, MAX_SNIPPET),
    autoFileCount,
  }
}

/** Append or replace a history record by job id, keeping newest first. */
export async function appendExtractHistory(record: ExtractHistoryRecord): Promise<void> {
  const store = await loadStore()
  const withoutSame = store.records.filter((r) => r.id !== record.id)
  withoutSame.unshift(record)
  await saveStore({ version: 1, records: withoutSame })
}

/** Return recent extract-job records for one requirement. */
export async function getExtractHistoryForRequirement(
  reqId: string,
  limit = 8,
): Promise<ExtractHistoryRecord[]> {
  const store = await loadStore()
  return store.records
    .filter((r) => r.reqId === reqId)
    .sort((a, b) => b.doneAt - a.doneAt)
    .slice(0, Math.max(0, limit))
}

/**
 * Return the most recent successful extract record for a session,
 * regardless of which requirement it was triggered from.
 *
 * Used by the debounce/no-new-content guard to check whether the
 * session has been extracted before and whether new conversation
 * has happened since.
 */
export async function getLastExtractForSession(
  sessionId: string,
): Promise<ExtractHistoryRecord | null> {
  const store = await loadStore()
  const records = store.records
    .filter((r) => r.sessionId === sessionId && r.state === "done")
    .sort((a, b) => b.doneAt - a.doneAt)
  return records[0] ?? null
}

/** Test-only override for the history file path. */
export function _resetExtractHistoryForTest(path: string): void {
  _historyPath = path
}
