/**
 * Server-side location resolution audit — no LLM. Exercises indexed exact match,
 * conservative fuzzy dedup (long-tail returns outside the 30-name roster), and
 * the "don't merge distinct places" guard.
 *
 *   bun run scripts/location-resolution-audit.ts
 */
import { ObjectId } from 'mongodb'
import { connectMongo, mongoColl } from '../src/config/mongo'
import { ensureEverloreIndexes } from '../src/config/mongo-indexes'
import {
  entityGraphService,
  isVagueLocationLabel,
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
  // Generic place-nouns are NOT distinctive: a bedroom ("the room") must not
  // collapse into the dining room just because both contain "room".
  ok('the room ↮ dining room (generic noun)', scoreLocationNameMatch('the room', 'dining room') === 0)
  ok('the room ↮ great room (generic noun)', scoreLocationNameMatch('the room', 'great room') === 0)
  ok('the hall ↮ dining hall (generic noun)', scoreLocationNameMatch('the hall', 'dining hall') === 0)
  ok('entrance hall ↔ mansion entrance hall (still matches)', scoreLocationNameMatch('entrance hall', 'mansion entrance hall') >= 0.45)

  const fakeNightGarden = mkLocation(new ObjectId(), new ObjectId(), 'Night Garden', 1, ['the garden'])
  ok(
    'pickBest: the garden → Night Garden',
    pickBestLocationMatch('the garden', [fakeNightGarden])?.canonical_name === 'Night Garden',
  )

  // --- Vague-label classifier (P0): generic/relative labels are vague; a
  //     QUALIFIED place name is NOT (so "dining room" stays specific). ---
  console.log('\n=== Vague-label classification ===')
  for (const v of [
    'the room', 'room', 'here', 'outside', 'inside', 'this place', 'the area',
    // possessive-pronoun + bare room/dwelling noun is just as relative as "the room"
    'his room', 'her room', 'my room', 'their chamber', 'his quarters', 'her study', 'my own room', 'their house',
  ]) {
    ok(`"${v}" is vague`, isVagueLocationLabel(v) === true)
  }
  for (const s of [
    'dining room', 'great room', 'Night Garden', 'mansion', 'throne hall', 'the foyer',
    // a qualified possessive keeps its distinctive word; an owner-NAMED room is specific
    'his throne room', 'her war study', "Swapnil Sarkar's room",
  ]) {
    ok(`"${s}" is specific (NOT vague)`, isVagueLocationLabel(s) === false)
  }

  // --- DB integration ---
  const db = await connectMongo()
  await ensureEverloreIndexes(db) // bring the entities unique index up to date (world_root_id key)
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

  console.log('\n=== DB: vague-label guard (P0) ===')
  // A vague label on an UNMOVED turn must NOT mint and must return null so the
  // caller keeps the cursor.
  const vagueBefore = await entities().countDocuments({ instance_id: tempId, type: 'location' })
  const vagueUnmoved = await entityGraphService.resolveLocationAnchor({
    instanceId: idString(tempId),
    playerId: idString(playerId),
    sequence: 2005,
    name: 'the room',
    viewpointMoved: false,
  })
  const vagueAfter = await entities().countDocuments({ instance_id: tempId, type: 'location' })
  ok('vague "the room" unmoved → null (keep cursor)', vagueUnmoved === null, `${JSON.stringify(vagueUnmoved)}`)
  ok('vague "the room" unmoved → minted NOTHING', vagueAfter === vagueBefore, `count ${vagueBefore} → ${vagueAfter}`)

  // A SPECIFIC place on an unmoved turn still resolves — a return the model
  // under-flags (viewpoint_moved=false) must still update the cursor (a80bb10).
  const specificUnmoved = await entityGraphService.resolveLocationAnchor({
    instanceId: idString(tempId),
    playerId: idString(playerId),
    sequence: 2006,
    name: 'Night Garden',
    viewpointMoved: false,
  })
  ok(
    'specific "Night Garden" unmoved → still resolves (cursor follows on return)',
    !!specificUnmoved && idString(specificUnmoved.entity_id) === idString(nightGarden._id),
  )

  // A vague label WITH a narrated move is NOT suppressed (existing behavior;
  // P1 cartographer will place it under the right parent).
  const movedBefore = await entities().countDocuments({ instance_id: tempId, type: 'location' })
  await entityGraphService.resolveLocationAnchor({
    instanceId: idString(tempId),
    playerId: idString(playerId),
    sequence: 2007,
    name: 'the antechamber',  // specific — sanity that a real move still mints
    viewpointMoved: true,
  })
  const movedAfter = await entities().countDocuments({ instance_id: tempId, type: 'location' })
  ok('specific place on a move still mints', movedAfter === movedBefore + 1, `count ${movedBefore} → ${movedAfter}`)

  await entities().deleteMany({ instance_id: tempId })

  // === Cartographer (P1): containment placement + world-roots + re-parent. ===
  console.log('\n=== Cartographer: containment + world-roots ===')
  const cg = new ObjectId() // isolated instance for the graph scenarios
  const cgPlayer = new ObjectId()
  const place = (name: string) =>
    entities().findOne({ instance_id: cg, type: 'location', name_normalized: normalizeEntityName(name) }) as Promise<EntityDoc | null>

  // Seed: mansion (root-level, parent unknown) containing the dining room.
  const mansion = mkLocation(cg, cgPlayer, 'mansion', 1)
  const diningRoom = mkLocation(cg, cgPlayer, 'dining room', 2)
  diningRoom.parent_id = mansion._id
  await entities().insertMany([mansion, diningRoom])

  // deeper: from the mansion INTO the library → library.parent = mansion.
  await entityGraphService.placeLocation({
    instanceId: idString(cg), playerId: idString(cgPlayer), sequence: 10,
    name: 'library', movement: 'deeper', viewpointMoved: true, cursorEntityId: mansion._id,
  })
  const library = await place('library')
  ok('deeper: library parent = mansion', !!library && idString(library!.parent_id) === idString(mansion._id),
    `parent=${library?.parent_id}`)

  // out: from the dining room OUT to the foyer → foyer.parent = dining room's parent (mansion).
  await entityGraphService.placeLocation({
    instanceId: idString(cg), playerId: idString(cgPlayer), sequence: 11,
    name: 'foyer', movement: 'out', viewpointMoved: true, cursorEntityId: diningRoom._id,
  })
  const foyer = await place('foyer')
  ok('out: foyer parent = mansion (one level up from dining room)',
    !!foyer && idString(foyer!.parent_id) === idString(mansion._id), `parent=${foyer?.parent_id}`)

  // lateral: dining room → study (same level) → study.parent = mansion.
  await entityGraphService.placeLocation({
    instanceId: idString(cg), playerId: idString(cgPlayer), sequence: 12,
    name: 'study', movement: 'lateral', viewpointMoved: true, cursorEntityId: diningRoom._id,
  })
  const study = await place('study')
  ok('lateral: study parent = mansion', !!study && idString(study!.parent_id) === idString(mansion._id))

  // containment_hint overrides inferred parent: "the cellar, beneath the kitchen".
  await entityGraphService.placeLocation({
    instanceId: idString(cg), playerId: idString(cgPlayer), sequence: 13,
    name: 'wine cellar', containmentHint: 'the kitchen', movement: 'deeper', viewpointMoved: true,
    cursorEntityId: diningRoom._id,
  })
  const kitchen = await place('the kitchen')
  const cellar = await place('wine cellar')
  ok('hint: wine cellar parent = the kitchen (hint beat inferred)',
    !!cellar && !!kitchen && idString(cellar!.parent_id) === idString(kitchen!._id), `parent=${cellar?.parent_id}`)

  // re-parent reveal: an UNMOVED turn names the mansion's container for the first
  // time → mansion.parent gets filled (was unknown).
  await entityGraphService.placeLocation({
    instanceId: idString(cg), playerId: idString(cgPlayer), sequence: 14,
    name: 'mansion', containmentHint: 'Veliscourt', movement: 'none', viewpointMoved: false,
    cursorEntityId: mansion._id,
  })
  const mansionAfter = await place('mansion')
  const veliscourt = await place('veliscourt')
  ok('re-parent: mansion.parent filled with Veliscourt on reveal',
    !!mansionAfter && !!veliscourt && idString(mansionAfter!.parent_id) === idString(veliscourt!._id),
    `parent=${mansionAfter?.parent_id}`)

  // world_shift: cross into the Shadow Realm → new root minted (self-rooted),
  // destination hung under it.
  await entityGraphService.placeLocation({
    instanceId: idString(cg), playerId: idString(cgPlayer), sequence: 15,
    name: 'obsidian throne', containmentHint: 'Shadow Realm', movement: 'world_shift', viewpointMoved: true,
    cursorEntityId: diningRoom._id,
  })
  const shadow = await place('shadow realm')
  const throne = await place('obsidian throne')
  ok('world_shift: Shadow Realm root is self-rooted',
    !!shadow && idString(shadow!.world_root_id) === idString(shadow!._id))
  ok('world_shift: obsidian throne under the Shadow Realm root',
    !!throne && idString(throne!.parent_id) === idString(shadow!._id) &&
      idString(throne!.world_root_id) === idString(shadow!._id))

  // cross-world same name: a "manor" in the main world AND in the Shadow Realm must
  // be DISTINCT entities (the unique index now includes world_root_id).
  await entityGraphService.placeLocation({
    instanceId: idString(cg), playerId: idString(cgPlayer), sequence: 16,
    name: 'manor', movement: 'lateral', viewpointMoved: true, cursorEntityId: mansion._id, // main world (root null)
  })
  await entityGraphService.placeLocation({
    instanceId: idString(cg), playerId: idString(cgPlayer), sequence: 17,
    name: 'manor', movement: 'lateral', viewpointMoved: true, cursorEntityId: throne!._id, // shadow world
  })
  const manors = await entities().find({ instance_id: cg, type: 'location', name_normalized: 'manor' }).toArray()
  ok('cross-world: two "manor" entities coexist (one per realm)', manors.length === 2, `count=${manors.length}`)
  ok('cross-world: the two manors have different world roots',
    manors.length === 2 && idString((manors[0] as any).world_root_id ?? 'main') !== idString((manors[1] as any).world_root_id ?? 'main'))

  await entities().deleteMany({ instance_id: cg })

  console.log(`\n${failures === 0 ? '✅ ALL INVARIANTS HELD' : `❌ ${failures} invariant failure(s)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
