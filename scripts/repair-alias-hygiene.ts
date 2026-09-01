/**
 * One-off repair: strip bare TITLES that older builds stored as character
 * aliases ("Ser" on the protagonist, so every lone "Ser" resolved to him).
 *
 * New writes are already clean — the extractor refuses them by how the prose
 * spells the word, and foldDelta re-checks on replay. This closes the third
 * case: aliases already sitting in the database.
 *
 * Evidence is the ENTITY roster, which foldDelta cannot see: a single word that
 * leads somebody ELSE'S longer name ("Ser" → "Ser Edric") is a title. A word
 * leading only its own card's longer name ("Michael" → "Michael Oliver") is a
 * first name and is kept.
 *
 *   bun run scripts/repair-alias-hygiene.ts          # report only
 *   bun run scripts/repair-alias-hygiene.ts --apply  # write
 */
import { connectMongo, mongoColl } from '../src/config/mongo'

const apply = process.argv.includes('--apply')
await connectMongo()

const norm = (v: string) => String(v || '').toLowerCase().replace(/[^a-z0-9\s'-]+/g, '').replace(/\s+/g, ' ').trim()

const cards = await mongoColl.characters().find({}).toArray()
const byInstance = new Map<string, any[]>()
for (const c of cards as any[]) {
  const k = String(c.instance_id)
  byInstance.set(k, [...(byInstance.get(k) || []), c])
}

let scanned = 0
let repaired = 0
for (const [instanceId, instanceCards] of byInstance) {
  const entities = await mongoColl.entities().find({ instance_id: (instanceCards[0] as any).instance_id }).toArray()
  // Every multi-word name this world knows, from BOTH projections.
  const multiWordNames: Array<{ key: string; owner: string | null }> = []
  for (const e of entities as any[]) {
    for (const n of [e.canonical_name, ...(e.aliases || [])]) {
      const k = norm(n)
      if (k.includes(' ')) multiWordNames.push({ key: k, owner: e.character_id ? String(e.character_id) : null })
    }
  }
  for (const c of instanceCards) {
    for (const n of [c.canonical_name, ...(c.aliases || [])]) {
      const k = norm(n)
      if (k.includes(' ')) multiWordNames.push({ key: k, owner: String(c._id) })
    }
  }

  for (const card of instanceCards) {
    scanned++
    // Every word of this person's OWN names. A first name leads their full name
    // ("Elara" → "Elara Thornwood") and must never be mistaken for a title just
    // because it also leads a relative's name.
    const ownTokens = new Set<string>()
    for (const n of [card.canonical_name, ...(card.aliases || [])]) {
      for (const t of norm(n).split(' ')) if (t) ownTokens.add(t)
    }
    const kept = (card.aliases || []).filter((alias: string) => {
      const a = norm(alias)
      if (!a || a.includes(' ')) return true
      // Part of their own name → theirs, whatever else it leads.
      const ownMultiWord = [card.canonical_name, ...(card.aliases || [])]
        .map(norm)
        .filter((n) => n.includes(' '))
      if (ownMultiWord.some((n) => n.split(' ').includes(a))) return true
      // Otherwise: leads somebody ELSE'S longer name → a title.
      return !multiWordNames.some((m) => m.key.split(' ')[0] === a && !ownMultiWord.includes(m.key))
    })
    if (kept.length === (card.aliases || []).length) continue
    const dropped = (card.aliases || []).filter((a: string) => !kept.includes(a))
    repaired++
    console.log(`  ${instanceId} "${card.canonical_name}" — dropping ${JSON.stringify(dropped)}`)
    if (apply) {
      await mongoColl.characters().updateOne({ _id: card._id }, { $set: { aliases: kept, updated_at: new Date() } })
      await mongoColl.entities().updateMany({ character_id: card._id }, { $set: { aliases: kept, updated_at: new Date() } })
    }
  }
}

console.log(`\n${scanned} cards scanned, ${repaired} would change${apply ? ' (APPLIED)' : ' (dry run — pass --apply)'}`)
process.exit(0)
