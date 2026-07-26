/**
 * Seed only clearly evidenced relationship profiles for old unmetered cards.
 * Default is dry-run. Pass --apply to write both the card AND its originating
 * codex delta, so rewind/rebuild preserves the backfill.
 */
import { connectMongo, mongoColl } from '../src/config/mongo'
import { detectRelationshipInitialization, relationshipBaseline } from '../src/utils/relationship-baseline'

const apply = process.argv.includes('--apply')
const normalize = (value: string) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

await connectMongo()
const cards = await mongoColl.characters().find({ relationship: { $exists: false } }).toArray()
let candidates = 0
let applied = 0
let skippedNoLedger = 0

for (const card of cards) {
  const instance = await mongoColl.worldInstances().findOne(
    { _id: card.instance_id },
    { projection: { template_id: 1 } },
  )
  const template = instance
    ? await mongoColl.worldTemplates().findOne({ _id: instance.template_id }, { projection: { seed_prompt: 1 } })
    : null
  const source = [
    template?.seed_prompt || '',
    card.role || '',
    card.persona || '',
    card.disposition_to_player || '',
    ...(card.immutable_facts || []),
    ...(card.mutable_state || []),
  ].join('\n')
  const initialization = detectRelationshipInitialization(source)
  if (!initialization) continue
  candidates++

  const events = await mongoColl.events()
    .find({ instance_id: card.instance_id, 'data.codex_deltas': { $exists: true } })
    .sort({ sequence: 1 })
    .toArray()
  const cardNames = new Set([card.canonical_name, ...(card.aliases || [])].map(normalize).filter(Boolean))
  const origin = events.find((event: any) =>
    Array.isArray(event.data?.codex_deltas) && event.data.codex_deltas.some((delta: any) =>
      [delta?.name, delta?.resolved_name, ...(delta?.aliases || [])]
        .map(normalize)
        .some((name: string) => cardNames.has(name)),
    ),
  )
  if (!origin) {
    skippedNoLedger++
    continue
  }

  if (apply) {
    const deltas = origin.data.codex_deltas.map((delta: any) => {
      const matches = [delta?.name, delta?.resolved_name, ...(delta?.aliases || [])]
        .map(normalize)
        .some((name: string) => cardNames.has(name))
      return matches && !delta.relationship_initialization
        ? { ...delta, relationship_initialization: initialization }
        : delta
    })
    await mongoColl.events().updateOne({ _id: origin._id }, { $set: { 'data.codex_deltas': deltas } })
    await mongoColl.characters().updateOne(
      { _id: card._id, relationship: { $exists: false } },
      { $set: { relationship: relationshipBaseline(initialization.kind), relationship_moments: [], updated_at: new Date() } },
    )
    applied++
  }
  console.log(`${apply ? 'APPLIED' : 'WOULD APPLY'} ${card.canonical_name}: ${initialization.kind} (${initialization.evidence})`)
}

console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', cardsScanned: cards.length, candidates, applied, skippedNoLedger }))
