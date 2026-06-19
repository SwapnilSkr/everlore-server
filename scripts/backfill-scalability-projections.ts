/**
 * One-time backfill for the scalability projections:
 *   - location_stats (materialized Places read surface; replaces the full-world
 *     aggregation in locationService.listLocations)
 *   - entities.name_tokens (indexed candidate lookup for findEntitiesMentioned;
 *     replaces the full non-archived registry scan)
 *
 * Both read paths self-heal lazily per-instance on first read, so this script is
 * an OPTIONAL warm-up to avoid that first-read cost in production. Idempotent.
 *
 *   bun run scripts/backfill-scalability-projections.ts [instanceId]
 * With no arg, backfills every instance.
 */
import { connectMongo, mongoColl } from '../src/config/mongo'
import { locationService } from '../src/services/location.service'
import { entityGraphService } from '../src/services/entity-graph.service'
import { idString } from '../src/utils/mongo-id'

async function main() {
  await connectMongo()
  const only = process.argv[2]
  const instances = only
    ? [{ _id: { toString: () => only } as any }]
    : await mongoColl.worldInstances().find({}, { projection: { _id: 1 } }).toArray()

  let n = 0
  for (const inst of instances) {
    const iid = only || idString((inst as any)._id)
    try {
      const stats = await locationService.backfillLocationStats(iid)
      const tokens = await entityGraphService.backfillEntityTokens(iid)
      n++
      console.log(`  ${iid}: location_stats=${stats.places} name_tokens=${tokens.updated}`)
    } catch (e) {
      console.warn(`  ${iid}: FAILED — ${(e as Error).message}`)
    }
  }
  console.log(`\nBackfilled ${n} instance(s).`)
  process.exit(0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
