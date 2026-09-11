/**
 * Import first-party walk fixtures into InteractiveWorldDoc.
 *
 * Play reads the catalog doc, not these files. Run this on a fresh database
 * (or after the play payload was added to the schema) so Iron Verdict and any
 * other first-party walk can be walked.
 *
 *   bun run seed:walk-definitions
 */
import { connectMongo } from '../src/config/mongo'
import { interactiveWorldService } from '../src/services/interactive-world.service'
import { loadWorld, worldKeys } from '../src/worlds/world-fixture'

await connectMongo()

for (const key of worldKeys()) {
  const authored = loadWorld(key)
  if (!authored) continue
  const world = await interactiveWorldService.upsertWorldFromAuthored(authored)
  console.log(
    `stored ${world.key} v${world.version} — ${world.choices?.length ?? 0} choices, ${world.cast?.length ?? 0} cast`,
  )
}

process.exit(0)
