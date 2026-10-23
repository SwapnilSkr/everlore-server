import { mongoColl } from '../../src/config/mongo'
import { parseObjectId, idString } from '../../src/utils/mongo-id'
import { recordAnomaly } from '../../src/utils/record-anomaly'
import { log } from '../../src/utils/logger'
import type { WorldEventDoc } from '../../src/models/world-event.model'

/** Refreshed while extracting AND while waiting for earlier projections. */
export const CHARACTER_PROJECTION_CLAIM_LEASE_MS = 2 * 60_000
export const CHARACTER_PROJECTION_ORDER_BUDGET_MS = 60_000
export const CHARACTER_PROJECTION_MAX_ATTEMPTS = 4
export const CHARACTER_PROJECTION_ORPHAN_GRACE_MS = 15_000

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

/** Fresh unclaimed turns may already have a worker waiting for the front. */
function isPlausiblyOrphaned(event: WorldEventDoc): boolean {
  return !hasLiveProjectionClaim(event) &&
    (Date.now() - new Date(event.created_at).getTime() > CHARACTER_PROJECTION_ORPHAN_GRACE_MS ||
      (event.data.codex_projection_attempts || 0) > 0)
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
    if (prior.data.codex_projection_status !== 'failed' && !isPlausiblyOrphaned(prior)) return
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

/** Waiting workers do not reserve a row: only the front claims work. This lets
 * that owner atomically collect the ready prefix without stealing live claims.
 * Batching is OFF by default (owner, 2026-10-23): bursts are rare and a batched
 * prompt is a second extraction path to keep at quality. Up to 4 when enabled. */
export function characterProjectionBatchMax(): number {
  const value = Number(process.env.CHARACTER_PROJECTION_BATCH_MAX ?? 1)
  return Number.isInteger(value) && value > 0 ? Math.min(value, 4) : 1
}

export async function withCharacterProjection<T>(
  params: ProjectionParams,
  repair: Repair,
  work: (event: WorldEventDoc, assertOwned: () => Promise<void>, timing: CharacterProjectionTiming,
    prepared?: import('../../src/services/character-codex.service').CharacterCodexDelta[]) => Promise<T>,
  timing = new CharacterProjectionTiming(),
  prepareBatch?: (events: WorldEventDoc[], timing: CharacterProjectionTiming) => Promise<Map<number,
    import('../../src/services/character-codex.service').CharacterCodexDelta[]> | undefined>,
): Promise<T | { skipped: string }> {
  const iid = parseObjectId(params.instanceId)
  const eid = parseObjectId(params.eventId)
  const read = () => mongoColl.events().findOne({ _id: eid, instance_id: iid })
  let event = await timing.step('event_read', read)
  const skip = (row: WorldEventDoc | null): string | undefined => {
    if (!row) return 'event_missing'
    if (row.data.codex_projection_status === 'completed') return 'already_projected'
    if (row.data.codex_projection_status === 'failed') return 'failed'
    if (hasLiveProjectionClaim(row)) return 'claimed_by_active_worker'
  }
  let skipped = skip(event)
  if (skipped || !event) return { skipped: skipped! }
  const sequence = event.sequence
  await timing.step('ordering_wait', async () => {
    const startedAt = Date.now()
    const launched = new Set<string>()
    while (true) {
      const current = await read()
      if (skip(current)) break
      const prior = await mongoColl.events().find({
        instance_id: iid, type: { $ne: 'side_chat' }, sequence: { $lt: sequence },
        'data.model_used': { $ne: 'seed' },
        'data.codex_projection_status': { $in: ['pending', 'processing'] },
      }).sort({ sequence: 1 }).limit(1).next()
      if (!prior) break
      if (Date.now() - startedAt >= CHARACTER_PROJECTION_ORDER_BUDGET_MS) {
        await recordAnomaly({
          ...params, eventId: eid, sequence, type: 'stale_scene_state', severity: 'error',
          details: `projection ordering timed out after ${CHARACTER_PROJECTION_ORDER_BUDGET_MS}ms waiting for sequence ${prior.sequence}`,
        })
        log.warn('projection.order_timeout', { instanceId: params.instanceId, sequence, prior_sequence: prior.sequence })
        break
      }
      const priorId = idString(prior._id)
      if (isPlausiblyOrphaned(prior) && !launched.has(priorId)) {
        launched.add(priorId)
        repairInBackground({ ...params, eventId: priorId }, repair)
      }
      await sleep(Math.min(120, CHARACTER_PROJECTION_ORDER_BUDGET_MS - (Date.now() - startedAt)))
    }
  })
  event = await read()
  skipped = skip(event)
  if (skipped || !event) return { skipped: skipped! }

  type Claim = { event: WorldEventDoc; claimedAt: Date }
  const claims: Claim[] = []
  const ownedFilter = (claim: Claim) => ({ _id: claim.event._id, instance_id: iid,
    'data.codex_projection_claimed_at': claim.claimedAt, 'data.codex_projection_status': 'processing' })
  const claimEvent = async (row: WorldEventDoc): Promise<boolean> => {
    const claimedAt = new Date(Date.now())
    const result = await timing.step('claim', () => mongoColl.events().updateOne({
      _id: row._id, instance_id: iid,
      'data.codex_projection_status': { $nin: ['completed', 'failed'] },
      $or: [
        { 'data.codex_projection_claimed_at': { $exists: false } },
        { 'data.codex_projection_claimed_at': { $lte: new Date(Date.now() - CHARACTER_PROJECTION_CLAIM_LEASE_MS) } },
      ],
    }, { $set: { 'data.codex_projection_claimed_at': claimedAt, 'data.codex_projection_status': 'processing' } }))
    if (result.modifiedCount !== 1) return false
    claims.push({ event: row, claimedAt })
    return true
  }
  if (!(await claimEvent(event))) return { skipped: skip(await read()) || 'claimed_by_active_worker' }
  let lost = false
  let heartbeat: Promise<void> = Promise.resolve()
  const timer = setInterval(() => {
    heartbeat = heartbeat.then(async () => {
      for (const claim of claims) {
        const next = new Date(Math.max(Date.now(), claim.claimedAt.getTime() + 1))
        const renewed = await mongoColl.events().updateOne(ownedFilter(claim), { $set: { 'data.codex_projection_claimed_at': next } })
        if (renewed.matchedCount !== 1) lost = true
        else claim.claimedAt = next
      }
    }).catch(() => { lost = true })
  }, CHARACTER_PROJECTION_CLAIM_LEASE_MS / 4)
  const assertOwned = async () => {
    await heartbeat
    for (const claim of claims) {
      if (lost || !(await mongoColl.events().findOne(ownedFilter(claim)))) throw new Error('Character projection claim lost')
    }
  }
  try {
    if (prepareBatch && characterProjectionBatchMax() > 1 && !event.data.codex_deltas) {
      const later = await mongoColl.events().find({
        instance_id: iid, type: { $ne: 'side_chat' }, sequence: { $gt: sequence },
        'data.model_used': { $ne: 'seed' }, 'data.codex_projection_status': { $in: ['pending', 'processing'] },
      }).sort({ sequence: 1 }).limit(characterProjectionBatchMax() - 1).toArray()
      for (const row of later) {
        if (claims.length >= characterProjectionBatchMax()) break
        // Stop at a gap, never overtake inputs still being materialized, a
        // ledgered retry, or a live owner (including a timeout escapee).
        if (!Array.isArray(row.data.present_characters) || typeof row.data.ai_response !== 'string' ||
          typeof row.data.player_input !== 'string' || row.data.codex_deltas || hasLiveProjectionClaim(row)) break
        if (!(await claimEvent(row))) break
      }
    }
    const prepared = claims.length > 1 ? await prepareBatch!(claims.map((c) => c.event), timing) : undefined
    let result!: T
    for (const claim of claims) {
      const assertCanApply = async () => {
        await assertOwned()
        // Ledgered retries only finish derived work; no new card mutation.
        if (claim.event.data.codex_deltas) return
        const overtaken = await mongoColl.events().findOne({
          instance_id: iid, sequence: { $gt: claim.event.sequence }, 'data.codex_deltas': { $exists: true },
        })
        if (overtaken) {
          await recordAnomaly({
            ...params, eventId: claim.event._id, sequence: claim.event.sequence,
            type: 'stale_scene_state', severity: 'error',
            details: `late projection sequence ${claim.event.sequence} overtaken by sequence ${overtaken.sequence}; deltas rejected`,
          })
          throw new Error(`Character projection overtaken by sequence ${overtaken.sequence}`)
        }
      }
      result = await work(claim.event, () => timing.step('ownership_check', assertCanApply), timing,
        prepared?.get(claim.event.sequence))
    }
    clearInterval(timer)
    await timing.step('claim_flush', async () => { await heartbeat; await assertOwned() })
    // Retain the front barrier through ALL applications and derived work. Close
    // the prefix backwards so no observer sees a front gap during completion.
    for (const claim of [...claims].reverse()) {
      const completed = await mongoColl.events().updateOne(ownedFilter(claim), {
        $set: { 'data.codex_projection_status': 'completed', 'data.codex_projection_completed_at': new Date(),
          'data.codex_projection_ms': { ...timing.snapshot(), ...(claims.length > 1
            ? { batch_size: claims.length, batch_leader_sequence: sequence } : {}) } },
        $unset: { 'data.codex_projection_claimed_at': '', 'data.codex_projection_error': '', 'data.codex_projection_attempts': '' },
      })
      if (completed.matchedCount !== 1) throw new Error('Character projection claim lost at completion')
    }
    return result
  } catch (err) {
    clearInterval(timer)
    await heartbeat
    for (const claim of claims) {
      const attempts = (Number(claim.event.data.codex_projection_attempts) || 0) + 1
      const poisoned = attempts >= CHARACTER_PROJECTION_MAX_ATTEMPTS
      await mongoColl.events().updateOne(ownedFilter(claim), {
        $set: { 'data.codex_projection_status': poisoned ? 'failed' : 'pending',
          'data.codex_projection_error': String(err), 'data.codex_projection_attempts': attempts },
        $unset: { 'data.codex_projection_claimed_at': '' },
      })
      await recordAnomaly({ ...params, eventId: claim.event._id, sequence: claim.event.sequence,
        type: 'projection_failed', severity: poisoned ? 'error' : 'warn',
        details: `attempt ${attempts}/${CHARACTER_PROJECTION_MAX_ATTEMPTS}: ${String(err)}` })
    }
    throw err
  } finally {
    clearInterval(timer)
  }
}
