/**
 * Read-only transcript recall from OpenCode's local SQLite store.
 *
 * Role: fetch a bounded, text-only view of one historical session so a
 * requirement can recall evidence that was not promoted into memory.md.
 * Public surface: readSessionTranscript(), buildRecallMarkdown().
 * Constraints: filters to `part.data.type === "text"`; never returns
 * reasoning, tool calls, tool results, or raw non-text parts.
 * Read-this-with: src/requirements.ts and src/server.tsx recall route.
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"

import { DEFAULT_DB_PATH, SESSION_ID_RE } from "./sessions.ts"

const SQLITE_TIMEOUT_MS = 5_000
const STDOUT_CAP_BYTES = 512 * 1024
const STDERR_CAP_BYTES = 16 * 1024

export interface TranscriptPart {
  messageId: string
  role: "user" | "assistant" | "system" | "unknown"
  messageTime: number
  partId: string
  text: string
}

export interface ReadSessionTranscriptOptions {
  sessionId: string
  dbPath?: string
  limitParts?: number
  maxTextChars?: number
  sqliteFn?: typeof spawn
}

/**
 * Read chronological text parts for one session from OpenCode SQLite.
 * Non-text parts are excluded in SQL; role is still parsed defensively
 * from message.data so malformed rows degrade to role="unknown".
 */
export function readSessionTranscript(
  opts: ReadSessionTranscriptOptions,
): Promise<TranscriptPart[]> {
  const sessionId = opts.sessionId
  if (!SESSION_ID_RE.test(sessionId)) return Promise.resolve([])
  const dbPath = opts.dbPath ?? DEFAULT_DB_PATH
  const limitParts = Math.max(1, Math.min(500, opts.limitParts ?? 200))
  const maxTextChars = Math.max(200, Math.min(20_000, opts.maxTextChars ?? 4_000))
  const sp = opts.sqliteFn ?? spawn

  const query = `
    SELECT
      m.id AS message_id,
      json_extract(m.data, '$.role') AS role,
      m.time_created AS message_time,
      p.id AS part_id,
      json_extract(p.data, '$.text') AS text
    FROM message m
    JOIN part p ON p.message_id = m.id
    WHERE m.session_id = :sid
      AND p.session_id = :sid
      AND json_extract(p.data, '$.type') = 'text'
      AND json_extract(p.data, '$.text') IS NOT NULL
    ORDER BY m.time_created ASC, p.time_created ASC
    LIMIT :limitParts
  `.trim()

  return new Promise<TranscriptPart[]>((resolve) => {
    if (!existsSync(dbPath)) {
      resolve([])
      return
    }

    let proc: ReturnType<typeof spawn>
    try {
      proc = sp("sqlite3", ["-json", dbPath], { stdio: ["pipe", "pipe", "pipe"] })
    } catch {
      resolve([])
      return
    }

    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL") } catch { /* noop */ }
    }, SQLITE_TIMEOUT_MS)

    proc.stdout?.on("data", (d: Buffer) => {
      if (stdout.length >= STDOUT_CAP_BYTES) return
      stdout += d.toString("utf-8")
    })
    proc.stderr?.on("data", (d: Buffer) => {
      if (stderr.length >= STDERR_CAP_BYTES) return
      stderr += d.toString("utf-8")
    })
    proc.on("error", () => {
      clearTimeout(timer)
      resolve([])
    })
    proc.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        resolve([])
        return
      }
      let rows: unknown
      try { rows = JSON.parse(stdout || "[]") } catch { resolve([]); return }
      if (!Array.isArray(rows)) { resolve([]); return }

      const out: TranscriptPart[] = []
      for (const row of rows as Record<string, unknown>[]) {
        const text = typeof row.text === "string" ? row.text.trim() : ""
        if (!text) continue
        const roleRaw = typeof row.role === "string" ? row.role : "unknown"
        const role: TranscriptPart["role"] =
          roleRaw === "user" || roleRaw === "assistant" || roleRaw === "system"
            ? roleRaw
            : "unknown"
        const clipped = text.length > maxTextChars ? text.slice(0, maxTextChars - 1) + "…" : text
        out.push({
          messageId: typeof row.message_id === "string" ? row.message_id : "",
          role,
          messageTime: typeof row.message_time === "number" ? row.message_time : 0,
          partId: typeof row.part_id === "string" ? row.part_id : "",
          text: clipped,
        })
      }
      resolve(out)
    })

    const script =
      `.param init\n` +
      `.param set :sid ${JSON.stringify(sessionId)}\n` +
      `.param set :limitParts ${limitParts}\n` +
      query + ";\n" +
      `.quit\n`
    try {
      proc.stdin?.write(script)
      proc.stdin?.end()
    } catch {
      // close handler will resolve([]).
    }
  })
}

/** Build a compact markdown transcript excerpt suitable for UI/API recall. */
export function buildRecallMarkdown(parts: TranscriptPart[]): string {
  if (parts.length === 0) return ""
  const lines: string[] = []
  let lastMessageId = ""
  for (const part of parts) {
    if (part.messageId !== lastMessageId) {
      lastMessageId = part.messageId
      const role = part.role === "assistant" ? "Assistant" : part.role === "user" ? "User" : "System"
      const time = part.messageTime ? new Date(part.messageTime).toISOString() : "unknown time"
      lines.push(`\n## ${role} · ${time}`)
    }
    lines.push(part.text)
  }
  return lines.join("\n\n").trim()
}
