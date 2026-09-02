/**
 * Re-score a finished tier run WITHOUT paying for it again — the whole reason
 * the corpus and the per-tier outputs are frozen.
 *
 * The first scoring pass counted "the witness returned no location" as a lost
 * turn. That is wrong, and inverted the result. On this corpus gpt-4o-mini names
 * a location on 96% of turns and gpt-4o on 50% — but reading the misses shows
 * mini is not more capable, it is less willing to abstain: it answered "the
 * room", "a room", "the table" and an invented "Royal Council Chamber" on
 * passages that establish no setting at all. The witness prompt explicitly
 * forbids the first three. gpt-4o returned null on the same turns.
 *
 * So a null is scored against what the passage actually supports, and a claim is
 * scored for hygiene as well as support.
 *
 * Run: bun run corpus:rescore
 */
import { readFileSync } from 'node:fs'
import type { CorpusTurn } from './corpus-freeze'
import { passageSituatesViewpoint } from '../worker/lib/location-citation'
import { isSafeWitnessLocationCandidate } from '../worker/lib/movement-signal'
import { stratifiedSample } from './corpus-sample'

const turns: CorpusTurn[] = JSON.parse(readFileSync('corpus/turns.json', 'utf8'))
const tiers = JSON.parse(readFileSync('corpus/tier-result.json', 'utf8')) as Array<{
  tier: string
  byTurn: Record<string, { place: string; supported: boolean; cast: string[] }>
}>

const byId = new Map(turns.map((turn) => [turn.id, turn]))
// The SAMPLE, not the union of what the tiers answered — otherwise a turn every
// tier abstained on silently drops out and abstention is undercounted.
const SAMPLE_SIZE = Number(process.argv[2] || 50)
const ids = stratifiedSample(turns, SAMPLE_SIZE)

/** Which turns does the passage itself put the viewpoint at a KNOWN place? */
const supportedPlaceByTurn = new Map<string, string | null>()
for (const turn of ids) {
  const people = turn.context.roster.map((card) => card.name)
  const hit = turn.context.knownPlaces
    .map((known) => known.name)
    .find((name) => passageSituatesViewpoint(name, turn.prose, { people }))
  supportedPlaceByTurn.set(turn.id, hit ?? null)
}

const sampleIds = ids.map((turn) => turn.id)

function pct(n: number, d: number): string {
  return d === 0 ? '   —  ' : `${((n / d) * 100).toFixed(1).padStart(5)}%`
}

interface Score {
  tier: string
  claims: number
  nulls: number
  junk: number
  supported: number
  defensibleNull: number
  missedNull: number
}

const scores: Score[] = tiers.map((tier) => {
  const score: Score = { tier: tier.tier, claims: 0, nulls: 0, junk: 0, supported: 0, defensibleNull: 0, missedNull: 0 }
  for (const id of sampleIds) {
    const turn = byId.get(id)!
    const claim = tier.byTurn[id]
    const knownSupported = supportedPlaceByTurn.get(id) ?? null
    if (!claim) {
      score.nulls++
      // Abstaining is CORRECT when the passage does not put the viewpoint at any
      // place the world knows. It is a miss when it demonstrably does.
      if (knownSupported) score.missedNull++
      else score.defensibleNull++
      continue
    }
    score.claims++
    // A label the hygiene gate refuses is a label that could never have reached
    // the map: "the room", "a room", "here", a person's name, a whole sentence.
    if (!isSafeWitnessLocationCandidate(claim.place, {
      knownPeople: turn.context.roster.map((card) => card.name),
      knownPlaces: turn.context.knownPlaces.map((known) => known.name),
    })) {
      score.junk++
    }
    if (claim.supported) score.supported++
  }
  return score
})

const rows = [
  ['metric', ...scores.map((s) => s.tier)],
  ['turns', ...scores.map((s) => String(s.claims + s.nulls))],
  ['named a place', ...scores.map((s) => `${s.claims} (${pct(s.claims, s.claims + s.nulls)})`)],
  ['  UNUSABLE label', ...scores.map((s) => `${s.junk} (${pct(s.junk, s.claims)})`)],
  ['  passage supports it', ...scores.map((s) => `${s.supported} (${pct(s.supported, s.claims)})`)],
  ['abstained (null)', ...scores.map((s) => `${s.nulls} (${pct(s.nulls, s.claims + s.nulls)})`)],
  ['  correctly', ...scores.map((s) => `${s.defensibleNull} (${pct(s.defensibleNull, s.nulls)})`)],
  ['  MISSED a known place', ...scores.map((s) => `${s.missedNull} (${pct(s.missedNull, s.nulls)})`)],
  ['net usable reads', ...scores.map((s) => `${s.claims - s.junk + s.defensibleNull} / ${s.claims + s.nulls}`)],
]
const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => String(row[col] ?? '').length)))
console.log(`re-scored ${sampleIds.length} turns × ${tiers.length} tiers (free — no LLM calls)\n`)
for (const [i, row] of rows.entries()) {
  console.log(row.map((cell, col) => String(cell ?? '').padEnd(widths[col])).join('  '))
  if (i === 0) console.log(widths.map((w) => '─'.repeat(w)).join('  '))
}

console.log('\nUNUSABLE labels by tier (these are what the vocabulary gate exists to catch):')
for (const tier of tiers) {
  const bad: string[] = []
  for (const id of sampleIds) {
    const claim = tier.byTurn[id]
    if (!claim) continue
    const turn = byId.get(id)!
    if (!isSafeWitnessLocationCandidate(claim.place, {
      knownPeople: turn.context.roster.map((c) => c.name),
      knownPlaces: turn.context.knownPlaces.map((k) => k.name),
    })) {
      bad.push(`"${claim.place}"`)
    }
  }
  console.log(`  ${tier.tier.padEnd(26)} ${bad.length ? [...new Set(bad)].join(', ') : '—'}`)
}


// ── AGREEMENT ───────────────────────────────────────────────────────────────
// Most "disagreements" in the raw tier run were article variants of one place:
// "the hall" vs "hall", "studio" vs "the studio", "street" vs "the street".
// That is not model instability, it is an unnormalized seam — and downstream it
// mints a duplicate place node every time the article flips.
function normalizePlace(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/^(?:the|a|an|my|our)\s+/, '')
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

console.log('\n\nPAIRWISE AGREEMENT on turns where BOTH tiers named a place')
const header = ['', ...tiers.map((t) => t.tier.slice(0, 12))]
const table: string[][] = [header]
for (const left of tiers) {
  const row = [left.tier.slice(0, 22)]
  for (const right of tiers) {
    if (left.tier === right.tier) {
      row.push('—')
      continue
    }
    let both = 0
    let exact = 0
    let normalized = 0
    for (const id of sampleIds) {
      const a = left.byTurn[id]?.place
      const b = right.byTurn[id]?.place
      if (!a || !b) continue
      both++
      if (a === b) exact++
      if (normalizePlace(a) === normalizePlace(b)) normalized++
    }
    row.push(both ? `${exact}/${both} → ${normalized}/${both}` : '—')
  }
  table.push(row)
}
const w = table[0].map((_, col) => Math.max(...table.map((r) => String(r[col] ?? '').length)))
for (const [i, row] of table.entries()) {
  console.log(row.map((cell, col) => String(cell ?? '').padEnd(w[col])).join('  '))
  if (i === 0) console.log(w.map((x) => '─'.repeat(x)).join('  '))
}
console.log('  (exact match → match after stripping the leading article and casing)')

let articleOnly = 0
let totalPairs = 0
for (const id of sampleIds) {
  for (let i = 0; i < tiers.length; i++) {
    for (let j = i + 1; j < tiers.length; j++) {
      const a = tiers[i].byTurn[id]?.place
      const b = tiers[j].byTurn[id]?.place
      if (!a || !b) continue
      totalPairs++
      if (a !== b && normalizePlace(a) === normalizePlace(b)) articleOnly++
    }
  }
}
console.log(`\n  ${articleOnly}/${totalPairs} cross-tier place pairs differ ONLY by article/casing.`)
