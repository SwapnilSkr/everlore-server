import { mongoColl } from '../../src/config/mongo'
import { parseObjectId, idString } from '../../src/utils/mongo-id'
import { recordAnomaly } from '../../src/utils/record-anomaly'
import { log } from '../../src/utils/logger'
import type { WorldEventDoc } from '../../src/models/world-event.model'

/** Refreshed while extracting AND while waiting for earlier projections. */
export const CHARACTER_PROJECTION_CLAIM_LEASE_MS = 2 * 60_000
export const CHARACTER_PROJECTION_ORDER_BUDGET_MS = 60_000
export const CHARACTER_PROJECTION_MAX_ATTEMPTS = 4

/** Sequential, non-overlapping spans; repeated loop steps accumulate. */
export class CharacterProjectionTiming {
  private readonly startedAt = Date.now()
  private readonly steps: Record<string, number> = {}

  async step<T>(name: string, work: () => Promise<T>): Promise<T> {
    const startedAt = Date.now()
    try { return await work() }
    finally { this.add(name, Date.now() - startedAt) }
  }

  private add(name: string, ms: number): void {
    this.steps[name] = (this.steps[name] || 0) + Math.max(0, Math.floor(ms))
  }

  /** onRaw marks the boundary between the first model call and the separate
   * bond adjudication. The latter span also includes deterministic validation. */
  async extract<T>(work: (onRaw: (raw: string) => void) => Promise<T>): Promise<T> {
    let startedAt = Date.now()
    let name = 'extractor_call'
    try {
      return await work(() => {
        this.add(name, Date.now() - startedAt)
        startedAt = Date.now()
        name = 'bond_adjudication'
      })
    } finally { this.add(name, Date.now() - startedAt) }
  }

  snapshot(): Record<string, number> {
    return { ...this.steps, total: Math.max(0, Date.now() - this.startedAt) }
  }
}

type ProjectionParams = { instanceId: string; playerId: string; eventId: string }
type Repair = (params: ProjectionParams) => Promise<unknown>
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function projectionClaimAge(event: WorldEventDoc): number | undefined {
  const claimedAt = event.data.codex_projection_claimed_at
  if (!claimedAt) return undefined
  const age = Date.now() - new Date(claimedAt).getTime()
  return Number.isFinite(age) ? Math.max(0, age) : undefined
}

export function hasLiveProjectionClaim(event: WorldEventDoc): boolean {
  const age = projectionClaimAge(event)
  return age !== undefined && age < CHARACTER_PROJECTION_CLAIM_LEASE_MS
}

/** Repairs are owned promises, not a timed race that obscures their outcome. */
function repairInBackground(params: ProjectionParams, repair: Repair): void {
  void repair(params).then((result) => {
    log.info('projection.fence_repair_finished', { ...params, result })
  }).catch((err: unknown) => {
    log.warn('projection.fence_repair_failed', { ...params, reason: String(err) })
  })
}

/** The narrator never waits for card extraction. Ordering belongs to the tail. */
export async function fenceOnPriorProjection(
  params: { instanceId: string; playerId: string }, repair: Repair,
): Promise<void> {
  try {
    const prior = await mongoColl.events().find({
      instance_id: parseObjectId(params.instanceId), type: { $ne: 'side_chat' },
    }).sort({ sequence: -1 }).limit(1).next()
    if (!prior || prior.data.model_used === 'seed' || !prior.data.codex_projection_status ||
      prior.data.codex_projection_status === 'completed') return
    if (prior.data.codex_projection_status === 'processing' && hasLiveProjectionClaim(prior)) {
      log.info('projection.fence_inflight', {
        instanceId: params.instanceId, sequence: prior.sequence, claim_age_ms: projectionClaimAge(prior),
      })
      return
    }
    if (prior.data.codex_projection_status !== 'failed') {
      repairInBackground({ ...params, eventId: idString(prior._id) }, repair)
      log.info('projection.fence_repair_started', { instanceId: params.instanceId, sequence: prior.sequence })
    }
    await recordAnomaly({
      ...params, eventId: prior._id, sequence: prior.sequence, type: 'stale_scene_state', severity: 'warn',
      details: `background repair: prior projection is '${prior.data.codex_projection_status}'`,
    })
  } catch (err) {
    log.warn('projection.fence_error', { instanceId: params.instanceId, reason: String(err) })
  }
}

/** Both owners use the same per-event CAS and sequence barrier. A pending lower
 * sequence counts too: merely waiting on the newest processing row misses gaps. */
export async function withCharacterProjection<T>(
  params: ProjectionParams,
  repair: Repair,
  work: (event: WorldEventDoc, assertOwned: () => Promise<void>, timing: CharacterProjectionTiming) => Promise<T>,
  timing = new CharacterProjectionTiming(),
): Promise<T | { skipped: string }> {
  const iid = parseObjectId(params.instanceId)
  const eid = parseObjectId(params.eventId)
  const event = await timing.step('event_read', () => mongoColl.events().findOne({ _id: eid, instance_id: iid }))
  if (!event) return { skipped: 'event_missing' }
  if (event.data.codex_projection_status === 'completed') return { skipped: 'already_projected' }
  if (event.data.codex_projection_status === 'failed') return { skipped: 'failed' }
  let claimedAt = new Date(Date.now())
  const claim = await timing.step('claim', () => mongoColl.events().updateOne({
    _id: eid, instance_id: iid,
    'data.codex_projection_status': { $nin: ['completed', 'failed'] },
    $or: [
      { 'data.codex_projection_claimed_at': { $exists: false } },
      { 'data.codex_projection_claimed_at': { $lte: new Date(Date.now() - CHARACTER_PROJECTION_CLAIM_LEASE_MS) } },
    ],
  }, { $set: { 'data.codex_projection_claimed_at': claimedAt, 'data.codex_projection_status': 'processing' } }))
  if (claim.modifiedCount !== 1) {
    const latest = await mongoColl.events().findOne({ _id: eid })
    return { skipped: latest?.data.codex_projection_status === 'completed' ? 'already_projected' : 'claimed_by_active_worker' }
  }

  const ownedFilter = () => ({ _id: eid, 'data.codex_projection_claimed_at': claimedAt, 'data.codex_projection_status': 'processing' })
  let lost = false
  let heartbeat: Promise<void> = Promise.resolve()
  const timer = setInterval(() => {
    heartbeat = heartbeat.then(async () => {
      const next = new Date(Math.max(Date.now(), claimedAt.getTime() + 1))
      const renewed = await mongoColl.events().updateOne(ownedFilter(), { $set: { 'data.codex_projection_claimed_at': next } })
      if (renewed.matchedCount !== 1) lost = true
      else claimedAt = next
    }).catch(() => { lost = true })
  }, CHARACTER_PROJECTION_CLAIM_LEASE_MS / 4)
  const assertOwned = async () => {
    await heartbeat
    if (lost || !(await mongoColl.events().findOne(ownedFilter()))) throw new Error('Character projection claim lost')
  }

  try {
    await timing.step('ordering_wait', async () => {
      const startedAt = Date.now()
      const launched = new Set<string>()
      while (true) {
        await assertOwned()
        const prior = await mongoColl.events().find({
          instance_id: iid, type: { $ne: 'side_chat' }, sequence: { $lt: event.sequence },
          'data.model_used': { $ne: 'seed' },
          'data.codex_projection_status': { $in: ['pending', 'processing'] },
        }).sort({ sequence: 1 }).limit(1).next()
        if (!prior) break
        if (Date.now() - startedAt >= CHARACTER_PROJECTION_ORDER_BUDGET_MS) {
          await recordAnomaly({
            ...params, eventId: eid, sequence: event.sequence, type: 'stale_scene_state', severity: 'error',
            details: `projection ordering timed out after ${CHARACTER_PROJECTION_ORDER_BUDGET_MS}ms waiting for sequence ${prior.sequence}`,
          })
          log.warn('projection.order_timeout', { instanceId: params.instanceId, sequence: event.sequence, prior_sequence: prior.sequence })
          break
        }
        const priorId = idString(prior._id)
        if (!hasLiveProjectionClaim(prior) && !launched.has(priorId)) {
          launched.add(priorId)
          repairInBackground({ ...params, eventId: priorId }, repair)
        }
        await sleep(Math.min(120, CHARACTER_PROJECTION_ORDER_BUDGET_MS - (Date.now() - startedAt)))
      }
    })
    // A previous attempt may have ledgered its deltas before a graph/publish
    // failure. Never extract/apply them twice, but do close its status/claim.
    const assertCanApply = async () => {
      await assertOwned()
      const overtaken = await mongoColl.events().findOne({
        instance_id: iid, sequence: { $gt: event.sequence }, 'data.codex_deltas': { $exists: true },
      })
      if (overtaken) throw new Error(`Character projection overtaken by sequence ${overtaken.sequence}`)
    }
    const result = await work(event, () => timing.step('ownership_check', assertCanApply), timing)
    clearInterval(timer)
    await timing.step('claim_flush', async () => { await heartbeat; await assertOwned() })
    const completed = await mongoColl.events().updateOne(ownedFilter(), {
      $set: { 'data.codex_projection_status': 'completed', 'data.codex_projection_completed_at': new Date(), 'data.codex_projection_ms': timing.snapshot() },
      $unset: { 'data.codex_projection_claimed_at': '', 'data.codex_projection_error': '', 'data.codex_projection_attempts': '' },
    })
    if (completed.matchedCount !== 1) throw new Error('Character projection claim lost at completion')
    return result
  } catch (err) {
    clearInterval(timer)
    await heartbeat
    const attempts = (Number(event.data.codex_projection_attempts) || 0) + 1
    const poisoned = attempts >= CHARACTER_PROJECTION_MAX_ATTEMPTS
    await mongoColl.events().updateOne(ownedFilter(), {
      $set: {
        'data.codex_projection_status': poisoned ? 'failed' : 'pending',
        'data.codex_projection_error': String(err), 'data.codex_projection_attempts': attempts,
      },
      $unset: { 'data.codex_projection_claimed_at': '' },
    })
    await recordAnomaly({
      ...params, eventId: eid, sequence: event.sequence, type: 'projection_failed', severity: poisoned ? 'error' : 'warn',
      details: `attempt ${attempts}/${CHARACTER_PROJECTION_MAX_ATTEMPTS}: ${String(err)}`,
    })
    throw err
  } finally {
    clearInterval(timer)
  }
}
