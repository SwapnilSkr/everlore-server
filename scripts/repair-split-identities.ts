/**
 * Repair characters whose identity is split across two entity rows.
 *
 * A card renamed itself ("Crown Prince Cedric" → "Cedric") while a witness stub
 * already held the new name. From then on every convergence write collided with
 * the unique name index, and the throw took the whole turn's codex projection
 * with it — the world froze mid-scene while play continued on top of it.
 *
 * `syncCodexEntities` now absorbs the occupying row instead of colliding, so
 * the repair is simply to re-run it for the affected instances and then release
 * any projections that were stuck behind the collision.
 *
 *   bun run repair:split-identities            # report only
 *   bun run repair:split-identities --execute  # converge + re-queue
 *   bun run repair:split-identities --execute --instance <id>
 */
import { connectMongo, mongoColl } from '../src/config/mongo'
import { entityGraphService } from '../src/services/entity-graph.service'
import { idString } from '../src/utils/mongo-id'
import { ObjectId } from 'mongodb'

const EXECUTE = process.argv.includes('--execute')
const ONLY = (() => {
  const i = process.argv.indexOf('--instance')
  return i >= 0 ? process.argv[i + 1] : null
})()

async function main() {
  await connectMongo()

  const cardFilter: Record<string, unknown> = {}
  if (ONLY) cardFilter.instance_id = new ObjectId(ONLY)

  const cards = await mongoColl.characters().find(cardFilter).toArray()
  const byInstance = new Map<string, typeof cards>()
  for (const card of cards) {
    const key = idString(card.instance_id)
    if (!byInstance.has(key)) byInstance.set(key, [] as never)
    byInstance.get(key)!.push(card)
  }

  let splitCount = 0
  let repairedInstances = 0
  const affected: string[] = []

  for (const [instanceId, instanceCards] of byInstance) {
    const iid = new ObjectId(instanceId)
    const rows = await mongoColl
      .entities()
      .find({ instance_id: iid, type: { $in: ['protagonist', 'character'] } })
      .toArray()

    const splits: string[] = []
    for (const card of instanceCards) {
      if (!card.entity_id || !card.name_normalized) continue
      const linked = rows.find((e) => e._id.equals(card.entity_id!))
      if (!linked) continue
      // The signature: the card's own row does NOT carry the card's name, and
      // some other row does — so the rename can never land.
      if (linked.name_normalized === card.name_normalized) continue
      const occupant = rows.find(
        (e) => !e._id.equals(linked._id) && e.name_normalized === card.name_normalized,
      )
      if (!occupant) continue
      splits.push(
        `${card.canonical_name}: card→"${linked.name_normalized}" (${idString(linked._id)}) blocked by "${occupant.name_normalized}" (${idString(occupant._id)}, status=${occupant.status}, card=${occupant.character_id ? 'owned' : 'stub'})`,
      )
    }
    if (splits.length === 0) continue

    splitCount += splits.length
    affected.push(instanceId)
    console.log(`\ninstance ${instanceId} — ${splits.length} split identit${splits.length === 1 ? 'y' : 'ies'}`)
    for (const s of splits) console.log(`  • ${s}`)

    if (!EXECUTE) continue

    const latest = await mongoColl
      .events()
      .find({ instance_id: iid })
      .sort({ sequence: -1 })
      .limit(1)
      .next()
    await entityGraphService.syncCodexEntities({
      instanceId,
      playerId: idString(instanceCards[0].player_id ?? (latest as any)?.player_id),
      sequence: (latest as any)?.sequence ?? 0,
      cards: instanceCards as never,
    })
    repairedInstances++
    console.log(`  ✓ converged`)

    // Release anything the collision had poisoned. Clearing the attempt counter
    // and the error is what lets the sweeper pick these up again now that the
    // deterministic cause is gone.
    const released = await mongoColl.events().updateMany(
      {
        instance_id: iid,
        'data.codex_deltas': { $exists: false },
        'data.codex_projection_status': { $in: ['failed', 'pending'] },
      },
      {
        $set: { 'data.codex_projection_status': 'pending' },
        $unset: {
          'data.codex_projection_error': '',
          'data.codex_projection_attempts': '',
          'data.codex_projection_claimed_at': '',
        },
      },
    )
    if (released.modifiedCount > 0) {
      console.log(`  ✓ released ${released.modifiedCount} stuck projection(s) for the repair sweep`)
    }
  }

  console.log(
    `\n${splitCount} split identit${splitCount === 1 ? 'y' : 'ies'} across ${affected.length} instance(s).` +
      (EXECUTE ? ` Repaired ${repairedInstances}.` : ' Re-run with --execute to repair.'),
  )
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
