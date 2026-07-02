/**
 * Global queue for dashboard-owned OpenCode child processes.
 *
 * Role: cap concurrent dashboard-launched OpenCode work at six jobs and
 * kill any active job after one hour so stuck sessions cannot starve the
 * queue. This covers child_process based `opencode run --fork` jobs and
 * non-interactive `opencode run` background jobs; embedded PTY sessions
 * remain user-attached and are managed by terminal.ts.
 *
 * Public surface:
 *   - runQueuedOpencodeProcess(opts): enqueue and run one process
 *   - getOpencodeProcessQueueStatus(): counters for UI/tests
 *   - _resetOpencodeProcessQueueForTest(): test-only cleanup
 *
 * Constraints / safety: fixed argv supplied by callers, no shell.
 * Read-this-with: src/sessionExtract.ts and src/server.tsx new-session flow.
 */

import { spawn, type ChildProcess } from "node:child_process"

export const MAX_ACTIVE_OPENCODE_PROCESSES = 6
export const MAX_ACTIVE_PROCESS_MS = 60 * 60 * 1000

export interface QueuedOpencodeProcessOptions {
  bin: string
  args: string[]
  spawnOptions?: Parameters<typeof spawn>[2]
  timeoutMs?: number
  spawnFn?: typeof spawn
  onSpawn?: (child: ChildProcess) => void
  onQueued?: (position: number) => void
}

export interface QueuedOpencodeProcessResult {
  stdout: string
  stderr: string
  exitCode: number | null
  durationMs: number
  timedOut: boolean
  queuedMs: number
}

interface QueueItem {
  opts: QueuedOpencodeProcessOptions
  enqueuedAt: number
  resolve: (result: QueuedOpencodeProcessResult) => void
  reject: (err: unknown) => void
}

const STDOUT_CAP_BYTES = 256 * 1024
const STDERR_CAP_BYTES = 16 * 1024

let activeCount = 0
const queue: QueueItem[] = []
const activeChildren = new Set<ChildProcess>()

/** Enqueue one dashboard-owned OpenCode process under the global cap. */
export function runQueuedOpencodeProcess(
  opts: QueuedOpencodeProcessOptions,
): Promise<QueuedOpencodeProcessResult> {
  return new Promise((resolve, reject) => {
    const item: QueueItem = { opts, enqueuedAt: Date.now(), resolve, reject }
    queue.push(item)
    opts.onQueued?.(queue.length)
    drainQueue()
  })
}

function drainQueue(): void {
  while (activeCount < MAX_ACTIVE_OPENCODE_PROCESSES && queue.length > 0) {
    const item = queue.shift()!
    startItem(item)
  }
}

function startItem(item: QueueItem): void {
  activeCount++
  const startedAt = Date.now()
  const sp = item.opts.spawnFn ?? spawn
  let child: ChildProcess
  try {
    child = sp(item.opts.bin, item.opts.args, item.opts.spawnOptions ?? { stdio: ["ignore", "pipe", "pipe"] })
  } catch (err) {
    activeCount--
    item.reject(err)
    drainQueue()
    return
  }

  activeChildren.add(child)
  item.opts.onSpawn?.(child)

  let stdout = ""
  let stderr = ""
  let timedOut = false
  const timeoutMs = normalizeTimeoutMs(item.opts.timeoutMs)
  const timer = setTimeout(() => {
    timedOut = true
    try { child.kill("SIGKILL") } catch { /* noop */ }
  }, timeoutMs)
  if (typeof timer.unref === "function") timer.unref()

  child.stdout?.on("data", (chunk: Buffer) => {
    if (stdout.length >= STDOUT_CAP_BYTES) return
    stdout += chunk.toString("utf-8")
    if (stdout.length > STDOUT_CAP_BYTES) stdout = stdout.slice(0, STDOUT_CAP_BYTES)
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length >= STDERR_CAP_BYTES) return
    stderr += chunk.toString("utf-8")
    if (stderr.length > STDERR_CAP_BYTES) stderr = stderr.slice(0, STDERR_CAP_BYTES)
  })
  child.on("error", (err) => {
    stderr += (stderr ? "\n" : "") + (err instanceof Error ? err.message : String(err))
  })
  child.on("close", (code) => {
    clearTimeout(timer)
    activeChildren.delete(child)
    activeCount--
    item.resolve({
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: code,
      durationMs: Date.now() - startedAt,
      timedOut,
      queuedMs: startedAt - item.enqueuedAt,
    })
    drainQueue()
  })
}

/** Clamp any dashboard-owned process timeout to the one-hour hard cap. */
export function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return MAX_ACTIVE_PROCESS_MS
  return Math.min(Math.floor(timeoutMs), MAX_ACTIVE_PROCESS_MS)
}

/** Return current queue counters. */
export function getOpencodeProcessQueueStatus(): { active: number; queued: number } {
  return { active: activeCount, queued: queue.length }
}

/** Test-only cleanup. Kills active children and clears waiting work. */
export function _resetOpencodeProcessQueueForTest(): void {
  queue.length = 0
  for (const child of activeChildren) {
    try { child.kill("SIGKILL") } catch { /* noop */ }
  }
  activeChildren.clear()
  activeCount = 0
}
