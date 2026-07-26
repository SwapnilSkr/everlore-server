/**
 * Repairs cards touched by the old template-cast migration path, which could
 * reset last_seen_sequence to 0 and repeatedly inflate mention_count. Values
 * are reconstructed from already-ledgered codex deltas; no story content,
 * meters, facts, or events are changed.
 *
 * Run: bun run repair:template-cast-projections
 */
import { connectMongo, mongoColl } from '../src/config/mongo'

function normalize(value: string): string {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9\s'-]+/g, '').replace(/\s+/g, ' ')
}

await connectMongo()

const instances = await mongoColl.worldInstances().find({}).toArray()
let repaired = 0
for (const instance of instances) {
  const [cards, events] = await Promise.all([
    mongoColl.characters().find({ instance_id: instance._id }).toArray(),
    mongoColl.events().find(
      { instance_id: instance._id },
      { projection: { sequence: 1, 'data.codex_deltas': 1 } },
    ).toArray(),
  ])
  for (const card of cards) {
    const identities = new Set([card.canonical_name, ...(card.aliases || [])].map(normalize).filter(Boolean))
    const matching = events.filter((event) => (event.data?.codex_deltas || []).some((delta) =>
      [delta.name, delta.resolved_name || '', ...(delta.aliases || [])].map(normalize).some((name) => identities.has(name)),
    ))
    const lastSeen = Math.max(card.first_seen_sequence || 0, ...matching.map((event) => event.sequence || 0))
    const mentionCount = Math.max(1, matching.length + ((card.first_seen_sequence || 0) === 0 ? 1 : 0))
    if (card.last_seen_sequence === lastSeen && card.mention_count === mentionCount) continue
    await mongoColl.characters().updateOne(
      { _id: card._id },
      { $set: { last_seen_sequence: lastSeen, mention_count: mentionCount, updated_at: new Date() } },
    )
    repaired++
  }
}

console.log(JSON.stringify({ instances: instances.length, repaired }))
process.exit(0)
