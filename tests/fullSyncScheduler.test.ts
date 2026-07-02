/**
 * Tests for `src/fullSyncScheduler.ts`.
 */

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { PassThrough, type Readable } from "node:stream"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  FULL_SYNC_HOUR,
  FULL_SYNC_MINUTE,
  msUntilNextLocalTime,
  triggerFullSync,
} from "../src/fullSyncScheduler.ts"

function fakeScriptPath(): string {
  const path = join(mkdtempSync(join(tmpdir(), "full-sync-script-")), "opencode-cron-sync.sh")
  writeFileSync(path, "#!/usr/bin/env bash\n", "utf-8")
  return path
}

function fakeSpawn(opts: { code: number | null; stdout?: string; stderr?: string; captured?: { argv?: string[]; env?: NodeJS.ProcessEnv } }) {
  return ((_bin: string, argv: string[], spawnOpts?: { env?: NodeJS.ProcessEnv }) => {
    opts.captured!.argv = argv
    opts.captured!.env = spawnOpts?.env
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: () => boolean
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    setTimeout(() => {
      if (opts.stdout) child.stdout.push(opts.stdout)
      if (opts.stderr) child.stderr.push(opts.stderr)
      child.stdout.push(null)
      child.stderr.push(null)
      child.emit("close", opts.code)
    }, 0)
    return child
  }) as any
}

test("msUntilNextLocalTime: computes same-day 20:30 delay", () => {
  const now = new Date(2026, 6, 1, 20, 0, 0, 0)
  assert.equal(msUntilNextLocalTime(FULL_SYNC_HOUR, FULL_SYNC_MINUTE, now), 30 * 60 * 1000)
})

test("msUntilNextLocalTime: rolls to next day after 20:30", () => {
  const now = new Date(2026, 6, 1, 20, 31, 0, 0)
  assert.equal(msUntilNextLocalTime(20, 30, now), (23 * 60 + 59) * 60 * 1000)
})

test("triggerFullSync: runs fixed full-sync command", async () => {
  const captured: { argv?: string[]; env?: NodeJS.ProcessEnv } = {}
  const result = await triggerFullSync({
    syncScript: fakeScriptPath(),
    spawnFn: fakeSpawn({ code: 0, stdout: "ok", captured }),
    nowFn: () => 1000,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(captured.argv, ["--full"])
  assert.equal(captured.env?.OPENCODE_SYNC_SOURCE, "dashboard-full-sync")
})

test("triggerFullSync: returns failure when script is missing", async () => {
  const result = await triggerFullSync({ syncScript: "/tmp/opencode/missing-full-sync-script" })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /not found/)
})
