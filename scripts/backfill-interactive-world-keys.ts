/**
 * Stamp `interactive_world_key` on templates that already are map worlds.
 *
 * Identification is taken from first-party seed fixtures (key and title).
 *
 * Run intentionally: bun run backfill:interactive-world-keys
 */
import { connectMongo, mongoColl } from '../src/config/mongo'
import { loadWorld, worldKeys } from '../src/worlds/world-fixture'

await connectMongo()

const templates = mongoColl.worldTemplates()
let scanned = 0
let updated = 0

for (const key of worldKeys()) {
  const authored = loadWorld(key)
  if (!authored) continue
  scanned++

  const result = await templates.updateMany(
    {
      $and: [
        {
          $or: [{ slug: authored.key }, { title: authored.title }],
        },
        {
          $or: [
            { interactive_world_key: { $exists: false } },
            { interactive_world_key: null },
            { interactive_world_key: '' },
          ],
        },
      ],
    },
    { $set: { interactive_world_key: authored.key, updated_at: new Date() } },
  )
  updated += result.modifiedCount
}

console.log(JSON.stringify({ worlds: scanned, updated }))
process.exit(0)
