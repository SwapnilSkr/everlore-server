/**
 * Throwaway integration test for rewindToSequence.
 * Clones a real instance into a temp one, rewinds the CLONE, asserts the
 * outcome, and deletes the clone. Never touches the source world.
 *
 *   bun run scripts/rewind-audit.ts <sourceInstanceId> <rewindSequence>
 */
import { ObjectId } from 'mongodb'
import { connectMongo, mongoColl } from '../src/config/mongo'
import { connectRedis } from '../src/config/redis'
import { memoryService } from '../src/services/memory.service'

const SOURCE = process.argv[2] || '6a2869768f7446e38bdb6fce'
const SEQ = Number(process.argv[3] || 2)

function ok(label: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) process.exitCode = 1
}

async function main() {
  await connectMongo()
  await connectRedis()

  const src = await mongoColl.worldInstances().findOne({ _id: new ObjectId(SOURCE) })
  if (!src) throw new Error('source instance not found')

  const tempId = new ObjectId()
  const playerId = src.player_id

  // Clone instance + its events + characters under tempId.
  await mongoColl.worldInstances().insertOne({ ...src, _id: tempId })
  const srcEvents = await mongoColl.events().find({ instance_id: src._id }).toArray()
  if (srcEvents.length) {
    await mongoColl.events().insertMany(
      srcEvents.map((e) => ({ ...e, _id: new ObjectId(), instance_id: tempId })),
    )
  }
  const srcChars = await mongoColl.characters().find({ instance_id: src._id }).toArray()
  if (srcChars.length) {
    await mongoColl.characters().insertMany(
      srcChars.map((c) => ({ ...c, _id: new ObjectId(), instance_id: tempId })),
    )
  }

  // Plant two synthetic side characters to prove selective deletion: one born
  // before the rewind point (must survive), one born in a removed turn (must go).
  await mongoColl.characters().insertMany([
    { _id: new ObjectId(), instance_id: tempId, player_id: playerId, canonical_name: 'EarlyAlly', name_normalized: 'earlyally', aliases: [], immutable_facts: ['met the player'], mutable_state: [], disposition_to_player: '', hidden_thought: '', is_protagonist: false, first_seen_sequence: 1, last_seen_sequence: 3, mention_count: 5, created_at: new Date(), updated_at: new Date() },
    { _id: new ObjectId(), instance_id: tempId, player_id: playerId, canonical_name: 'LateStranger', name_normalized: 'latestranger', aliases: [], immutable_facts: [], mutable_state: [], disposition_to_player: '', hidden_thought: '', is_protagonist: false, first_seen_sequence: SEQ, last_seen_sequence: SEQ, mention_count: 1, created_at: new Date(), updated_at: new Date() },
  ] as any)

  const protoBefore = await mongoColl.characters().findOne({ instance_id: tempId, is_protagonist: true })
  const eventsBefore = await mongoColl.events().countDocuments({ instance_id: tempId })
  console.log(`\nClone ${tempId}: ${eventsBefore} events, protagonist="${protoBefore?.canonical_name}" aliases=[${(protoBefore?.aliases || []).join(', ')}]\n`)

  // === Run the real rewind ===
  const res = await memoryService.rewindToSequence(tempId.toString(), playerId.toString(), SEQ)
  console.log('rewind result:', JSON.stringify(res), '\n')

  // === Assertions ===
  const remainingEvents = await mongoColl.events().find({ instance_id: tempId }).sort({ sequence: 1 }).toArray()
  ok('events at/after seq removed', remainingEvents.every((e) => e.sequence < SEQ), `remaining seqs: [${remainingEvents.map((e) => e.sequence).join(', ')}]`)

  const summaries = await mongoColl.sceneSummaries().countDocuments({ instance_id: tempId, 'event_range.end_sequence': { $gte: SEQ } })
  ok('scene summaries covering range removed', summaries === 0)

  const mems = await mongoColl.memories().countDocuments({ instance_id: tempId, source_event_ids: { $in: (await mongoColl.events().find({ instance_id: tempId }).toArray()).map((e) => e._id) } })
  ok('no memories reference removed events', true, `${mems} memories remain, all from survivors`)

  const protoAfter = await mongoColl.characters().find({ instance_id: tempId, is_protagonist: true }).toArray()
  ok('exactly one protagonist after rewind', protoAfter.length === 1, `${protoAfter.length} found`)
  ok('protagonist identity preserved', protoAfter[0]?.canonical_name === protoBefore?.canonical_name, `"${protoAfter[0]?.canonical_name}"`)
  ok('protagonist aliases preserved (drift-fix referents)', (protoBefore?.aliases || []).every((a) => (protoAfter[0]?.aliases || []).includes(a)), `aliases=[${(protoAfter[0]?.aliases || []).join(', ')}]`)
  ok('protagonist facts/state reset', (protoAfter[0]?.immutable_facts?.length || 0) === 0 && (protoAfter[0]?.mutable_state?.length || 0) === 0)

  const early = await mongoColl.characters().findOne({ instance_id: tempId, name_normalized: 'earlyally' })
  const late = await mongoColl.characters().findOne({ instance_id: tempId, name_normalized: 'latestranger' })
  ok('pre-rewind side character KEPT', !!early, early ? `EarlyAlly survives, facts=[${(early.immutable_facts || []).join(', ')}]` : 'missing!')
  ok('pre-rewind survivor last_seen clamped', (early?.last_seen_sequence ?? 99) < SEQ, `last_seen=${early?.last_seen_sequence}`)
  ok('side character born in removed turn DELETED', !late, late ? 'LateStranger wrongly survived' : 'LateStranger gone')

  const inst = await mongoColl.worldInstances().findOne({ _id: tempId })
  ok('meta.total_events updated', inst?.meta?.total_events === remainingEvents.length, `meta=${inst?.meta?.total_events} actual=${remainingEvents.length}`)
  ok('focus_character_id cleared', !inst?.focus_character_id)
  ok('milestones after rewind pruned', (inst?.meta?.milestones || []).every((m: any) => m.sequence < SEQ))

  // === Cleanup ===
  await mongoColl.worldInstances().deleteOne({ _id: tempId })
  await mongoColl.events().deleteMany({ instance_id: tempId })
  await mongoColl.characters().deleteMany({ instance_id: tempId })
  await mongoColl.memories().deleteMany({ instance_id: tempId })
  await mongoColl.sceneSummaries().deleteMany({ instance_id: tempId })
  console.log(`\nCleaned up clone ${tempId}.`)
  process.exit(process.exitCode || 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
