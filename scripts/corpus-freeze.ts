/**
 * Freeze a REPLAY CORPUS: real turns, with the prose, the player's text, and the
 * exact context the extractors were given, written to a versioned file in the
 * repo.
 *
 * This exists because every judgement call in the harness work so far has been
 * argued rather than measured, and three of them turned out wrong the moment a
 * real sample was replayed. A frozen corpus makes "does this change help or
 * hurt" a question you answer offline, for free, in seconds — see
 * `corpus-replay.ts` (free, pure verifiers) and `corpus-tier.ts` (paid, re-runs
 * the extractors at different model tiers).
 *
 * Read-only against Mongo. Run: bun run corpus:freeze [limit]
 */
import { MongoClient, ObjectId } from 'mongodb'
import { mkdir, writeFile } from 'node:fs/promises'

export interface CorpusTurn {
  id: string
  instance: string
  world: string
  kind: string
  isSentient: boolean
  sequence: number
  playerInput: string
  prose: string
  /** Exactly what the extractors are handed on this turn. */
  context: {
    priorLocation: string | null
    priorPresent: string[]
    priorPhysical: string[]
    knownPlaces: { name: string; aliases?: string[] }[]
    roster: { name: string; aliases?: string[] }[]
    protagonist: { name?: string | null; aliases?: string[] } | null
    /** How the narration refers to the player. Third person on most saves. */
    pov?: 'first' | 'third'
  }
  /** What production actually returned for this turn, when it was captured. */
  observed: {
    witness: Record<string, unknown> | null
    endpoint: Record<string, unknown> | null
    committedPlace: string | null
    committedCast: string[]
  }
}

const limit = Number(process.argv[2] || 400)
const uri = process.env.MONGODB_URI
if (!uri) {
  console.error('MONGODB_URI is required')
  process.exit(1)
}

const client = new MongoClient(uri)
await client.connect()
const db = client.db()

function jsonOrNull(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const events = (await db
  .collection('events')
  .find({ 'data.ai_response': { $exists: true, $ne: '' } })
  .sort({ instance_id: 1, sequence: 1 })
  .toArray()) as any[]

const instanceIds = [...new Set(events.map((e) => String(e.instance_id)))]
const instances = new Map<string, any>()
const templates = new Map<string, any>()
const rosters = new Map<string, { name: string; aliases?: string[] }[]>()
const protagonists = new Map<string, { name?: string | null; aliases?: string[] } | null>()
const places = new Map<string, { name: string; aliases?: string[] }[]>()

for (const id of instanceIds) {
  const iid = new ObjectId(id)
  const instance = await db.collection('world_instances').findOne({ _id: iid })
  if (!instance) continue
  instances.set(id, instance)
  const template = instance.template_id
    ? await db.collection('world_templates').findOne({ _id: instance.template_id })
    : null
  if (template) templates.set(id, template)

  const cards = (await db.collection('characters').find({ instance_id: iid }).toArray()) as any[]
  rosters.set(
    id,
    cards
      .filter((card) => !card.is_protagonist)
      .map((card) => ({ name: String(card.canonical_name || ''), aliases: card.aliases || [] }))
      .filter((card) => card.name),
  )
  const protagonistCard = cards.find((card) => card.is_protagonist)
  protagonists.set(
    id,
    protagonistCard
      ? { name: protagonistCard.canonical_name, aliases: protagonistCard.aliases || [] }
      : instance.persona_snapshot?.name
        ? { name: instance.persona_snapshot.name }
        : null,
  )

  const placeDocs = (await db
    .collection('entities')
    .find({ instance_id: iid, type: 'location' })
    .toArray()) as any[]
  places.set(
    id,
    placeDocs
      .map((doc) => ({ name: String(doc.canonical_name || ''), aliases: doc.aliases || [] }))
      .filter((p) => p.name),
  )
}

const raws = new Map<string, any>()
for (const row of (await db.collection('extractor_raw').find({}).toArray()) as any[]) {
  raws.set(`${String(row.instance_id)}:${row.sequence}`, row)
}

const turns: CorpusTurn[] = []
const priorByInstance = new Map<string, { place: string | null; cast: string[]; physical: string[] }>()

for (const event of events) {
  const instanceId = String(event.instance_id)
  const instance = instances.get(instanceId)
  if (!instance) continue
  const template = templates.get(instanceId)
  const prior = priorByInstance.get(instanceId) || { place: null, cast: [], physical: [] }
  const sceneState = event.data?.scene_state
  // `scene_state` only started being written on 2026-09-02, so deriving the
  // prior place from it left it null on almost every historical turn — which
  // silently turned the whole corpus into a cold-start benchmark, asking every
  // extractor to establish a location from nothing on every turn. The event's
  // own `location_anchor` has been written all along and covers 252/346 turns.
  const anchorName = event.location_anchor?.name ?? sceneState?.place?.name ?? null

  const prose = String(event.data?.ai_response || '')
  const playerInput = String(event.data?.player_input || '')
  // The authored opening has no player turn and no extraction to compare.
  if (prose.trim() && event.data?.model_used !== 'seed') {
    const raw = raws.get(`${instanceId}:${event.sequence}`)
    turns.push({
      id: `${instanceId}:${event.sequence}`,
      instance: instanceId,
      world: String(template?.title || ''),
      kind: String(template?.kind || ''),
      isSentient: template?.is_sentient === true,
      sequence: event.sequence,
      playerInput,
      prose,
      context: {
        priorLocation: prior.place,
        priorPresent: prior.cast,
        priorPhysical: prior.physical,
        knownPlaces: places.get(instanceId) || [],
        roster: rosters.get(instanceId) || [],
        protagonist: protagonists.get(instanceId) || null,
      },
      observed: {
        witness: jsonOrNull(raw?.stages?.scene_witness),
        endpoint: jsonOrNull(raw?.stages?.scene_endpoint),
        committedPlace: anchorName,
        committedCast: (sceneState?.cast || []).map((m: any) => String(m.name)),
      },
    })
  }

  priorByInstance.set(instanceId, {
    place: anchorName ?? prior.place,
    cast: (sceneState?.cast || []).map((m: any) => String(m.name)),
    physical: (sceneState?.physical || []).map((f: any) => String(f.statement)),
  })
}

const selected = turns.slice(-limit)
await mkdir('corpus', { recursive: true })
await writeFile('corpus/turns.json', `${JSON.stringify(selected, null, 2)}\n`)

const byWorld = new Map<string, number>()
for (const turn of selected) byWorld.set(turn.instance, (byWorld.get(turn.instance) || 0) + 1)
const withPrior = selected.filter((t) => t.context.priorLocation).length
const withWitness = selected.filter((t) => t.observed.witness).length
const withEndpoint = selected.filter((t) => t.observed.endpoint).length

console.log(`corpus/turns.json — ${selected.length} turns across ${byWorld.size} worlds`)
console.log(`  prior location known ${withPrior}`)
console.log(`  captured witness  ${withWitness}`)
console.log(`  captured endpoint ${withEndpoint}`)
console.log('\ndepth distribution (turns per world):')
for (const [instance, n] of [...byWorld.entries()].sort((a, b) => b[1] - a[1])) {
  const sample = selected.find((t) => t.instance === instance)!
  console.log(`  ${String(n).padStart(3)}  ${sample.kind.padEnd(10)} ${sample.world || instance}`)
}
await client.close()
