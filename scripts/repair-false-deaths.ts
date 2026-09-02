/**
 * Repair characters buried on evidence that never named them.
 *
 * `applyLifecycleDeltas` is a one-way write: a dead card is dropped from the
 * context packet entirely, so the person stops being a KNOWN character —
 * unadmittable to any scene, gone from Bonds, treated as an unknown walk-on by
 * every later turn. The extractor checked only that the excerpt was verbatim
 * and that the model was confident; it never checked that the excerpt NAMED the
 * person, or that it was narration rather than a line of dialogue.
 *
 * This re-runs the corrected verification over the evidence that was actually
 * used, and clears `life_state` where it does not hold up. A death whose
 * evidence still verifies is left exactly as it is.
 *
 * Dry run by default. Run: bun run repair:false-deaths [--apply]
 */
import { MongoClient, ObjectId } from 'mongodb'
import { verifyDeathCitation } from '../worker/lib/character-lifecycle-extractor'
import { excerptNamesPerson, excerptShowsSubjectPredicate, narrationOnly } from '../worker/lib/scene-endpoint-adjudicator'

const apply = process.argv.includes('--apply')
const uri = process.env.MONGODB_URI
if (!uri) {
  console.error('MONGODB_URI is required')
  process.exit(1)
}
const client = new MongoClient(uri)
await client.connect()
const db = client.db()

const dead = (await db
  .collection('characters')
  .find({ life_state: 'deceased', is_protagonist: { $ne: true } })
  .project({ canonical_name: 1, aliases: 1, instance_id: 1, life_state_sequence: 1 })
  .toArray()) as any[]

let cleared = 0
let kept = 0
for (const card of dead) {
  const seq = card.life_state_sequence
  const event = (await db
    .collection('events')
    .findOne({ instance_id: card.instance_id, sequence: seq }, { projection: { 'data.ai_response': 1, 'data.character_lifecycle_deltas': 1 } })) as any
  const prose = String(event?.data?.ai_response || '')
  // Match on every surface the card answers to, not just its canonical name:
  // a card renamed after the death (Ollen -> Harbourmaster) no longer matches
  // the delta that killed it, and the repair would report "no evidence" for a
  // death whose evidence is right there.
  const deltas = (event?.data?.character_lifecycle_deltas || []) as any[]
  const surfaces = new Set(
    [card.canonical_name, ...(card.aliases || [])]
      .filter(Boolean)
      .map((n: string) => String(n).toLowerCase().trim()),
  )
  const delta =
    deltas.find((d: any) => surfaces.has(String(d.name_normalized || '').toLowerCase())) ||
    (deltas.length === 1 ? deltas[0] : undefined)
  const evidence = String(delta?.evidence || '')
  const holds = !!prose && !!evidence && verifyDeathCitation({ name: card.canonical_name, aliases: card.aliases, evidence, prose })
  const where = `${String(card.instance_id)} seq ${seq ?? '-'}`
  if (holds) {
    kept++
    console.log(`  KEEP   ${card.canonical_name.padEnd(16)} ${where}  <- ${JSON.stringify(evidence)}`)
    continue
  }
  cleared++
  const names = [card.canonical_name, ...(card.aliases || [])].filter(Boolean)
  const why = !evidence
    ? 'no evidence recorded'
    : !names.some((n: string) => excerptNamesPerson(n, evidence))
      ? 'the excerpt never names them'
      : !names.some((n: string) => excerptShowsSubjectPredicate(n, evidence))
        ? 'the death is not predicated of them'
        : !narrationOnly(prose).includes(evidence)
          ? 'asserted only in dialogue'
          : 'unverified'
  console.log(`  CLEAR  ${card.canonical_name.padEnd(16)} ${where}  ${why}${evidence ? `  <- ${JSON.stringify(evidence)}` : ''}`)
  if (apply) {
    await db
      .collection('characters')
      .updateOne({ _id: card._id }, { $unset: { life_state: '', life_state_sequence: '' }, $set: { updated_at: new Date() } })
  }
}
console.log(`\n${dead.length} deceased cards: ${cleared} unsupported, ${kept} verified.`)
console.log(apply ? 'APPLIED.' : 'Dry run — re-run with --apply to clear the unsupported ones.')
await client.close()
