/**
 * One-time, non-destructive migration for codex cards created before
 * `identity_kind` existed. It classifies only the label already on the card;
 * it never renames, merges, or invents a character.
 *
 * Run intentionally: bun run backfill:identity-kinds
 */
import { connectMongo, mongoColl } from '../src/config/mongo'
import { callLLM, AI_MODELS } from '../src/ai'

type IdentityKind = 'proper_name' | 'epithet' | 'role_label' | 'kinship_label'

function parseKind(raw: string): IdentityKind | null {
  try {
    const value = JSON.parse(raw)?.identity_kind
    return value === 'proper_name' || value === 'epithet' || value === 'role_label' || value === 'kinship_label'
      ? value
      : null
  } catch {
    return null
  }
}

await connectMongo()
const cards = await mongoColl.characters()
  .find({ identity_kind: { $exists: false } })
  .project({ canonical_name: 1, aliases: 1, role: 1, immutable_facts: 1, persona: 1 })
  .toArray()

let updated = 0
let skipped = 0
for (const card of cards) {
  let raw = ''
  try {
    raw = await callLLM({
      model: AI_MODELS.metadata,
      temperature: 0,
      maxTokens: 80,
      responseFormat: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Classify the existing in-world identity label. Return ONLY {"identity_kind":"proper_name|epithet|role_label|kinship_label"}. proper_name is a personal name; epithet is a fixed descriptive identity (The Mysterious Man); role_label is an office/job title; kinship_label is a family relation. Do not rename or infer facts.',
        },
        { role: 'user', content: JSON.stringify({ name: card.canonical_name, aliases: card.aliases || [], role: card.role || '', facts: card.immutable_facts || [], persona: card.persona || '' }) },
      ],
    })
  } catch {
    skipped++
    continue
  }
  const identityKind = parseKind(raw)
  if (!identityKind) {
    skipped++
    continue
  }
  await mongoColl.characters().updateOne(
    { _id: card._id, identity_kind: { $exists: false } },
    { $set: { identity_kind: identityKind, updated_at: new Date() } },
  )
  updated++
}

console.log(JSON.stringify({ scanned: cards.length, updated, skipped }))
