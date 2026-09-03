/**
 * Replay the PRESENCE admission rule over one save, using the endpoint judge's
 * real per-candidate verdicts and the real prose. The cast is threaded forward
 * turn by turn, because the failure being measured is a wrong admission
 * PERSISTING by carry-forward.
 */
import { ObjectId } from 'mongodb'
import { connectMongo, coll } from '../src/config/mongo'
import { narrationOnly, showsParticipationInPassage } from '../worker/lib/scene-endpoint-adjudicator'
import { hasSceneParticipationGrammar } from '../worker/lib/presence-gap-detector'
import { normalizeEntityName } from '../src/services/entity-graph.service'

const iid = new ObjectId(process.argv[2])
const LO = Number(process.argv[3] || 1)
const HI = Number(process.argv[4] || 999)

async function main() {
  await connectMongo()
  const events: any[] = await coll('events').find({ instance_id: iid }).sort({ sequence: 1 }).toArray()
  const raws: any[] = await coll('extractor_raw').find({ instance_id: iid }).toArray()
  const rawBySeq = new Map(raws.map((r) => [r.sequence, r]))
  const cards: any[] = await coll('characters').find({ instance_id: iid }).toArray()
  const surfacesFor = (label: string): string[] => {
    const key = normalizeEntityName(label)
    const card = cards.find(
      (c) => normalizeEntityName(c.canonical_name) === key || (c.aliases || []).some((a: string) => normalizeEntityName(a) === key),
    )
    return card ? [card.canonical_name, ...(card.aliases || [])].filter(Boolean) : [label]
  }
  const participates = (label: string, prose: string): boolean => {
    const narration = narrationOnly(prose)
    return surfacesFor(label).some(
      (s) => showsParticipationInPassage(s, narration) || hasSceneParticipationGrammar(s, narration, { evidence: 'action' }),
    )
  }

  // Production seeds the opening scene from the AUTHORED cast and drops the
  // protagonist from their own roster. Model both, or every later turn is
  // measured against a room that was never allowed to fill.
  const protagonist = cards.find((c) => c.is_protagonist)
  const protagonistKey = protagonist ? normalizeEntityName(protagonist.canonical_name) : ''
  let cast = new Set<string>()
  let seeded = false
  for (const event of events) {
    if (event.sequence < LO || event.sequence > HI) continue
    const data = event.data || {}
    const prose = String(data.ai_response || '')
    if (!prose) continue
    const raw = rawBySeq.get(event.sequence)
    const verdicts: any[] = raw?.citation_verdicts || []
    const refused = new Set(
      verdicts.filter((v) => !(v.a && v.b && v.c)).map((v) => normalizeEntityName(v.name)).filter(Boolean),
    )
    const shipped: string[] = (data.present_characters || []).filter(
      (n: string) => normalizeEntityName(n) !== protagonistKey,
    )
    // The authored opening carries no cast of its own; production seeds from
    // the first GENERATED turn (`openingScene`). Seed from the first turn that
    // actually has a roster, or the whole run is measured from an empty room.
    if (!seeded) {
      if (!shipped.length) continue
      seeded = true
      cast = new Set(shipped.map((n) => normalizeEntityName(n)))
      continue
    }
    const next = new Set<string>()
    const notes: string[] = []
    for (const name of shipped) {
      const key = normalizeEntityName(name)
      const carried = cast.has(key)
      if (carried) { next.add(key); continue }
      if (refused.has(key)) { notes.push(`REFUSED ${name} (judge rejected its own citation)`); continue }
      if (!participates(name, prose)) { notes.push(`HELD ${name} (narration shows no participation)`); continue }
      next.add(key)
      notes.push(`admit ${name}`)
    }
    cast = next
    const shippedS = shipped.join(', ') || '—'
    const nowS = [...cast].join(', ') || '—'
    if (shippedS !== nowS || notes.some((n) => n.startsWith('REFUSED') || n.startsWith('HELD')))
      console.log(`#${event.sequence}\n   shipped: ${shippedS}\n   now:     ${nowS}\n   ${notes.join(' | ')}`)
  }
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
