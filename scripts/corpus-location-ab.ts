/**
 * CONTROLLED BEFORE/AFTER for the location cursor.
 *
 * Both decision stacks are replayed over the SAME turns with the SAME extractor
 * output, so any difference is the decision logic and not model noise. Each
 * stack threads its OWN cursor forward through the world in sequence order —
 * that is the entire point, because the failure being measured is a wrong cursor
 * PERSISTING, which a per-turn comparison cannot see.
 *
 * Extractor calls are made once per turn and shared by both stacks.
 *
 * Run: bun run corpus:location-ab <instanceIds> <minSeq>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { CorpusTurn } from './corpus-freeze'
import type { GoldLabel } from './corpus-gold'
import { extractSceneWitness } from '../worker/lib/metadata-extractor'
import { isSafeWitnessLocationCandidate } from '../worker/lib/movement-signal'
import { adjudicateSceneEndpoint } from '../worker/lib/scene-endpoint-adjudicator'
import { decideLocation, decideLocationLegacy, type LocationDecisionInput } from '../worker/lib/location-decision'
import type { DriftState } from '../worker/lib/cursor-drift'

const instances = new Set((process.argv[2] || '').split(',').filter(Boolean))
const minSeq = Number(process.argv[3] || 0)
const turns: CorpusTurn[] = JSON.parse(readFileSync(process.env.CORPUS_TURNS || 'corpus/turns.json', 'utf8'))
/**
 * Ground truth. `gold-hand.json` is hand-labelled: every one of these 74 turns
 * was read and labelled by a person, with an ACCEPTED SET rather than a single
 * string, because several turns have more than one defensible answer — "the
 * bar" and "Split Lamp" are the same room, and "the north wall" is a station
 * inside "the hall". The model-written `gold-shipped.json` verified at ~67% on
 * the hard subset, which is not a usable instrument for a 99% target: it cannot
 * distinguish a naming dispute from a wrong position, and it scored three of
 * these turns wrong itself.
 */
interface HandLabel { accepted: string[]; primary: string; note?: string }
const handPath = process.env.GOLD_HAND || 'corpus/gold-hand.json'
const hand: Record<string, HandLabel> = existsSync(handPath) ? JSON.parse(readFileSync(handPath, 'utf8')) : {}
/** The player's typed travel destinations — see `corpus:travel-actions`. */
const travel: Record<string, string> = existsSync('corpus/travel-actions.json')
  ? JSON.parse(readFileSync('corpus/travel-actions.json', 'utf8'))
  : {}
const gold: Record<string, GoldLabel> = existsSync(process.env.GOLD_MODEL || 'corpus/gold-shipped.json')
  ? JSON.parse(readFileSync(process.env.GOLD_MODEL || 'corpus/gold-shipped.json', 'utf8'))
  : {}

const selected = turns
  .filter((t) => instances.has(t.instance) && t.sequence >= minSeq && (hand[t.id] || gold[t.id]))
  .sort((a, b) => (a.instance === b.instance ? a.sequence - b.sequence : a.instance.localeCompare(b.instance)))

/** Extractor output is cached on disk: it is the CONTROL and must not vary. */
// `ab-extractions.json` is the frozen CONTROL for the three keeper worlds and
// must not be regenerated. A held-out run points AB_CACHE at its own file so a
// world the corpus never captured can be extracted without touching it.
const cachePath = process.env.AB_CACHE || 'corpus/ab-extractions.json'
const cache: Record<string, { witness: any; endpoint: any }> = existsSync(cachePath)
  ? JSON.parse(readFileSync(cachePath, 'utf8'))
  : {}

/** Mirrors the processor: the graph's memory of a mistake is not authority. */
for (const turn of selected) {
  turn.context.knownPlaces = turn.context.knownPlaces.filter((place) =>
    isSafeWitnessLocationCandidate(place.name),
  )
}

for (const [i, turn] of selected.entries()) {
  if (cache[turn.id]) continue
  const people = turn.context.roster.map((c) => c.name)
  const witness =
    turn.observed.witness ??
    (await extractSceneWitness(turn.prose, {
      playerInput: turn.playerInput,
      isSentient: turn.isSentient,
      currentLocationName: turn.context.priorLocation,
      priorPresent: turn.context.priorPresent,
      knownPlaces: turn.context.knownPlaces,
      protagonist: turn.context.protagonist,
      roster: turn.context.roster,
    }).catch(() => null))
  const endpoint = await adjudicateSceneEndpoint({
    prose: turn.prose,
    playerInput: turn.playerInput,
    candidates: [...turn.context.priorPresent, ...people],
  }).catch(() => null)
  cache[turn.id] = { witness, endpoint: endpoint ? { available: endpoint.available, sceneTransition: endpoint.sceneTransition, location: endpoint.location } : null }
  if ((i + 1) % 10 === 0) {
    console.log(`  extracted ${i + 1}/${selected.length}`)
    writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`)
  }
}
writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`)

const norm = (v: string) =>
  v.toLowerCase().replace(/^(?:the|a|an|my|our)\s+/, '').replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim()
const stem = (t: string) => t.replace(/(?:es|s)$/, '')
const toks = (v: string) => new Set(norm(v).split(' ').filter((t) => t.length >= 3).map(stem))
function same(a: string, b: string): boolean {
  if (norm(a) === norm(b)) return true
  const [x, y] = [toks(a), toks(b)]
  if (!x.size || !y.size) return false
  const shared = [...x].filter((t) => y.has(t)).length
  return shared > 0 && shared === Math.min(x.size, y.size)
}

interface Run {
  label: string
  right: number
  wrong: number
  placehood: number
  unset: number
  moves: number
  rows: string[]
}

function replay(label: string, decide: (input: LocationDecisionInput) => ReturnType<typeof decideLocation>): Run {
  const run: Run = { label, right: 0, wrong: 0, placehood: 0, unset: 0, moves: 0, rows: [] }
  let cursor: string | null = null
  let drift: DriftState | null = null
  let instance = ''
  for (const turn of selected) {
    if (turn.instance !== instance) {
      instance = turn.instance
      cursor = turn.context.priorLocation
      drift = null
    }
    const entry = cache[turn.id]
    if (!entry?.witness) continue
    const w = entry.witness
    const decision = decide({
      isContinuation: false,
      playerInput: turn.playerInput,
      narrative: turn.prose,
      cursorName: cursor,
      knownPeople: turn.context.roster.map((c) => c.name),
      knownPlaceNames: turn.context.knownPlaces.map((p) => p.name),
      witness: {
        current_location: w.current_location ?? null,
        player_destination: w.player_destination ?? null,
        player_travel_confirmed: w.player_travel_confirmed === true,
        viewpoint_moved: w.viewpoint_moved === true,
        location_evidence: w.location_evidence ?? null,
        location_evidence_source: w.location_evidence_source ?? null,
      },
      actionDestination: travel[turn.id] ?? null,
      endpoint: entry.endpoint,
      priorDrift: drift,
      sequence: turn.sequence,
      viewpoint: {
        surfaces: [turn.context.protagonist?.name || '', ...(turn.context.protagonist?.aliases || [])].filter(Boolean),
        thirdPerson: turn.context.pov === 'third',
      },
    })
    drift = decision.drift.next
    if (decision.placeName && (decision.viewpointMoved || !cursor)) {
      if (decision.viewpointMoved) run.moves++
      cursor = decision.placeName
    }
    const h = hand[turn.id]
    const g = gold[turn.id]
    if (!cursor) run.unset++
    else if (h ? h.accepted.some((name) => same(cursor!, name)) : g.place && same(cursor, g.place))
      run.right++
    else if (!h && g.place && same(cursor, g.place)) run.placehood++
    else {
      run.wrong++
      if (run.rows.length < 60) {
        run.rows.push(
          `    ${(turn.world || '').slice(0, 20).padEnd(20)} seq ${String(turn.sequence).padStart(3)}  ` +
            `cursor=${JSON.stringify(cursor).padEnd(22)} truth=${JSON.stringify(h ? h.primary : g.place)}`,
        )
      }
    }
  }
  return run
}

const before = replay('legacy (pre-citation stack)', decideLocationLegacy)
const after = replay('current', decideLocation)
const n = before.right + before.wrong + before.placehood + before.unset

console.log(`\n\nCONTROLLED A/B — ${n} turns, identical extractor output, cursors threaded independently\n`)
const rows = [
  ['metric', before.label, after.label],
  ['correct', `${before.right} (${((before.right / n) * 100).toFixed(1)}%)`, `${after.right} (${((after.right / n) * 100).toFixed(1)}%)`],
  ['WRONG place', `${before.wrong} (${((before.wrong / n) * 100).toFixed(1)}%)`, `${after.wrong} (${((after.wrong / n) * 100).toFixed(1)}%)`],
  ['placehood dispute', String(before.placehood), String(after.placehood)],
  ['cursor never set', String(before.unset), String(after.unset)],
  ['moves committed', String(before.moves), String(after.moves)],
]
const w = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)))
for (const [i, row] of rows.entries()) {
  console.log(row.map((cell, c) => cell.padEnd(w[c])).join('  '))
  if (i === 0) console.log(w.map((x) => '─'.repeat(x)).join('  '))
}
for (const run of [before, after]) {
  if (run.rows.length) console.log(`\n  ${run.label} — wrong:\n${run.rows.join('\n')}`)
}
