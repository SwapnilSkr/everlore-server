/**
 * Freeze ONE live save into the A/B corpus format, using the extractor output
 * production actually produced for it (`extractor_raw.stages`) rather than
 * re-running the models. That output is the CONTROL: replaying a decision
 * change over it attributes the difference to the decision and nothing else.
 *
 *   bun run scripts/corpus-freeze-instance.ts <instanceId> <out.json>
 */
import { writeFileSync } from 'node:fs'
import { ObjectId } from 'mongodb'
import { connectMongo, coll } from '../src/config/mongo'
import type { CorpusTurn } from './corpus-freeze'

const iid = new ObjectId(process.argv[2])
const out = process.argv[3] || 'corpus/save-turns.json'

const parse = (value: unknown): Record<string, unknown> | null => {
  if (!value) return null
  if (typeof value === 'object') return value as Record<string, unknown>
  try {
    return JSON.parse(String(value))
  } catch {
    return null
  }
}

async function main() {
  await connectMongo()
  const instance: any = await coll('world_instances').findOne({ _id: iid })
  const template: any = await coll('world_templates').findOne({ _id: instance.template_id })
  const events: any[] = await coll('events').find({ instance_id: iid }).sort({ sequence: 1 }).toArray()
  const raws: any[] = await coll('extractor_raw').find({ instance_id: iid }).toArray()
  const rawBySeq = new Map(raws.map((r) => [r.sequence, r]))
  const cards: any[] = await coll('characters').find({ instance_id: iid }).toArray()
  const places: any[] = await coll('entities').find({ instance_id: iid, type: 'location' }).toArray()

  const protagonist = cards.find((c) => c.is_protagonist) || null
  const turns: CorpusTurn[] = []
  for (const [i, event] of events.entries()) {
    const data = event.data || {}
    if (!data.ai_response) continue
    const prior = events[i - 1]
    const raw = rawBySeq.get(event.sequence)
    const stages = raw?.stages || {}
    turns.push({
      id: `${String(iid)}:${event.sequence}`,
      instance: String(iid),
      world: template?.title || template?.name || 'save',
      kind: template?.kind || 'world',
      isSentient: !!template?.is_sentient,
      sequence: event.sequence,
      playerInput: String(data.player_input || ''),
      prose: String(data.ai_response || ''),
      context: {
        priorLocation: prior?.location_anchor?.name || null,
        priorPresent: (prior?.data?.present_characters || []) as string[],
        priorPhysical: [],
        // The graph as it stood BEFORE this turn: a place minted later is not
        // something this turn's extractors could have been shown.
        knownPlaces: places
          .filter((p) => (p.first_seen_sequence ?? 0) < event.sequence)
          .map((p) => ({ name: p.canonical_name, aliases: p.aliases || [] })),
        roster: cards
          .filter((c) => !c.is_protagonist && (c.first_seen_sequence ?? 0) <= event.sequence)
          .map((c) => ({ name: c.canonical_name, aliases: c.aliases || [] })),
        protagonist: protagonist
          ? { name: protagonist.canonical_name, aliases: protagonist.aliases || [] }
          : null,
        pov: instance.narration_pov === 'third' ? 'third' : 'first',
      },
      observed: {
        witness: parse(stages.scene_witness),
        endpoint: parse(stages.scene_endpoint),
        committedPlace: event.location_anchor?.name || null,
        committedCast: (data.present_characters || []) as string[],
      },
    })
  }
  writeFileSync(out, `${JSON.stringify(turns, null, 2)}\n`)
  const withWitness = turns.filter((t) => t.observed.witness).length
  console.log(`${turns.length} turns -> ${out}  (witness captured on ${withWitness})`)
  process.exit(0)
}
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
