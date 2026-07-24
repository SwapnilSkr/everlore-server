import type Redis from 'ioredis'

/**
 * Per-instance turn lock. One generation (chat / continue / side_chat / replay)
 * runs at a time per player+instance. Shared by the WS dispatch seam (which
 * acquires it) and the worker (which keeps it alive while a turn runs).
 */

/** TTL set at dispatch — must cover queue wait AND the turn itself, since the
 *  worker may not pick the job up immediately under load. */
export const GENERATION_LOCK_TTL_SECONDS = 240

/** TTL the worker holds while ACTIVELY processing. Shorter than the dispatch
 *  TTL so a crashed/killed worker frees the player within this window instead
 *  of soft-locking them for the full dispatch TTL. */
export const GENERATION_LOCK_HEARTBEAT_TTL_SECONDS = 90

/** How often the worker refreshes the lock while a turn runs. Must be well
 *  below the heartbeat TTL so a healthy turn never lets the lock lapse. */
const HEARTBEAT_INTERVAL_MS = 30_000

export function generationLockKey(playerId: string, instanceId: string): string {
  return `lock:gen:${playerId}:${instanceId}`
}

/**
 * Refresh the generation lock on an interval while a turn is processing, and
 * return a stop function to call when it finishes (success OR failure).
 *
 * On pickup we immediately bring the (dispatch-sized) TTL down to the live
 * heartbeat window: if this process then dies, the interval stops with it and
 * the lock expires within GENERATION_LOCK_HEARTBEAT_TTL_SECONDS rather than
 * hanging for the full dispatch TTL.
 */
export function startGenerationLockHeartbeat(
  redis: Redis,
  lockKey: string,
  expectedValue?: string,
): () => void {
  const refresh = () => {
    const refreshLock = expectedValue
      ? redis.eval(
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], ARGV[2]) end return 0',
          1,
          lockKey,
          expectedValue,
          String(GENERATION_LOCK_HEARTBEAT_TTL_SECONDS),
        )
      : redis.expire(lockKey, GENERATION_LOCK_HEARTBEAT_TTL_SECONDS)
    refreshLock.catch(() => {
      // Transient Redis blip; the next tick (or the dispatch TTL) covers us.
    })
  }
  refresh()
  const timer = setInterval(refresh, HEARTBEAT_INTERVAL_MS)
  // The heartbeat must never keep the process alive on its own.
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}

/** Release only the lock acquired by this operation; never delete a newer lock
 * that may have been acquired after an expiry/race. */
export async function releaseGenerationLock(
  redis: Redis,
  lockKey: string,
  expectedValue: string,
): Promise<void> {
  await redis.eval(
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0',
    1,
    lockKey,
    expectedValue,
  )
}
