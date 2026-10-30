import { coll, mongoColl } from '../config/mongo'
import { ObjectId, type ClientSession } from 'mongodb'

/** All direct ownership links; instance-only derivatives retain their ids. */
export const PLAYER_COLLECTIONS = [
  'world_instances', 'events', 'memories', 'characters', 'entities', 'personas',
  'generation_logs', 'extractor_raw', 'projection_anomalies', 'signal_ledger',
  'relation_candidates', 'post_process_outbox', 'projection_checkpoints',
  'media_assets', 'media_rejections', 'billing_entitlements', 'store_purchases', 'llm_calls',
] as const
export const TELEMETRY_COLLECTIONS = ['app_events', 'app_sessions', 'app_errors'] as const
export const JOB_USER_FIELDS = ['playerId', 'player_id', 'userId', 'user_id'] as const

/** Only structural identity fields are changed, never player-authored text. */
export function relinkJobData(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map(item => relinkJobData(item, from, to))
  if (!value || typeof value !== 'object' || value instanceof Date || value instanceof ObjectId) return value
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key,
    JOB_USER_FIELDS.some(field => field === key) && inner === from ? to : relinkJobData(inner, from, to),
  ]))
}

export async function moveAccountReferences(from: ObjectId, to: ObjectId, session?: ClientSession): Promise<void> {
  const opts = { session }
  for (const row of await mongoColl.postProcessOutbox().find({ player_id: from }, opts).toArray()) {
    const payload = relinkJobData(row.payload, from.toHexString(), to.toHexString()) as Record<string, unknown>
    await mongoColl.postProcessOutbox().updateOne({ _id: row._id }, { $set: { payload } }, opts)
  }
  for (const name of PLAYER_COLLECTIONS) {
    await coll(name).updateMany({ player_id: from }, { $set: { player_id: to } }, opts)
  }
  await coll('world_templates').updateMany({ creator_id: from }, { $set: { creator_id: to } }, opts)
  for (const name of TELEMETRY_COLLECTIONS) {
    await coll(name).updateMany({ user_id: from }, { $set: { user_id: to } }, opts)
  }
  for (const [name, field] of [['users', 'blocked_user_ids'], ['app_installs', 'user_ids']] as const) {
    // One pipeline update avoids a crash between $pull and $addToSet.
    await coll(name).updateMany({ [field]: from }, [{ $set: {
      [field]: { $setUnion: [{ $map: { input: `$${field}`, as: 'id', in: {
        $cond: [{ $eq: ['$$id', from] }, to, '$$id'],
      } } }, []] },
    } }], opts)
  }
  await coll('projection_checkpoint_chunks').updateMany({ 'docs.player_id': from }, {
    $set: { 'docs.$[owned].player_id': to },
  }, { ...opts, arrayFilters: [{ 'owned.player_id': from }] })
  const reports = await coll('content_reports').find({ $or: [
    { reporter_id: from }, { target_creator_id: from }, { target_type: 'user', target_id: from },
  ] }, opts).toArray()
  reports.sort((a, b) => Number(a.reporter_id?.equals(from)) - Number(b.reporter_id?.equals(from)))
  for (const row of reports) {
    const reporter = row.reporter_id?.equals(from) ? to : row.reporter_id
    const target = row.target_type === 'user' && row.target_id?.equals(from) ? to : row.target_id
    const collision = ['open', 'reviewing'].includes(row.status) && await coll('content_reports').findOne({
      _id: { $ne: row._id }, reporter_id: reporter, target_type: row.target_type, target_id: target, status: { $in: ['open', 'reviewing'] },
    }, opts)
    await coll('content_reports').updateOne({ _id: row._id }, { $set: {
      reporter_id: reporter, target_id: target,
      ...(row.target_creator_id?.equals(from) ? { target_creator_id: to } : {}),
      ...(collision ? { status: 'dismissed' } : {}),
    } }, opts)
  }

  // Preserve every source ledger row without colliding with the target's keys.
  // Reservation references follow their keys, so settlement/release stays linked.
  const prefix = `guest:${from.toHexString()}:`
  for (const row of await coll('ink_ledger').find({ player_id: from }, opts).toArray()) {
    const reference = typeof row.reference === 'string' && /^(reserve|release|settle):/.test(row.reference)
      ? `${prefix}${row.reference}` : row.reference
    await coll('ink_ledger').updateOne({ _id: row._id, player_id: from }, { $set: {
      player_id: to, idempotency_key: `${prefix}${row.idempotency_key}`,
      ...(reference !== undefined ? { reference } : {}),
    } }, opts)
  }
  // A usage slot is an allowance boundary, not an asset identity. On collision
  // keep the target's slot and retain the source history without a live slot.
  for (const row of await coll('media_usage').find({ player_id: from }, opts).toArray()) {
    const collision = row.slot !== undefined && await coll('media_usage').findOne({
      player_id: to, kind: row.kind, day: row.day, slot: row.slot,
    }, opts)
    await coll('media_usage').updateOne({ _id: row._id, player_id: from }, {
      $set: { player_id: to }, ...(collision ? { $unset: { slot: '' } } : {}),
    }, opts)
  }
  for (const row of await mongoColl.deadLetterJobs().find({}, opts).toArray()) {
    const data = relinkJobData(row.data, from.toHexString(), to.toHexString())
    await mongoColl.deadLetterJobs().updateOne({ _id: row._id }, { $set: { data } }, opts)
  }
}

export async function purgeAccountReferences(userId: ObjectId, guest: boolean): Promise<void> {
  // Instance graph, vectors and storage have already gone through deletionService.
  const calls = await coll('llm_calls').find({ player_id: userId }, { projection: { _id: 1 } }).toArray()
  if (calls.length) await coll('llm_call_bodies').deleteMany({ _id: { $in: calls.map(row => row._id) } })
  // Billing and moderation retention is unchanged for signed-in accounts.
  const collections = PLAYER_COLLECTIONS.filter(name => guest || !['billing_entitlements', 'store_purchases'].includes(name))
  for (const name of [...collections, ...(guest ? ['ink_ledger', 'media_usage'] : [])]) {
    await coll(name).deleteMany({ player_id: userId })
  }
  if (guest) await coll('content_reports').deleteMany({ $or: [
    { reporter_id: userId }, { target_creator_id: userId }, { target_type: 'user', target_id: userId },
  ] })
  await mongoColl.users().updateMany({ blocked_user_ids: userId }, { $pull: { blocked_user_ids: userId } })
  for (const row of await mongoColl.deadLetterJobs().find({}).toArray()) {
    const before = JSON.stringify(row.data)
    if (before !== JSON.stringify(relinkJobData(row.data, userId.toHexString(), ''))) {
      await mongoColl.deadLetterJobs().deleteOne({ _id: row._id })
    }
  }
}
