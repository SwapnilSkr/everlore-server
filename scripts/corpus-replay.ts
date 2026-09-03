/**
 * Replay the frozen corpus through the CURRENT pure verifiers. No LLM calls, no
 * Mongo, no cost — it reads `corpus/turns.json` and the extractions production
 * already returned, and reports what each check would do to them.
 *
 * This is the tool the harness work needed and did not have. Three separate
 * judgement calls this week were argued confidently and then falsified the
 * moment a real sample was replayed; each of those took seconds here.
 *
 * Run: bun run corpus:replay
 */
import { readFileSync } from 'node:fs'
import type { CorpusTurn } from './corpus-freeze'
import { evaluatePresenceCitation } from '../worker/lib/scene-endpoint-adjudicator'
import { evaluateLocationCitation, passageSituatesViewpoint } from '../worker/lib/location-citation'
import { evaluateTimeCitation } from '../worker/lib/time-citation'

const turns: CorpusTurn[] = JSON.parse(readFileSync('corpus/turns.json', 'utf8'))

function pct(n: number, d: number): string {
  return d === 0 ? '   —  ' : `${((n / d) * 100).toFixed(1).padStart(5)}%`
}

// ── PRESENCE CITATIONS ──────────────────────────────────────────────────────
let cites = 0
const presence = { a: 0, b: 0, c: 0, all: 0 }
let cutaways = 0
let judged = 0
let transitions = 0

for (const turn of turns) {
  const endpoint = turn.observed.endpoint
  if (!endpoint) continue
  judged++
  if (endpoint.player_viewpoint_at_end === false) cutaways++
  if (endpoint.scene_transition === true) transitions++
  for (const row of (endpoint.present_at_end as any[]) || []) {
    const verdict = evaluatePresenceCitation({
      name: String(row?.name || ''),
      evidence: String(row?.evidence || ''),
      prose: turn.prose,
    })
    cites++
    if (verdict.a) presence.a++
    if (verdict.b) presence.b++
    if (verdict.c) presence.c++
    if (verdict.a && verdict.b && verdict.c) presence.all++
  }
}

// ── LOCATION CITATIONS ──────────────────────────────────────────────────────
let locClaims = 0
const location = { a: 0, b: 0, c: 0, all: 0, passage: 0 }
let anchored = 0
let anchoredUnsupported = 0
let anchoredContradicted = 0
const contradictions: string[] = []

for (const turn of turns) {
  const witness = turn.observed.witness
  if (!witness) continue
  const place = String(witness.current_location || '')
  if (!place) continue
  locClaims++
  const source =
    witness.location_evidence_source === 'player'
      ? turn.playerInput
      : witness.location_evidence_source === 'narrative'
        ? turn.prose
        : ''
  const people = turn.context.roster.map((card) => card.name)
  const verdict = evaluateLocationCitation({
    place,
    evidence: String(witness.location_evidence || ''),
    source,
    people,
  })
  if (verdict.a) location.a++
  if (verdict.b) location.b++
  if (verdict.c) location.c++
  if (verdict.a && verdict.b && verdict.c) location.all++
  const supported = passageSituatesViewpoint(place, turn.prose, { people })
  if (supported) location.passage++
  // THE ANCHORING MEASURE: the witness returned the place the scene started in,
  // and this passage does not put the viewpoint there.
  const prior = String(turn.context.priorLocation || '')
  if (prior && place.toLowerCase() === prior.toLowerCase()) {
    anchored++
    if (!supported) anchoredUnsupported++
    // "Unsupported" is not "wrong": a quiet continuation names no place at all
    // and the cursor is right to sit still. The real error is when the passage
    // situates the viewpoint at a DIFFERENT place the world already knows and
    // the witness returned the prior one anyway.
    if (!supported) {
      const elsewhere = turn.context.knownPlaces
        .map((known) => known.name)
        .filter((name) => name.toLowerCase() !== place.toLowerCase())
        .find((name) => passageSituatesViewpoint(name, turn.prose, { people }))
      if (elsewhere) {
        anchoredContradicted++
        if (contradictions.length < 12) {
          contradictions.push(`  ${turn.world || turn.instance} seq ${turn.sequence}: held "${place}", passage puts them in "${elsewhere}"`)
        }
      }
    }
  }
}

// ── TIME CITATIONS ──────────────────────────────────────────────────────────
let timeClaims = 0
const time = { a: 0, b: 0, all: 0 }
for (const turn of turns) {
  const witness = turn.observed.witness
  if (!witness?.time_elapsed) continue
  timeClaims++
  const verdict = evaluateTimeCitation({
    label: String(witness.time_elapsed),
    evidence: String(witness.time_evidence || ''),
    source: turn.prose,
  })
  if (verdict.a) time.a++
  if (verdict.b) time.b++
  if (verdict.a && verdict.b) time.all++
}

console.log(`corpus: ${turns.length} turns, ${judged} with a captured endpoint judgement\n`)

console.log('PRESENCE citations')
console.log(`  cited                 ${cites}`)
console.log(`  (a) verbatim          ${pct(presence.a, cites)}  ${presence.a}/${cites}`)
console.log(`  (b) names the person  ${pct(presence.b, cites)}  ${presence.b}/${cites}`)
console.log(`  (c) acting            ${pct(presence.c, cites)}  ${presence.c}/${cites}`)
console.log(`  admits (a∧b∧c)        ${pct(presence.all, cites)}  ${presence.all}/${cites}`)
console.log(`  cutaway rate          ${pct(cutaways, judged)}`)
console.log(`  scene_transition      ${pct(transitions, judged)}  ${transitions}/${judged}`)

console.log('\nLOCATION claims')
console.log(`  claimed               ${locClaims}`)
console.log(`  (a) verbatim          ${pct(location.a, locClaims)}  ${location.a}/${locClaims}`)
console.log(`  (b) names the place   ${pct(location.b, locClaims)}  ${location.b}/${locClaims}`)
console.log(`  (c) situates viewpoint${pct(location.c, locClaims)}  ${location.c}/${locClaims}`)
console.log(`  admits (a∧b∧c)        ${pct(location.all, locClaims)}  ${location.all}/${locClaims}`)
console.log(`  passage supports it   ${pct(location.passage, locClaims)}  ${location.passage}/${locClaims}`)
console.log(`  held the prior place  ${anchored}`)
console.log(`    ...unsupported      ${pct(anchoredUnsupported, anchored)}  ${anchoredUnsupported}/${anchored}   (a quiet turn naming no place is fine)`)
console.log(`    ...CONTRADICTED     ${pct(anchoredContradicted, anchored)}  ${anchoredContradicted}/${anchored}   ← held the old place while the passage put them in another KNOWN one`)
console.log(
  '    (this test can only see places the world already knows — a witness that\n' +
  '     holds the old place while the passage moves them somewhere NEW is invisible\n' +
  '     here, and is what corpus:tier adjudicates head-to-head.)',
)
if (contradictions.length) {
  console.log('\n  anchoring errors:')
  for (const line of contradictions) console.log(line)
}

console.log('\nTIME claims')
console.log(`  claimed               ${timeClaims}`)
console.log(`  (a) verbatim          ${pct(time.a, timeClaims)}`)
console.log(`  (b) span matches      ${pct(time.b, timeClaims)}`)
console.log(`  admits                ${pct(time.all, timeClaims)}`)
