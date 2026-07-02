/**
 * Tests for `src/opencodeProcessQueue.ts`.
 */

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { PassThrough, type Readable } from "node:stream"

import {
  MAX_ACTIVE_OPENCODE_PROCESSES,
  MAX_ACTIVE_PROCESS_MS,
  _resetOpencodeProcessQueueForTest,
  getOpencodeProcessQueueStatus,
  normalizeTimeoutMs,
  runQueuedOpencodeProcess,
} from "../src/opencodeProcessQueue.ts"

function controllableSpawn(registry: Array<EventEmitter & { stdout: Readable; stderr: Readable; kill: () => boolean; killedFlag: boolean }>) {
  return ((_bin: string, _argv: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: () => boolean
      killedFlag: boolean
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killedFlag = false
    child.kill = () => {
      child.killedFlag = true
      queueMicrotask(() => child.emit("close", null))
      return true
    }
    registry.push(child)
    return child
  }) as any
}

test("normalizeTimeoutMs: caps timeouts at one hour", () => {
  assert.equal(normalizeTimeoutMs(undefined), MAX_ACTIVE_PROCESS_MS)
  assert.equal(normalizeTimeoutMs(MAX_ACTIVE_PROCESS_MS + 1), MAX_ACTIVE_PROCESS_MS)
  assert.equal(normalizeTimeoutMs(1234), 1234)
})

test("runQueuedOpencodeProcess: caps active processes at six", async () => {
  _resetOpencodeProcessQueueForTest()
  const children: Array<EventEmitter & { stdout: Readable; stderr: Readable; kill: () => boolean; killedFlag: boolean }> = []
  const spawnFn = controllableSpawn(children)
  const promises = Array.from({ length: MAX_ACTIVE_OPENCODE_PROCESSES + 1 }, (_, i) =>
    runQueuedOpencodeProcess({ bin: "opencode", args: ["run", String(i)], spawnFn, timeoutMs: 10_000 }),
  )
  assert.equal(children.length, MAX_ACTIVE_OPENCODE_PROCESSES)
  assert.deepEqual(getOpencodeProcessQueueStatus(), { active: MAX_ACTIVE_OPENCODE_PROCESSES, queued: 1 })

  children[0].emit("close", 0)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(children.length, MAX_ACTIVE_OPENCODE_PROCESSES + 1)

  for (const child of children.slice(1)) child.emit("close", 0)
  await Promise.all(promises)
  assert.deepEqual(getOpencodeProcessQueueStatus(), { active: 0, queued: 0 })
})

test("runQueuedOpencodeProcess: kills timed-out processes", async () => {
  _resetOpencodeProcessQueueForTest()
  const children: Array<EventEmitter & { stdout: Readable; stderr: Readable; kill: () => boolean; killedFlag: boolean }> = []
  const result = await runQueuedOpencodeProcess({
    bin: "opencode",
    args: ["run"],
    spawnFn: controllableSpawn(children),
    timeoutMs: 5,
  })
  assert.equal(result.timedOut, true)
  assert.equal(result.exitCode, null)
  assert.equal(children[0].killedFlag, true)
})
