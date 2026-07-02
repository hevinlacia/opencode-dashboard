/**
 * Tests for `src/sessionTranscript.ts`.
 */

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { PassThrough, type Readable } from "node:stream"
import { existsSync, writeFileSync } from "node:fs"

import {
  buildRecallMarkdown,
  readSessionTranscript,
} from "../src/sessionTranscript.ts"

function fakeSqlite(rows: unknown[], capturedScript?: { value: string }) {
  return ((_bin: string, _argv: string[], opts?: { stdio?: unknown }) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      stdin: PassThrough
      kill: () => boolean
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.kill = () => true
    if (capturedScript) {
      child.stdin.on("data", (d) => { capturedScript.value += d.toString("utf-8") })
    }
    setTimeout(() => {
      child.stdout.push(JSON.stringify(rows))
      child.stdout.push(null)
      child.stderr.push(null)
      child.emit("close", 0)
    }, 0)
    return child
  }) as any
}

function fakeDbPath(): string {
  const path = "/tmp/opencode/fake-opencode-transcript.db"
  writeFileSync(path, "", "utf-8")
  return path
}

test("readSessionTranscript: returns only text rows with clipped text", async () => {
  const parts = await readSessionTranscript({
    sessionId: "ses_transcript111111",
    dbPath: fakeDbPath(),
    sqliteFn: fakeSqlite([
      {
        message_id: "msg_1",
        role: "user",
        message_time: 1000,
        part_id: "prt_1",
        text: "hello",
      },
      {
        message_id: "msg_2",
        role: "assistant",
        message_time: 2000,
        part_id: "prt_2",
        text: "x".repeat(300),
      },
    ]),
    maxTextChars: 200,
  })
  assert.equal(parts.length, 2)
  assert.equal(parts[0].role, "user")
  assert.equal(parts[0].text, "hello")
  assert.equal(parts[1].role, "assistant")
  assert.equal(parts[1].text.length, 200)
  assert.ok(parts[1].text.endsWith("…"))
})

test("readSessionTranscript: rejects invalid session ids before sqlite", async () => {
  let called = false
  const sqliteFn: any = () => {
    called = true
    throw new Error("should not be called")
  }
  const parts = await readSessionTranscript({ sessionId: "bad", sqliteFn })
  assert.deepEqual(parts, [])
  assert.equal(called, false)
})

test("readSessionTranscript: uses a parameterized text-only query", async () => {
  const captured = { value: "" }
  await readSessionTranscript({
    sessionId: "ses_param11111111",
    dbPath: fakeDbPath(),
    sqliteFn: fakeSqlite([], captured),
    limitParts: 12,
  })
  assert.match(captured.value, /\.param set :sid "ses_param11111111"/)
  assert.match(captured.value, /json_extract\(p\.data, '\$\.type'\) = 'text'/)
  assert.match(captured.value, /LIMIT :limitParts/)
})

test("buildRecallMarkdown: groups parts by message", () => {
  const markdown = buildRecallMarkdown([
    { messageId: "m1", role: "user", messageTime: 1000, partId: "p1", text: "question" },
    { messageId: "m1", role: "user", messageTime: 1000, partId: "p2", text: "more" },
    { messageId: "m2", role: "assistant", messageTime: 2000, partId: "p3", text: "answer" },
  ])
  assert.match(markdown, /## User · 1970-01-01T00:00:01.000Z/)
  assert.match(markdown, /question\n\nmore/)
  assert.match(markdown, /## Assistant · 1970-01-01T00:00:02.000Z/)
  assert.match(markdown, /answer/)
})
