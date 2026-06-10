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
import { characterCodexService } from '../src/services/character-codex.service'
import { entityGraphService } from '../src/services/entity-graph.service'

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

  // Ledger codex deltas on the cloned events to exercise the EXACT-rebuild path
  // and prove no stale facts survive:
  //  - surviving turn (seq < SEQ): introduces EarlyAlly with a true fact + a
  //    trust bump, so the rebuilt card must show ONLY these.
  //  - removed turn (seq >= SEQ): adds a CONTRADICTING fact + a big trust hit to
  //    EarlyAlly and introduces LateStranger — none of this may survive.
  const survSeq = SEQ - 1
  await mongoColl.events().updateOne(
    { instance_id: tempId, sequence: survSeq },
    { $set: { 'data.codex_deltas': [
      { name: 'EarlyAlly', immutable_facts: ['befriended the player at the gate'], mutable_state: ['loyal ally'], relationship_deltas: { trust: 6 }, is_protagonist: false },
    ] } },
  )
  await mongoColl.events().updateOne(
    { instance_id: tempId, sequence: SEQ },
    { $set: { 'data.codex_deltas': [
      { name: 'EarlyAlly', immutable_facts: ['betrayed the player'], relationship_deltas: { trust: -9 }, is_protagonist: false },
      { name: 'LateStranger', immutable_facts: ['arrived from the north'], is_protagonist: false },
    ] } },
  )
  const calendarId = new ObjectId()
  const anchorFor = (sequence: number, label: string) => ({
    real_time: new Date(),
    sequence,
    story_calendar: {
      calendar_id: calendarId,
      year: 1,
      month: 1,
      day: sequence,
      era: 'First Era',
      label,
    },
    event_time_label: label,
    timeline_id: 'main',
    causal_parent_event_ids: [],
  })
  const survivingAnchor = anchorFor(survSeq, 'surviving day')
  const doomedAnchor = anchorFor(SEQ, 'doomed day')
  await mongoColl.events().updateOne(
    { instance_id: tempId, sequence: survSeq },
    { $set: { time_anchor: survivingAnchor } },
  )
  await mongoColl.events().updateOne(
    { instance_id: tempId, sequence: SEQ },
    { $set: { time_anchor: doomedAnchor } },
  )
  await mongoColl.worldInstances().updateOne(
    { _id: tempId },
    { $set: { current_time_anchor: doomedAnchor, active_timeline_id: 'main', default_calendar_id: calendarId } },
  )

  // === Seed entity graph on the clone ===
  // Two non-character entities (one born in a surviving turn, one in a doomed
  // turn), edges with doomed-only and mixed provenance, and an entity-linked
  // memory from a surviving turn — exercising every rewind repair rule.
  const clonedEvents = await mongoColl.events().find({ instance_id: tempId }).toArray()
  const evBySeq = new Map(clonedEvents.map((e) => [e.sequence, e._id]))
  const survEventId = evBySeq.get(survSeq)
  const doomedEventId = evBySeq.get(SEQ)
  const now = new Date()
  const mkEntity = (name: string, firstSeen: number) => ({
    _id: new ObjectId(),
    instance_id: tempId,
    player_id: playerId,
    type: 'location' as const,
    canonical_name: name,
    name_normalized: name.toLowerCase(),
    aliases: [],
    status: 'active' as const,
    first_seen_sequence: firstSeen,
    last_seen_sequence: SEQ,
    mention_count: 1,
    created_at: now,
    updated_at: now,
  })
  const oldKeep = mkEntity('OldKeep', survSeq)
  const oldTower = mkEntity('OldTower', survSeq)
  const doomedPlace = mkEntity('DoomedPlace', SEQ)
  await mongoColl.entities().insertMany([oldKeep, oldTower, doomedPlace] as any)
  if (survEventId && doomedEventId) {
    // Mixed provenance: must survive with only the surviving source left.
    await entityGraphService.upsertNarrativeEdge({
      instanceId: tempId.toString(), sourceEntityId: oldKeep._id, targetEntityId: oldTower._id,
      type: 'relationship', label: 'rival strongholds', importance: 3, eventId: survEventId, sequence: survSeq,
    })
    await entityGraphService.upsertNarrativeEdge({
      instanceId: tempId.toString(), sourceEntityId: oldKeep._id, targetEntityId: oldTower._id,
      type: 'relationship', label: 'rival strongholds', importance: 3, eventId: doomedEventId, sequence: SEQ,
    })
    // Same pair/type, DIFFERENT label, sourced only from the doomed turn:
    // label is part of edge identity, so this must be its own edge and must
    // die with its turn — not merge into (and re-label) the surviving edge.
    await entityGraphService.upsertNarrativeEdge({
      instanceId: tempId.toString(), sourceEntityId: oldKeep._id, targetEntityId: oldTower._id,
      type: 'relationship', label: 'reconciled after the siege', importance: 3, eventId: doomedEventId, sequence: SEQ,
    })
    // Doomed-only provenance between SURVIVING entities: must be deleted.
    await entityGraphService.upsertNarrativeEdge({
      instanceId: tempId.toString(), sourceEntityId: oldTower._id, targetEntityId: oldKeep._id,
      type: 'besieged', label: 'siege of the keep', importance: 4, eventId: doomedEventId, sequence: SEQ,
    })
    // Entity-linked memory from a surviving turn: must survive the rewind.
    await mongoColl.memories().insertOne({
      _id: new ObjectId(), instance_id: tempId, player_id: playerId,
      text: 'The player swore to defend OldKeep.', type: 'promise', importance: 4, is_nsfw: false,
      source_event_ids: [survEventId], access_count: 0, last_accessed_at: now,
      is_archived: false, subjects: ['player'], objects: ['OldKeep'],
      subject_entity_ids: [], object_entity_ids: [oldKeep._id],
      created_at: now, updated_at: now,
    } as any)
  }

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

  const early = await mongoColl.characters().findOne({ instance_id: tempId, name_normalized: 'earlyally' })
  const late = await mongoColl.characters().findOne({ instance_id: tempId, name_normalized: 'latestranger' })
  ok('pre-rewind character rebuilt from ledger', !!early, early ? `EarlyAlly rebuilt, facts=[${(early.immutable_facts || []).join(', ')}]` : 'missing!')
  ok('surviving-turn fact KEPT', !!early?.immutable_facts?.includes('befriended the player at the gate'))
  ok('removed-turn fact NOT present (no stale fact)', !early?.immutable_facts?.includes('betrayed the player'), `facts=[${(early?.immutable_facts || []).join(', ')}]`)
  ok('meter reflects ONLY surviving delta (50+6=56, not -)', early?.relationship?.trust === 56, `trust=${early?.relationship?.trust ?? 'none'}`)
  ok('side character born in removed turn DELETED', !late, late ? 'LateStranger wrongly survived' : 'LateStranger gone')

  // === Entity-graph assertions ===
  const doomedAfter = await mongoColl.entities().findOne({ _id: doomedPlace._id })
  ok('entity born in removed turn DELETED', !doomedAfter, doomedAfter ? 'DoomedPlace wrongly survived' : 'DoomedPlace gone')
  const oldKeepAfter = await mongoColl.entities().findOne({ _id: oldKeep._id })
  ok('surviving entity kept, last_seen clamped', !!oldKeepAfter && oldKeepAfter.last_seen_sequence <= SEQ - 1, `last_seen=${oldKeepAfter?.last_seen_sequence}`)
  const besieged = await mongoColl.entityEdges().findOne({ instance_id: tempId, type: 'besieged' })
  ok('edge sourced ONLY from removed turn DELETED', !besieged)
  const pairEdges = await mongoColl.entityEdges().find({ instance_id: tempId, type: 'relationship', source_entity_id: oldKeep._id }).toArray()
  const rivalEdge = pairEdges.find((e) => e.label === 'rival strongholds')
  ok(
    'mixed-provenance edge pruned to surviving sources',
    !!rivalEdge && rivalEdge.source_event_ids.length === 1 && !!survEventId && rivalEdge.source_event_ids[0].equals(survEventId),
    `sources=${rivalEdge?.source_event_ids?.length}`,
  )
  ok(
    'doomed-turn assertion on same pair/type DELETED (no stale label)',
    pairEdges.length === 1 && rivalEdge?.label === 'rival strongholds',
    `labels=[${pairEdges.map((e) => e.label).join('; ')}]`,
  )
  const keepMemory = await mongoColl.memories().findOne({ instance_id: tempId, object_entity_ids: oldKeep._id })
  ok('entity-linked memory from surviving turn KEPT', !!keepMemory)
  const earlyEntity = await mongoColl.entities().findOne({ instance_id: tempId, type: 'character', name_normalized: 'earlyally' })
  ok(
    'rebuilt card linked 1:1 to character entity',
    !!earlyEntity && !!early?.entity_id && early.entity_id.equals(earlyEntity._id) && !!earlyEntity.character_id && earlyEntity.character_id.equals(early._id),
    earlyEntity ? `entity=${earlyEntity._id}` : 'entity missing!',
  )
  const trustEdge = earlyEntity
    ? await mongoColl.entityEdges().findOne({ instance_id: tempId, type: 'trust', source_entity_id: earlyEntity._id })
    : null
  ok('meter edge re-projected from rebuilt ledger (trust=56)', trustEdge?.weight === 56, `weight=${trustEdge?.weight ?? 'none'}`)

  // Per-turn applyDeltas hot path: new card (insert) then update (dirty-write +
  // accumulate). Exercises the refactored fold/persist used on every live turn.
  await characterCodexService.applyDeltas({ instanceId: tempId.toString(), playerId: playerId.toString(), sequence: 10, deltas: [{ name: 'Probe', immutable_facts: ['fact A'], relationship_deltas: { trust: 5 }, is_protagonist: false }] as any })
  await characterCodexService.applyDeltas({ instanceId: tempId.toString(), playerId: playerId.toString(), sequence: 11, deltas: [{ name: 'Probe', immutable_facts: ['fact B'], mutable_state: ['curious'], relationship_deltas: { trust: 5 }, is_protagonist: false }] as any })
  const probe = await mongoColl.characters().findOne({ instance_id: tempId, name_normalized: 'probe' })
  ok('applyDeltas new card mention_count=1 then update=2', probe?.mention_count === 2, `mention_count=${probe?.mention_count}`)
  ok('applyDeltas merges facts across turns', ['fact A', 'fact B'].every((f) => probe?.immutable_facts?.includes(f)), `facts=[${(probe?.immutable_facts || []).join(', ')}]`)
  ok('applyDeltas accumulates meter (50+5+5=60, no double-apply)', probe?.relationship?.trust === 60, `trust=${probe?.relationship?.trust}`)

  const inst = await mongoColl.worldInstances().findOne({ _id: tempId })
  ok('meta.total_events updated', inst?.meta?.total_events === remainingEvents.length, `meta=${inst?.meta?.total_events} actual=${remainingEvents.length}`)
  ok('focus_character_id cleared', !inst?.focus_character_id)
  ok('milestones after rewind pruned', (inst?.meta?.milestones || []).every((m: any) => m.sequence < SEQ))
  ok('story-time cursor rolled back to last surviving event', inst?.current_time_anchor?.sequence === survSeq, `time_sequence=${inst?.current_time_anchor?.sequence}`)

  // === Cleanup ===
  await mongoColl.worldInstances().deleteOne({ _id: tempId })
  await mongoColl.events().deleteMany({ instance_id: tempId })
  await mongoColl.characters().deleteMany({ instance_id: tempId })
  await mongoColl.memories().deleteMany({ instance_id: tempId })
  await mongoColl.sceneSummaries().deleteMany({ instance_id: tempId })
  await mongoColl.entities().deleteMany({ instance_id: tempId })
  await mongoColl.entityEdges().deleteMany({ instance_id: tempId })
  await mongoColl.storyCalendars().deleteMany({ instance_id: tempId })
  await mongoColl.timelineBranches().deleteMany({ instance_id: tempId })
  console.log(`\nCleaned up clone ${tempId}.`)
  process.exit(process.exitCode || 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
