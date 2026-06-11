/**
 * One-off repair for instance 6a2869768f7446e38bdb6fce.
 *
 * Seq 25 ("I go to my room and shut the door") + seq 26 ran under the pre-b0b60ce
 * code, which mislabeled the protagonist's bedroom as "dining room" and never reset
 * presence — so the cursor stuck on the dining room and Father/Mother stayed
 * "present" inside his bedroom. The b0b60ce fix is forward-only; this repoints the
 * already-stored data:
 *   1. mint "<protagonist>'s room" under the mansion (mirrors the sibling rooms)
 *   2. re-anchor events 25 & 26 onto it
 *   3. clear their stale present_characters (he shut the door; he's alone)
 *   4. repoint the instance cursor onto the bedroom
 * No memories are sourced from 25/26 (transitional beats), so nothing to re-anchor
 * there. Idempotent: re-running reuses the bedroom entity.
 */
import { connectMongo, coll } from '../src/config/mongo'
import { connectRedis, getRedisClient } from '../src/config/redis'
import { ObjectId } from 'mongodb'

const IID = process.argv[2] || '6a2869768f7446e38bdb6fce'
const MANSION_ID = '6a2a83a29ab868f10e18ae79'
const DINING_ID = '6a2a55b59a7406f8dfe14941'
const PROTAG = process.argv[3] || 'Swapnil Sarkar'
const ROOM_NAME = `${PROTAG}'s room`

function norm(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9\s'-]+/g, '').replace(/\s+/g, ' ')
}

async function main() {
  await connectMongo()
  await connectRedis()
  const oid = new ObjectId(IID)
  const mansionId = new ObjectId(MANSION_ID)
  const diningId = new ObjectId(DINING_ID)
  const roomNorm = norm(ROOM_NAME)

  const inst = await coll('world_instances').findOne({ _id: oid })
  if (!inst) throw new Error('instance not found')
  const playerId = (await coll('entities').findOne({ _id: diningId }))?.player_id
  if (!playerId) throw new Error('could not resolve player_id from dining room')

  // 1. mint (or reuse) the bedroom entity, mirroring the sibling rooms' shape.
  let room = await coll('entities').findOne({ instance_id: oid, type: 'location', name_normalized: roomNorm })
  if (!room) {
    const now = new Date()
    const doc = {
      _id: new ObjectId(),
      instance_id: oid,
      player_id: playerId,
      type: 'location',
      canonical_name: ROOM_NAME,
      name_normalized: roomNorm,
      aliases: [] as string[],
      status: 'active',
      first_seen_sequence: 25,
      last_seen_sequence: 26,
      mention_count: 2,
      created_at: now,
      updated_at: now,
      location_facts: [] as unknown[],
      location_state: [] as unknown[],
      parent_id: mansionId,
      place_kind: 'room',
      world_root_id: null,
    }
    await coll('entities').insertOne(doc as any)
    room = doc as any
    console.log(`minted bedroom entity ${room!._id} "${ROOM_NAME}" under mansion`)
  } else {
    console.log(`reusing existing bedroom entity ${room._id} "${room.canonical_name}"`)
  }

  const anchor = { entity_id: room!._id, name: room!.canonical_name, name_normalized: room!.name_normalized }

  // 2 + 3. re-anchor events 25 & 26 onto the bedroom and clear stale presence.
  const evs = await coll('events')
    .find({ instance_id: oid, sequence: { $in: [25, 26] } })
    .toArray()
  for (const e of evs) {
    const before = JSON.stringify(e.location_anchor?.name)
    await coll('events').updateOne(
      { _id: e._id },
      { $set: { location_anchor: anchor, 'data.present_characters': [] } },
    )
    console.log(`seq ${e.sequence}: anchor ${before} -> "${anchor.name}", present [] (was ${JSON.stringify(e.data?.present_characters)})`)
  }

  // 4. repoint the instance cursor.
  await coll('world_instances').updateOne(
    { _id: oid },
    { $set: { current_location: { entity_id: room!._id, name: room!.canonical_name, name_normalized: room!.name_normalized } } },
  )
  console.log(`cursor -> "${room!.canonical_name}"`)

  // fix dining room's last_seen (it no longer hosts 25/26; last real beat was 24).
  await coll('entities').updateOne(
    { _id: diningId },
    { $set: { last_seen_sequence: 24 }, $inc: { mention_count: -2 } },
  )
  console.log('dining room: last_seen_sequence -> 24, mention_count -= 2')

  // Bust the cached session — loadSession caches `session:<iid>` for 1h, so an
  // out-of-band cursor write here is invisible to the next turn until evicted.
  await getRedisClient().del(`session:${IID}`)
  console.log('session cache busted')

  console.log('\nDONE.')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
