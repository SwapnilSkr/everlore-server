import type Redis from 'ioredis'

/**
 * One string key remains occupied while either turn slot is held. Rewind and
 * exclusive replay still acquire it with SET NX. Chat turns store both owners
 * in that string; only the head owner may refresh its lease.
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

export interface GenerationSlots {
  owner: string
  phase: 'running' | 'tail'
  next?: string
}

export function generationSlots(value: string | null): GenerationSlots | null {
  if (!value?.startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object') return null
    const slots = parsed as GenerationSlots
    return typeof slots.owner === 'string' && (slots.phase === 'running' || slots.phase === 'tail')
      ? slots : null
  } catch { return null }
}

// A single compare-and-swap commits the state, outcome and socket milestone.
// The TTL is preserved on slot changes: a waiting worker must never extend a
// dead predecessor's lease. Completion publishes before making its successor
// runnable, even when different workers are using different Redis connections.
export const GENERATION_LOCK_CAS = `
local current = redis.call("get", KEYS[1])
if (current or "") ~= ARGV[1] then return 0 end
if ARGV[5] ~= "" then redis.call("publish", ARGV[5], ARGV[6]) end
if ARGV[4] ~= "" then redis.call("set", KEYS[2], ARGV[4], "EX", ARGV[7]) end
if ARGV[2] == "" then
  redis.call("del", KEYS[1])
elseif ARGV[3] == "keep" then
  redis.call("set", KEYS[1], ARGV[2], "KEEPTTL")
else
  redis.call("set", KEYS[1], ARGV[2], "EX", ARGV[3])
end
return 1`

type LockRedis = Pick<Redis, 'get' | 'eval'>
const outcomeKey = (key: string, token: string) => `${key}:done:${token}`
async function swap(
  redis: LockRedis, key: string, before: string | null, after: string | null,
  ttl: number | 'keep', token = '', outcome = '', channel = '', frame = '',
): Promise<boolean> {
  return Number(await redis.eval(GENERATION_LOCK_CAS, 2, key, outcomeKey(key, token),
    before || '', after || '', String(ttl), outcome, channel, frame,
    String(GENERATION_LOCK_TTL_SECONDS))) === 1
}

/** null = busy; priorTurnId is captured atomically with reserving the slot.
 * The token is also the queue jobId, assigned BEFORE enqueue (no pending/job
 * replacement race when a fast worker picks a job up immediately). */
export async function acquireGenerationTurn(
  redis: LockRedis, key: string, token: string, overlap: boolean,
): Promise<{ priorTurnId?: string } | null> {
  for (;;) {
    const before = await redis.get(key)
    if (!before) {
      const after = overlap ? JSON.stringify({ owner: token, phase: 'running' }) : token
      if (await swap(redis, key, before, after, GENERATION_LOCK_TTL_SECONDS)) return {}
    } else {
      const slots = generationSlots(before)
      if (!overlap || !slots || slots.phase !== 'tail' || slots.next) return null
      if (await swap(redis, key, before, JSON.stringify({ ...slots, next: token }), 'keep')) {
        return { priorTurnId: slots.owner }
      }
    }
  }
}

export async function markGenerationStreamEnd(
  redis: LockRedis, key: string, token: string, channel: string, frame: string,
): Promise<void> {
  for (;;) {
    const before = await redis.get(key)
    const slots = generationSlots(before)
    if (!slots || slots.owner !== token) throw new Error('Generation lease lost')
    if (await swap(redis, key, before, JSON.stringify({ ...slots, phase: 'tail' }), 'keep',
      '', '', channel, frame)) return
  }
}

/** Success is signalled only AFTER event insert, instance/cache writes and the
 * completion publish. The merged beat ledger is already on the saved event. */
export async function finishGenerationTurn(
  redis: LockRedis, key: string, token: string, success: boolean, channel = '', frame = '',
): Promise<void> {
  for (;;) {
    const before = await redis.get(key)
    const slots = generationSlots(before)
    if (slots?.owner === token) {
      const after = slots.next ? JSON.stringify({ owner: slots.next, phase: 'running' }) : null
      // Promotion starts a live-sized lease even if the waiting worker died.
      if (await swap(redis, key, before, after, GENERATION_LOCK_HEARTBEAT_TTL_SECONDS,
        token, success ? 'saved' : 'failed', channel, frame)) return
    } else if (slots?.next === token) {
      const { next: _next, ...head } = slots
      if (await swap(redis, key, before, JSON.stringify(head), 'keep', token, 'failed')) return
    } else if (before === token) {
      if (await swap(redis, key, before, null, 'keep', token, success ? 'saved' : 'failed', channel, frame)) return
    } else {
      // A stale worker cannot release a new operation's lock or publish success.
      if (success) throw new Error('Generation lease lost')
      return
    }
  }
}

/** Bounded, fail-closed barrier. Missing/expired predecessor outcomes are never
 * inferred from an event that might have been inserted before a failed tail. */
export async function waitForPriorGeneration(
  redis: LockRedis, key: string, token: string, priorTurnId?: string,
  options: { timeoutMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  const now = options.now || Date.now
  const sleep = options.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const startedAt = now()
  const timeoutMs = options.timeoutMs ?? 30_000
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const unavailable = () => new Error('Prior turn unavailable; please try again')
  const wait = async () => {
    for (;;) {
      const before = await redis.get(key)
      if (expired) throw unavailable()
      const slots = generationSlots(before)
      if (slots?.owner !== token && slots?.next !== token) throw unavailable()
      if (!priorTurnId) {
        if (slots.owner !== token) throw new Error('Generation lease lost')
        return 0
      }
      const outcome = await redis.get(outcomeKey(key, priorTurnId))
      if (expired || outcome === 'failed') throw unavailable()
      if (outcome === 'saved' && slots.owner === token) return now() - startedAt
      if (now() - startedAt >= timeoutMs) throw unavailable()
      await sleep(20)
    }
  }
  // Redis can itself be unavailable. A hung GET must not defeat the bound;
  // after the deadline the loop also stops if that command eventually returns.
  try {
    return await Promise.race([
      wait(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { expired = true; reject(unavailable()) }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Only the head refreshes: the waiting slot cannot keep a crashed head alive. */
export async function refreshGenerationLock(redis: LockRedis, key: string, token: string): Promise<void> {
  const before = await redis.get(key)
  if (before === token || generationSlots(before)?.owner === token) {
    await swap(redis, key, before, before, GENERATION_LOCK_HEARTBEAT_TTL_SECONDS)
  }
}

export function startGenerationLockHeartbeat(
  redis: Redis, lockKey: string, expectedValue?: string,
): () => void {
  const refresh = () => {
    const refreshing = expectedValue
      ? refreshGenerationLock(redis, lockKey, expectedValue)
      : redis.expire(lockKey, GENERATION_LOCK_HEARTBEAT_TTL_SECONDS)
    refreshing.catch(() => {})
  }
  refresh()
  const timer = setInterval(refresh, HEARTBEAT_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}

/** Also removes a waiting reservation without disturbing the head owner. */
export async function releaseGenerationLock(redis: LockRedis, lockKey: string, expectedValue: string): Promise<void> {
  await finishGenerationTurn(redis, lockKey, expectedValue, false)
}
