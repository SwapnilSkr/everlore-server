/**
 * TIER EXPERIMENT — re-run the scene witness and the endpoint judge over the
 * frozen corpus at several model tiers, and score them against each other.
 *
 * Every cognitive call in this system runs on one cheap model. The word lists,
 * the corroborators and the citation stack all exist to compensate for that
 * model being unreliable, and nobody has ever tested whether a better model at
 * this seam removes the need for most of it. That is what this measures.
 *
 * COSTS REAL MONEY. Sample size and tiers are arguments.
 *   bun run corpus:tier [turns] [tier,tier,...] [merge]
 *
 * `merge` folds in the tiers already in corpus/tier-result.json, so an extra
 * tier can be added later without re-paying for the ones already measured. The
 * sample is deterministic for a given corpus + size, so the turns line up.
 *
 * Scoring is automatic where it can be:
 *   - schema validity (a fallback means the turn's read was lost outright)
 *   - location: does the passage actually situate the viewpoint at the claim?
 *   - presence: how many cited people survive (a)(b)(c)
 *   - tokens, latency
 * Head-to-head location disagreements are adjudicated by passage support, and
 * anything that stays ambiguous is printed for a human to read.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { CorpusTurn } from './corpus-freeze'
import { stratifiedSample } from './corpus-sample'
import { extractSceneWitness } from '../worker/lib/metadata-extractor'
import { adjudicateSceneEndpoint, evaluatePresenceCitation } from '../worker/lib/scene-endpoint-adjudicator'
import { passageSituatesViewpoint } from '../worker/lib/location-citation'
import { runWithLLMUsage, snapshotLLMUsage } from '../src/ai'

const SAMPLE = Number(process.argv[2] || 60)
const TIERS = (process.argv[3] || 'gpt-4o-mini,gpt-4o,google/gemini-2.5-flash').split(',').map((t) => t.trim())
const MERGE = process.argv[4] === 'merge'

const all: CorpusTurn[] = JSON.parse(readFileSync('corpus/turns.json', 'utf8'))

const sample = stratifiedSample(all, SAMPLE)

interface TierResult {
  tier: string
  turns: number
  witnessFallbacks: number
  locationClaimed: number
  locationSupported: number
  heldPrior: number
  cites: number
  citeA: number
  citeB: number
  citeC: number
  citeAll: number
  transitions: number
  endpointFailures: number
  promptTokens: number
  completionTokens: number
  ms: number
  byTurn: Map<string, { place: string; supported: boolean; cast: string[] }>
}

function blank(tier: string): TierResult {
  return {
    tier, turns: 0, witnessFallbacks: 0, locationClaimed: 0, locationSupported: 0, heldPrior: 0,
    cites: 0, citeA: 0, citeB: 0, citeC: 0, citeAll: 0, transitions: 0, endpointFailures: 0,
    promptTokens: 0, completionTokens: 0, ms: 0, byTurn: new Map(),
  }
}

const results: TierResult[] = []

if (MERGE && existsSync('corpus/tier-result.json')) {
  const prior = JSON.parse(readFileSync('corpus/tier-result.json', 'utf8')) as any[]
  for (const row of prior) {
    if (TIERS.includes(row.tier)) continue
    results.push({ ...row, byTurn: new Map(Object.entries(row.byTurn || {})) } as TierResult)
  }
  console.log(`merging ${results.length} previously measured tier(s): ${results.map((r) => r.tier).join(', ')}`)
}

for (const tier of TIERS) {
  const result = blank(tier)
  console.log(`\n──────── ${tier} ────────`)
  for (const [index, turn] of sample.entries()) {
    const people = turn.context.roster.map((card) => card.name)
    const started = Date.now()
    try {
      await runWithLLMUsage(async () => {
        const [witness, endpoint] = await Promise.all([
          extractSceneWitness(turn.prose, {
            model: tier,
            playerInput: turn.playerInput,
            isSentient: turn.isSentient,
            currentLocationName: turn.context.priorLocation,
            priorPresent: turn.context.priorPresent,
            priorPhysical: turn.context.priorPhysical,
            knownPlaces: turn.context.knownPlaces,
            protagonist: turn.context.protagonist,
            roster: turn.context.roster,
          }),
          adjudicateSceneEndpoint({
            model: tier,
            prose: turn.prose,
            playerInput: turn.playerInput,
            candidates: [...turn.context.priorPresent, ...people],
          }),
        ])
        result.turns++
        // A witness that fell back returned no location AND no cast — the turn's
        // whole read is gone, which is the failure the lists exist to survive.
        const place = String(witness.current_location || '')
        if (!place && !(witness.present_characters || []).length) result.witnessFallbacks++
        if (place) {
          result.locationClaimed++
          const supported = passageSituatesViewpoint(place, turn.prose, { people })
          if (supported) result.locationSupported++
          if (
            turn.context.priorLocation &&
            place.toLowerCase() === String(turn.context.priorLocation).toLowerCase()
          ) {
            result.heldPrior++
          }
          result.byTurn.set(turn.id, {
            place,
            supported,
            cast: witness.present_characters || [],
          })
        }
        if (!endpoint.available) result.endpointFailures++
        if (endpoint.sceneTransition) result.transitions++
        for (const verdict of endpoint.citationVerdicts) {
          result.cites++
          if (verdict.a) result.citeA++
          if (verdict.b) result.citeB++
          if (verdict.c) result.citeC++
          if (verdict.a && verdict.b && verdict.c) result.citeAll++
        }
        for (const call of snapshotLLMUsage()) {
          result.promptTokens += call.prompt_tokens
          result.completionTokens += call.completion_tokens
        }
      })
    } catch (err) {
      console.log(`  ! turn ${turn.id}: ${(err as Error).message}`)
    }
    result.ms += Date.now() - started
    if ((index + 1) % 10 === 0) process.stdout.write(`  ${index + 1}/${sample.length}\n`)
  }
  results.push(result)
}

function pct(n: number, d: number): string {
  return d === 0 ? '  —  ' : `${((n / d) * 100).toFixed(1).padStart(5)}%`
}

console.log(`\n\n════════ ${sample.length} turns × ${TIERS.length} tiers ════════\n`)
const rows = [
  ['metric', ...results.map((r) => r.tier)],
  ['turns completed', ...results.map((r) => String(r.turns))],
  ['witness lost the turn', ...results.map((r) => `${r.witnessFallbacks} (${pct(r.witnessFallbacks, r.turns)})`)],
  ['endpoint judge failed', ...results.map((r) => `${r.endpointFailures} (${pct(r.endpointFailures, r.turns)})`)],
  ['named a location', ...results.map((r) => pct(r.locationClaimed, r.turns))],
  ['  passage supports it', ...results.map((r) => `${pct(r.locationSupported, r.locationClaimed)} (${r.locationSupported}/${r.locationClaimed})`)],
  ['  held the prior place', ...results.map((r) => pct(r.heldPrior, r.locationClaimed))],
  ['scene_transition', ...results.map((r) => pct(r.transitions, r.turns))],
  ['presence citations', ...results.map((r) => String(r.cites))],
  ['  (a) verbatim', ...results.map((r) => pct(r.citeA, r.cites))],
  ['  (b) names person', ...results.map((r) => pct(r.citeB, r.cites))],
  ['  (c) acting', ...results.map((r) => pct(r.citeC, r.cites))],
  ['  survives (a∧b∧c)', ...results.map((r) => pct(r.citeAll, r.cites))],
  ['prompt tokens', ...results.map((r) => String(r.promptTokens))],
  ['completion tokens', ...results.map((r) => String(r.completionTokens))],
  ['ms / turn', ...results.map((r) => String(Math.round(r.ms / Math.max(1, r.turns))))],
]
const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => String(row[col] ?? '').length)))
for (const [i, row] of rows.entries()) {
  console.log(row.map((cell, col) => String(cell ?? '').padEnd(widths[col])).join('  '))
  if (i === 0) console.log(widths.map((w) => '─'.repeat(w)).join('  '))
}

// ── HEAD-TO-HEAD LOCATION DISAGREEMENTS ─────────────────────────────────────
const base = results[0]
const disagreements: string[] = []
const adjudicated = new Map<string, { wins: number }>(results.map((r) => [r.tier, { wins: 0 }]))
let ambiguous = 0

for (const turn of sample) {
  const claims = results.map((r) => ({ tier: r.tier, claim: r.byTurn.get(turn.id) })).filter((c) => c.claim)
  if (claims.length < 2) continue
  const distinct = new Set(claims.map((c) => c.claim!.place.toLowerCase()))
  if (distinct.size < 2) continue
  // Passage support alone is not enough to call a winner: it rewards whatever
  // noun the prose literally attaches the viewpoint to, and furniture takes a
  // room's grammar ("at the table" beat "the royal council chamber" on the very
  // first disagreement). Report both axes and let a human read the rest.
  const known = new Set(turn.context.knownPlaces.map((p) => p.name.toLowerCase()))
  const supported = claims.filter((c) => c.claim!.supported)
  const onMap = claims.filter((c) => known.has(c.claim!.place.toLowerCase()))
  if (supported.length > 0 && supported.length < claims.length) {
    for (const winner of supported) adjudicated.get(winner.tier)!.wins++
  } else {
    ambiguous++
  }
  if (disagreements.length < 30) {
    disagreements.push(
      `  ${(turn.world || turn.instance).slice(0, 28).padEnd(28)} seq ${String(turn.sequence).padStart(3)}  prior="${turn.context.priorLocation ?? '—'}"\n` +
        claims
          .map(
            (c) =>
              `      ${c.claim!.supported ? 'passage' : '       '} ${known.has(c.claim!.place.toLowerCase()) ? 'onmap' : '     '}  ${c.tier.padEnd(24)} "${c.claim!.place}"`,
          )
          .join('\n'),
    )
  }
  void onMap
}

console.log('\n\nLOCATION DISAGREEMENTS')
console.log('  "passage" = the prose situates the viewpoint there; "onmap" = the world already knows that place.')
console.log('  Neither is ground truth on its own — passage support rewards furniture. Read these.')
for (const [tier, score] of adjudicated) console.log(`  ${tier.padEnd(26)} won ${score.wins}`)
console.log(`  unadjudicable (all or none supported): ${ambiguous}`)
if (disagreements.length) {
  console.log('\n' + disagreements.join('\n'))
}

writeFileSync(
  'corpus/tier-result.json',
  `${JSON.stringify(
    results.map((r) => ({ ...r, byTurn: Object.fromEntries(r.byTurn) })),
    null,
    2,
  )}\n`,
)
console.log('\nwrote corpus/tier-result.json')
