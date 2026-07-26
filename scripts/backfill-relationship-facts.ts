/**
 * One-time projection migration: preserve existing relationship_state summaries
 * as the first fact in the new append/retire journal. This changes no meters,
 * narrative, or event history.
 *
 * Run: bun run backfill:relationship-facts
 */
import { connectMongo, mongoColl } from '../src/config/mongo'

await connectMongo()

const cards = await mongoColl.characters().find({
  relationship_state: { $exists: true },
  $or: [{ relationship_facts: { $exists: false } }, { relationship_facts: { $size: 0 } }],
}).toArray()

let migrated = 0
for (const card of cards) {
  const state = card.relationship_state
  if (!state?.summary || !state.evidence) continue
  await mongoColl.characters().updateOne(
    { _id: card._id },
    {
      $set: {
        relationship_facts: [{
          statement: state.summary,
          evidence: state.evidence,
          ...(state.tags?.length ? { tags: state.tags.slice(0, 5) } : {}),
          sequence: card.first_seen_sequence || 0,
          status: 'active',
        }],
        updated_at: new Date(),
      },
    },
  )
  migrated++
}

console.log(JSON.stringify({ scanned: cards.length, migrated }))
process.exit(0)
