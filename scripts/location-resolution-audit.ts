/**
 * Server-side location resolution audit — no LLM. Exercises indexed exact match,
 * conservative fuzzy dedup (long-tail returns outside the 30-name roster), and
 * the "don't merge distinct places" guard.
 *
 *   bun run scripts/location-resolution-audit.ts
 */
import { ObjectId } from 'mongodb'
import { connectMongo, mongoColl } from '../src/config/mongo'
import {
  entityGraphService,
  normalizeEntityName,
  pickBestLocationMatch,
  scoreLocationNameMatch,
} from '../src/services/entity-graph.service'
import type { EntityDoc } from '../src/models/entity.model'
import { idString } from '../src/utils/mongo-id'

let failures = 0
function ok(label: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

function mkLocation(
  instanceId: ObjectId,
  playerId: ObjectId,
  canonical: string,
  seq: number,
  aliases: string[] = [],
): EntityDoc {
  const now = new Date()
  const normalized = normalizeEntityName(canonical)
  return {
    _id: new ObjectId(),
    instance_id: instanceId,
    player_id: playerId,
    type: 'location',
    canonical_name: canonical,
    name_normalized: normalized,
    aliases,
    status: 'active',
    first_seen_sequence: seq,
    last_seen_sequence: seq,
    mention_count: 1,
    created_at: now,
    updated_at: now,
  }
}

async function main() {
  console.log('location-resolution-audit — pure scoring + DB integration')

  // --- Pure scoring (no DB) ---
  console.log('\n=== Scoring: conservative token containment ===')
  ok('garden ↔ night garden', scoreLocationNameMatch('garden', 'night garden') >= 0.45)
  ok('the garden ↔ night garden', scoreLocationNameMatch('the garden', 'night garden') >= 0.45)
  ok(
    'entrance hall ↔ mansion entrance hall',
    scoreLocationNameMatch('entrance hall', 'mansion entrance hall') >= 0.45,
  )
  ok(
    'dining hall ↮ dining room (distinct)',
    scoreLocationNameMatch('dining hall', 'dining room') === 0,
  )
  ok('inn ↮ riverside (weak single token)', scoreLocationNameMatch('inn', 'riverside inn') === 0)

  const fakeNightGarden = mkLocation(new ObjectId(), new ObjectId(), 'Night Garden', 1, ['the garden'])
  ok(
    'pickBest: the garden → Night Garden',
    pickBestLocationMatch('the garden', [fakeNightGarden])?.canonical_name === 'Night Garden',
  )

  // --- DB integration ---
  await connectMongo()
  const tempId = new ObjectId()
  const playerId = new ObjectId()
  const entities = () => mongoColl.entities()

  // Seed 35 filler locations so "Night Garden" is outside the top-30 roster.
  const fillers: EntityDoc[] = []
  for (let i = 0; i < 35; i++) {
    fillers.push(mkLocation(tempId, playerId, `Filler Place ${i + 1}`, 1000 - i))
  }
  const nightGarden = mkLocation(tempId, playerId, 'Night Garden', 1, ['the garden'])
  fillers.push(nightGarden)
  await entities().insertMany(fillers)

  const rosterBefore = await entityGraphService.listKnownLocations(idString(tempId), 30)
  ok('listKnownLocations capped at 30', rosterBefore.length === 30)
  ok(
    'Night Garden outside hot roster before resolve (long-tail case)',
    !rosterBefore.some((p) => /night garden/i.test(p.name)),
    rosterBefore.map((p) => p.name).slice(0, 5).join(', ') + '…',
  )

  console.log('\n=== DB: long-tail fuzzy return (outside 30-roster) ===')
  const longTail = await entityGraphService.resolveLocationAnchor({
    instanceId: idString(tempId),
    playerId: idString(playerId),
    sequence: 2000,
    name: 'the garden',
  })
  ok(
    'the garden resolves to Night Garden entity',
    !!longTail && idString(longTail.entity_id) === idString(nightGarden._id),
    longTail ? `${longTail.name} (${idString(longTail.entity_id)})` : 'null',
  )

  const locationCount = await entities().countDocuments({ instance_id: tempId, type: 'location' })
  ok('no duplicate minted', locationCount === 36, `count=${locationCount}`)

  console.log('\n=== DB: exact match still works ===')
  const exact = await entityGraphService.resolveLocationAnchor({
    instanceId: idString(tempId),
    playerId: idString(playerId),
    sequence: 2001,
    name: 'Night Garden',
  })
  ok(
    'Night Garden exact → same entity',
    !!exact && idString(exact.entity_id) === idString(nightGarden._id),
  )

  console.log('\n=== DB: distinct places stay distinct ===')
  const hall = await entityGraphService.resolveLocationAnchor({
    instanceId: idString(tempId),
    playerId: idString(playerId),
    sequence: 2002,
    name: 'dining hall',
  })
  const room = await entityGraphService.resolveLocationAnchor({
    instanceId: idString(tempId),
    playerId: idString(playerId),
    sequence: 2003,
    name: 'dining room',
  })
  ok(
    'dining hall and dining room are different entities',
    !!hall && !!room && idString(hall.entity_id) !== idString(room.entity_id),
    `${hall?.name} vs ${room?.name}`,
  )

  console.log('\n=== DB: genuinely new place still mints ===')
  const before = await entities().countDocuments({ instance_id: tempId, type: 'location' })
  const novel = await entityGraphService.resolveLocationAnchor({
    instanceId: idString(tempId),
    playerId: idString(playerId),
    sequence: 2004,
    name: 'Abandoned Watchtower',
  })
  const after = await entities().countDocuments({ instance_id: tempId, type: 'location' })
  ok('new place created', after === before + 1, `count ${before} → ${after}`)
  ok('novel name preserved', novel?.name === 'Abandoned Watchtower')

  await entities().deleteMany({ instance_id: tempId })

  console.log(`\n${failures === 0 ? '✅ ALL INVARIANTS HELD' : `❌ ${failures} invariant failure(s)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
