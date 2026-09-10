/**
 * Give a developer a real Iron Verdict save they can open on a device.
 *
 * Writes InteractiveWorldDoc (unpublished catalog) and InteractiveWorldInstanceDoc
 * (the save). Does not create a chat WorldTemplateDoc.
 *
 * Idempotent on world key and on (player, world): a second run reprints the
 * ids it already wrote rather than minting a second walk.
 *
 *   bun run seed:iron-verdict --email=you@example.com
 *   bun run seed:iron-verdict --player=<objectid>
 */
import { ObjectId } from 'mongodb'
import { connectMongo, mongoColl } from '../src/config/mongo'
import type { InteractiveWorldDoc, InteractiveWorldInstanceDoc } from '../src/models/interactive-world.model'
import { interactiveWorldService } from '../src/services/interactive-world.service'
import { idString, parseObjectId } from '../src/utils/mongo-id'
import { requireWorld } from '../src/worlds/world-source'

const WORLD_KEY = 'iron-verdict'

function flag(name: string): string | undefined {
  const prefix = `--${name}=`
  for (const raw of process.argv.slice(2)) {
    if (raw.startsWith(prefix)) {
      const value = raw.slice(prefix.length).trim()
      return value.length > 0 ? value : undefined
    }
  }
  return undefined
}

async function resolvePlayer(): Promise<{ _id: ObjectId; email?: string }> {
  const email = flag('email')
  const player = flag('player')
  if (!email && !player) {
    console.error('Pass --email=<addr> or --player=<objectid> so the instance is owned by a real account.')
    process.exit(1)
  }

  if (player) {
    const _id = parseObjectId(player)
    const user = await mongoColl.users().findOne({ _id })
    if (!user) {
      console.error(`No user found for --player=${player}`)
      process.exit(1)
    }
    return user
  }

  const user = await mongoColl.users().findOne({ email })
  if (!user) {
    console.error(`No user found for --email=${email}`)
    process.exit(1)
  }
  return user
}

async function stampCatalog(
  playerId: ObjectId,
  authored: ReturnType<typeof requireWorld>,
  world: InteractiveWorldDoc,
): Promise<InteractiveWorldDoc> {
  const now = new Date()
  await mongoColl.interactiveWorlds().updateOne(
    { _id: world._id },
    {
      $set: {
        creator_id: playerId,
        // Unpublished on purpose: seeding a save must not push Iron Verdict
        // into every account's Explore Walks shelf.
        is_published: false,
        description: authored.chapter_title,
        updated_at: now,
      },
    },
  )
  const next = await mongoColl.interactiveWorlds().findOne({ _id: world._id })
  if (!next) throw new Error('Could not stamp the Iron Verdict catalog row.')
  console.log(`Catalog world ${idString(world._id)} titled "${world.title}" (unpublished).`)
  return next as InteractiveWorldDoc
}

async function ensureInstance(
  playerId: ObjectId,
  world: InteractiveWorldDoc,
): Promise<{ instance: InteractiveWorldInstanceDoc; created: boolean }> {
  const existing = await mongoColl.interactiveWorldInstances().findOne(
    { player_id: playerId, world_id: world._id },
    { sort: { 'meta.last_active_at': -1 } },
  )
  if (existing) {
    const instance = existing as InteractiveWorldInstanceDoc
    console.log(`Reused existing walk ${idString(instance._id)} for this player.`)
    return { instance, created: false }
  }

  const now = new Date()
  const instance: InteractiveWorldInstanceDoc = {
    _id: new ObjectId(),
    world_id: world._id,
    world_key: world.key,
    player_id: playerId,
    meta: {
      total_events: 0,
      total_memories: 0,
      last_active_at: now,
      is_archived: false,
    },
    created_at: now,
    updated_at: now,
  }
  await mongoColl.interactiveWorldInstances().insertOne(instance)
  console.log(`Created walk instance ${idString(instance._id)}.`)
  return { instance, created: true }
}

async function main() {
  const authored = requireWorld(WORLD_KEY)
  await connectMongo()
  const player = await resolvePlayer()

  const world = await interactiveWorldService.ensureWorld(authored.key)
  const catalog = await stampCatalog(player._id, authored, world)
  const { instance } = await ensureInstance(player._id, catalog)
  const instanceId = idString(instance._id)

  console.log('')
  console.log(`world id:     ${idString(catalog._id)}`)
  console.log(`instance id:  ${instanceId}`)
  console.log(`/interactive/${authored.key}/lab?instanceId=${instanceId}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('seed-iron-verdict-realm failed:', err)
    process.exit(1)
  })
