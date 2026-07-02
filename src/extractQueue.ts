/**
 * Per-requirement delay queue for smart extract jobs.
 *
 * Role: prevent multiple sessions bound to the same requirement from
 * being extracted simultaneously, which could cause conflicting file
 * writes. When a second extract is requested within `EXTRACT_QUEUE_GAP_MS`
 * of the last one for the same requirement, it is queued and
 * automatically fired after the gap expires.
 *
 * Public surface:
 *   - enqueueAutoExtract(opts) → { status, jobId?, scheduledAt?, delayMs? }
 *   - EXTRACT_QUEUE_GAP_MS
 *   - getQueueStatus(reqId) → for debugging/UI
 *   - _resetExtractQueueForTest()
 *
 * Constraints / safety:
 *   - In-memory only; queued items are lost on server restart. This is
 *     acceptable — the user can re-trigger and the gap is short (5 min).
 *   - Queue key is `reqId` (per-requirement), not per-session.
 *   - FIFO ordering within a requirement.
 *   - Queued items that conflict at fire time (e.g. session already has
 *     a running job) are silently skipped.
 *
 * Read-this-with:
 *   - `src/extractJobs.ts` (createExtractJob — the job spawn mechanism).
 *   - `src/server.tsx` (the /api/requirement/auto-extract route).
 */

import {
  createExtractJob,
  JobConflictError,
  type ExtractJob,
} from "./extractJobs.ts"
import { createNotification } from "./notifications.ts"

/** Minimum gap between extract jobs for the same requirement. */
export const EXTRACT_QUEUE_GAP_MS = 5 * 60 * 1000

export interface EnqueueOptions {
  reqId: string
  sessionId: string
  prompt: string
  model: string
  autoAdopt?: boolean
  reqDir?: string
}

export interface EnqueueResult {
  status: "immediate" | "queued"
  jobId?: string
  /** When the queued job is expected to fire (ms epoch). */
  scheduledAt?: number
  /** Delay in ms from now until scheduledAt. */
  delayMs?: number
  /** Position in queue (0 = next). Only for queued items. */
  queuePosition?: number
}

interface QueueEntry extends EnqueueOptions {
  enqueuedAt: number
  scheduledAt: number
}

interface QueueState {
  /** Earliest time the next extract can start for this reqId. */
  nextAvailableAt: number
  queue: QueueEntry[]
  timer: ReturnType<typeof setTimeout> | null
}

const _queues = new Map<string, QueueState>()

/**
 * Enqueue an auto-extract job. If the requirement's queue is empty and
 * the gap has passed since the last extract, the job starts immediately.
 * Otherwise it is queued and fired automatically after the gap.
 *
 * Throws `JobConflictError` only in the immediate path (so the route
 * handler can return 409). Queued items that conflict at fire time are
 * silently skipped.
 */
export function enqueueAutoExtract(opts: EnqueueOptions): EnqueueResult {
  const now = Date.now()
  let state = _queues.get(opts.reqId)

  if (!state) {
    state = { nextAvailableAt: 0, queue: [], timer: null }
    _queues.set(opts.reqId, state)
  }

  // If the gap has passed, fire immediately.
  if (now >= state.nextAvailableAt) {
    state.nextAvailableAt = now + EXTRACT_QUEUE_GAP_MS
    const job = createExtractJob({
      reqId: opts.reqId,
      sessionId: opts.sessionId,
      prompt: opts.prompt,
      mode: "auto",
      model: opts.model,
      autoAdopt: opts.autoAdopt ?? false,
      reqDir: opts.reqDir,
    })
    return { status: "immediate", jobId: job.id }
  }

  // Queue it — calculate when this item can fire.
  const scheduledAt = state.nextAvailableAt
  const entry: QueueEntry = {
    ...opts,
    enqueuedAt: now,
    scheduledAt,
  }
  state.queue.push(entry)
  state.nextAvailableAt += EXTRACT_QUEUE_GAP_MS

  const queuePosition = state.queue.length - 1
  const delayMs = scheduledAt - now

  // Notify the user that the extract has been queued.
  createNotification({
    type: "extract",
    title: "⏳ 智能提取已排队",
    subtitle: `session ${opts.sessionId} · 预计 ${Math.round(delayMs / 60_000)} 分钟后自动开始`,
    state: "running",
    reqId: opts.reqId,
    sessionId: opts.sessionId,
    actionHref: null,
  })

  // Schedule timer if not already running.
  if (!state.timer) {
    scheduleNext(opts.reqId)
  }

  return { status: "queued", scheduledAt, delayMs, queuePosition }
}

/**
 * Schedule the next queued item for `reqId` to fire.
 * Called after enqueueing (if no timer is active) and after a queued
 * item fires (if more items remain).
 */
function scheduleNext(reqId: string): void {
  const state = _queues.get(reqId)
  if (!state || state.queue.length === 0) return

  const entry = state.queue[0]
  const delay = Math.max(0, entry.scheduledAt - Date.now())

  state.timer = setTimeout(() => {
    void fireQueued(reqId)
  }, delay)

  if (typeof state.timer.unref === "function") state.timer.unref()
}

/**
 * Fire the oldest queued item for `reqId`. If the job conflicts (e.g.
 * the session already has a running job), the item is silently skipped.
 * After firing, schedules the next item if any remain.
 */
async function fireQueued(reqId: string): Promise<void> {
  const state = _queues.get(reqId)
  if (!state) return
  state.timer = null

  const entry = state.queue.shift()
  if (!entry) {
    // Queue is empty — clean up.
    _queues.delete(reqId)
    return
  }

  try {
    createExtractJob({
      reqId: entry.reqId,
      sessionId: entry.sessionId,
      prompt: entry.prompt,
      mode: "auto",
      model: entry.model,
      autoAdopt: entry.autoAdopt ?? false,
      reqDir: entry.reqDir,
    })
  } catch {
    // JobConflictError or other — skip this queued item silently.
    // The notification from createExtractJob won't fire, but the queue
    // notification ("⏳ 已排队") was already shown. We could update it
    // here, but the simplest approach is to let it be dismissed by the
    // user or expire via TTL.
  }

  // Schedule next if more items in queue, otherwise clean up.
  if (state.queue.length > 0) {
    scheduleNext(reqId)
  } else {
    _queues.delete(reqId)
  }
}

/**
 * Return the current queue status for a requirement (for debugging/UI).
 */
export function getQueueStatus(reqId: string): {
  queueLength: number
  nextAvailableAt: number
} | null {
  const state = _queues.get(reqId)
  if (!state) return null
  return {
    queueLength: state.queue.length,
    nextAvailableAt: state.nextAvailableAt,
  }
}

/** Test-only: reset all queue state. */
export function _resetExtractQueueForTest(): void {
  for (const state of _queues.values()) {
    if (state.timer) clearTimeout(state.timer)
  }
  _queues.clear()
}
