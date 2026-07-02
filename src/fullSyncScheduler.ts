/**
 * Daily full-sync scheduler for local OpenCode configuration.
 *
 * Role: run the existing workstation-bootstrap full sync script once per
 * day at local 20:30 from the dashboard process.
 * Public surface: startFullSyncScheduler(), stopFullSyncScheduler(),
 * isFullSyncSchedulerRunning(), triggerFullSync(), msUntilNextLocalTime().
 * Constraints: fixed argv only; never reads .env / secret files.
 * Read-this-with: src/server.tsx schedulers page and config.ts toggle.
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { getConfig } from "./config.ts"

export const FULL_SYNC_HOUR = 20
export const FULL_SYNC_MINUTE = 30

export const FULL_SYNC_SCRIPT = join(
  homedir(),
  "Developer",
  "infra",
  "workstation-bootstrap",
  "scripts",
  "opencode-cron-sync.sh",
)

export const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface FullSyncResult {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  startedAt: number
  finishedAt: number
}

const OUTPUT_CAP_BYTES = 64 * 1024
let _timer: ReturnType<typeof setTimeout> | null = null
let _lastResult: FullSyncResult | null = null

/** Milliseconds until the next local HH:mm occurrence. */
export function msUntilNextLocalTime(
  hour: number,
  minute: number,
  now: Date = new Date(),
): number {
  const h = Math.max(0, Math.min(23, Math.floor(hour)))
  const m = Math.max(0, Math.min(59, Math.floor(minute)))
  const next = new Date(now)
  next.setHours(h, m, 0, 0)
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1)
  }
  return next.getTime() - now.getTime()
}

/** Run one full sync via the fixed workstation-bootstrap script. */
export function triggerFullSync(opts?: {
  syncScript?: string
  spawnFn?: typeof spawn
  nowFn?: () => number
}): Promise<FullSyncResult> {
  const syncScript = opts?.syncScript ?? FULL_SYNC_SCRIPT
  const sp = opts?.spawnFn ?? spawn
  const startedAt = opts?.nowFn ? opts.nowFn() : Date.now()

  return new Promise<FullSyncResult>((resolve) => {
    if (!existsSync(syncScript)) {
      const result = {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: `Sync script not found: ${syncScript}`,
        startedAt,
        finishedAt: opts?.nowFn ? opts.nowFn() : Date.now(),
      }
      _lastResult = result
      resolve(result)
      return
    }

    let child: ReturnType<typeof spawn>
    try {
      child = sp(syncScript, ["--full"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, OPENCODE_SYNC_SOURCE: "dashboard-full-sync" },
      })
    } catch (err) {
      const result = {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        startedAt,
        finishedAt: opts?.nowFn ? opts.nowFn() : Date.now(),
      }
      _lastResult = result
      resolve(result)
      return
    }

    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length >= OUTPUT_CAP_BYTES) return
      stdout += d.toString("utf-8")
      if (stdout.length > OUTPUT_CAP_BYTES) stdout = stdout.slice(0, OUTPUT_CAP_BYTES)
    })
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length >= OUTPUT_CAP_BYTES) return
      stderr += d.toString("utf-8")
      if (stderr.length > OUTPUT_CAP_BYTES) stderr = stderr.slice(0, OUTPUT_CAP_BYTES)
    })
    child.on("error", (err) => {
      stderr += (stderr ? "\n" : "") + (err instanceof Error ? err.message : String(err))
    })
    child.on("close", (code) => {
      const result = {
        ok: code === 0,
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        startedAt,
        finishedAt: opts?.nowFn ? opts.nowFn() : Date.now(),
      }
      _lastResult = result
      resolve(result)
    })
  })
}

/** Start the daily 20:30 full-sync scheduler. */
export function startFullSyncScheduler(): void {
  if (_timer) return
  scheduleNextFullSync()
}

function scheduleNextFullSync(): void {
  _timer = setTimeout(() => {
    void (async () => {
      const cfg = await getConfig()
      if (cfg.fullSyncSchedule) {
        await triggerFullSync()
      }
    })()
      .catch(() => {})
      .finally(() => {
        _timer = null
        scheduleNextFullSync()
      })
  }, msUntilNextLocalTime(FULL_SYNC_HOUR, FULL_SYNC_MINUTE))
  if (typeof _timer.unref === "function") _timer.unref()
}

/** Stop the daily full-sync scheduler. */
export function stopFullSyncScheduler(): void {
  if (!_timer) return
  clearTimeout(_timer)
  _timer = null
}

/** Whether the daily full-sync scheduler is currently scheduled. */
export function isFullSyncSchedulerRunning(): boolean {
  return _timer !== null
}

/** Last result from triggerFullSync(), if any in this process. */
export function getLastFullSyncResult(): FullSyncResult | null {
  return _lastResult
}
