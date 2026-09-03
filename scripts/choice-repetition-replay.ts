/**
 * Does the choice half stop re-offering what the player has already passed on?
 *
 * Replays a run of real turns through the choice extractor twice: once with no
 * memory of what it has offered (how it shipped) and once with the recent
 * labels supplied, threading its OWN suggestions forward so the second run is
 * judged on the set it actually produced. Read-only.
 *
 * NOTE: the recent labels are NOT shown to the model — that was tried and made
 * repetition worse. They are applied by `dropRepeatedChoices` after generation.
 *
 *   bun run scripts/choice-repetition-replay.ts <instanceId> <lo> <hi>
 */
import { ObjectId } from 'mongodb'
import { connectMongo, coll } from '../src/config/mongo'
import { extractChoiceMetadata, statDescriptors } from '../worker/lib/metadata-extractor'

const iid = new ObjectId(process.argv[2])
const LO = Number(process.argv[3] || 1)
const HI = Number(process.argv[4] || 999)
const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim()

async function main() {
  await connectMongo()
  const instance: any = await coll('world_instances').findOne({ _id: iid })
  const events: any[] = await coll('events').find({ instance_id: iid }).sort({ sequence: 1 }).toArray()
  const cards: any[] = await coll('characters').find({ instance_id: iid }).toArray()
  const protagonist = cards.find((c) => c.is_protagonist)
  const stats = statDescriptors(instance.stat_definitions || instance.world_state)
  const flags = Object.keys(instance.active_flags || {})
  const opts = {
    isSentient: false,
    protagonist: protagonist ? { name: protagonist.canonical_name, aliases: protagonist.aliases } : null,
    roster: cards.filter((c) => !c.is_protagonist).map((c) => ({ name: c.canonical_name, aliases: c.aliases })),
  }

  const runs: Record<string, { labels: string[][]; offered: string[] }> = {
    blind: { labels: [], offered: [] },
    informed: { labels: [], offered: [] },
  }
  for (const event of events) {
    if (event.sequence < LO || event.sequence > HI || !event.data?.ai_response) continue
    const prose = String(event.data.ai_response)
    const playerInput = String(event.data.player_input || '')
    for (const mode of ['blind', 'informed'] as const) {
      const run = runs[mode]
      const recent = mode === 'informed' ? [...new Set(run.offered)].slice(-24) : []
      try {
        const meta = await extractChoiceMetadata(prose, stats, flags, {
          ...opts,
          playerInput,
          recentChoiceLabels: recent,
        } as never)
        const labels = ((meta as any).choices || []).map((c: any) => String(c.label || '')).filter(Boolean)
        run.labels.push(labels)
        // The player's actual input for this turn answers whatever was offered;
        // everything else stays unanswered and carries forward.
        run.offered = [...run.offered, ...labels].filter((l) => norm(l) !== norm(playerInput))
      } catch {
        run.labels.push([])
      }
    }
  }

  console.log(`\nturns replayed: ${runs.blind.labels.length}\n`)
  for (const mode of ['blind', 'informed'] as const) {
    const all = runs[mode].labels.flat()
    const counts = new Map<string, number>()
    for (const l of all) counts.set(norm(l), (counts.get(norm(l)) || 0) + 1)
    const repeats = [...counts.values()].filter((n) => n > 1).reduce((a, n) => a + (n - 1), 0)
    console.log(`${mode.toUpperCase().padEnd(9)} offered ${String(all.length).padStart(3)}  distinct ${String(counts.size).padStart(3)}  repeats ${String(repeats).padStart(3)}  worst ${Math.max(0, ...counts.values())}x`)
    const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4).filter(([, n]) => n > 1)
    for (const [l, n] of top) console.log(`            ${n}x  ${l}`)
  }
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
