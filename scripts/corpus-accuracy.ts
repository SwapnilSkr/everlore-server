/**
 * ACCURACY — the first number in this project that says whether the system was
 * RIGHT, rather than whether its output survived a verifier.
 *
 * Scores each measured tier's location and cast read against `corpus/gold.json`.
 * Free: no LLM calls, both files are frozen.
 *
 * Run: bun run corpus:accuracy [turns]
 */
import { readFileSync } from 'node:fs'
import type { CorpusTurn } from './corpus-freeze'
import type { GoldLabel } from './corpus-gold'
import { stratifiedSample } from './corpus-sample'

const turns: CorpusTurn[] = JSON.parse(readFileSync('corpus/turns.json', 'utf8'))
const gold: Record<string, GoldLabel> = JSON.parse(readFileSync('corpus/gold.json', 'utf8'))
const tiers = JSON.parse(readFileSync('corpus/tier-result.json', 'utf8')) as Array<{
  tier: string
  byTurn: Record<string, { place: string; supported: boolean; cast: string[] }>
}>

const sample = stratifiedSample(turns, Number(process.argv[2] || 50)).filter((t) => gold[t.id])

function norm(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/^(?:the|a|an|my|our|his|her|their)\s+/, '')
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
function tokens(value: string): Set<string> {
  return new Set(norm(value).split(' ').filter((t) => t.length >= 3))
}
/** Same place, allowing for the label the passage used vs the one the model
 *  chose ("root cellars" ~ "the cellars", "Split Lamp" ~ "the Split Lamp"). */
function samePlace(a: string, b: string): boolean {
  if (norm(a) === norm(b)) return true
  const [x, y] = [tokens(a), tokens(b)]
  if (!x.size || !y.size) return false
  const shared = [...x].filter((t) => y.has(t)).length
  return shared > 0 && shared === Math.min(x.size, y.size)
}

interface Acc {
  tier: string
  n: number
  locRight: number
  locWrong: number
  locHallucinated: number
  locAbstainRight: number
  locAbstainWrong: number
  furniture: number
  castTP: number
  castFP: number
  castFN: number
  castExact: number
}

const scores: Acc[] = tiers.map((tier) => {
  const acc: Acc = {
    tier: tier.tier, n: 0, locRight: 0, locWrong: 0, locHallucinated: 0,
    locAbstainRight: 0, locAbstainWrong: 0, furniture: 0,
    castTP: 0, castFP: 0, castFN: 0, castExact: 0,
  }
  for (const turn of sample) {
    const g = gold[turn.id]
    const got = tier.byTurn[turn.id]
    acc.n++

    if (!got) {
      if (g.place && g.placeIsSpace) acc.locAbstainWrong++
      else acc.locAbstainRight++
    } else if (!g.place || !g.placeIsSpace) {
      // Gold says the passage establishes no SPACE. Naming one is invention.
      acc.locHallucinated++
      if (g.place && !g.placeIsSpace && samePlace(got.place, g.place)) acc.furniture++
    } else if (samePlace(got.place, g.place)) {
      acc.locRight++
    } else {
      acc.locWrong++
    }

    const want = new Set((g.cast || []).map(norm).filter(Boolean))
    const have = new Set((got?.cast || []).map(norm).filter(Boolean))
    // A cast name may be a full name against a bare one; match on token overlap.
    const matched = new Set<string>()
    for (const w of want) {
      const hit = [...have].find((h) => h === w || tokens(h).size && [...tokens(h)].some((t) => tokens(w).has(t)))
      if (hit) { matched.add(hit); acc.castTP++ } else acc.castFN++
    }
    for (const h of have) if (!matched.has(h)) acc.castFP++
    if (want.size === matched.size && have.size === matched.size) acc.castExact++
  }
  return acc
})

function pct(n: number, d: number): string {
  return d === 0 ? '   —  ' : `${((n / d) * 100).toFixed(1).padStart(5)}%`
}

// HARM vs LOSS. A wrong or invented place can move the cursor and then persist
// for the rest of the run — that is the durable, player-visible failure. An
// abstention writes nothing: the cursor holds, the read is merely lost, and the
// next turn can recover it. Scoring them together rewards a model that answers
// null to everything, which is exactly what a "correct %" column would do here.
const rows: string[][] = [
  ['metric', ...scores.map((s) => s.tier)],
  ['turns scored', ...scores.map((s) => String(s.n))],
  ['RIGHT — named the place', ...scores.map((s) => `${s.locRight} (${pct(s.locRight, s.n)})`)],
  ['HARMFUL — bad write', ...scores.map((s) => `${s.locWrong + s.locHallucinated} (${pct(s.locWrong + s.locHallucinated, s.n)})`)],
  ['  named the wrong place', ...scores.map((s) => String(s.locWrong))],
  ['  invented one', ...scores.map((s) => String(s.locHallucinated))],
  ['    ...furniture', ...scores.map((s) => String(s.furniture))],
  ['LOST — no write, holds', ...scores.map((s) => `${s.locAbstainWrong} (${pct(s.locAbstainWrong, s.n)})`)],
  ['SAFE — nothing to say', ...scores.map((s) => `${s.locAbstainRight} (${pct(s.locAbstainRight, s.n)})`)],
  ['', ...scores.map(() => '')],
  ['CAST exact match', ...scores.map((s) => `${s.castExact} (${pct(s.castExact, s.n)})`)],
  ['  precision (phantoms)', ...scores.map((s) => pct(s.castTP, s.castTP + s.castFP))],
  ['  recall (dropped)', ...scores.map((s) => pct(s.castTP, s.castTP + s.castFN))],
]
const w = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c] ?? '').length)))
console.log(`scored against ${sample.length} gold-labelled turns (free)\n`)
for (const [i, row] of rows.entries()) {
  console.log(row.map((cell, c) => String(cell ?? '').padEnd(w[c])).join('  '))
  if (i === 0) console.log(w.map((x) => '─'.repeat(x)).join('  '))
}

console.log('\n\nWHERE PRODUCTION (gpt-4o-mini) IS WRONG — read these, gold is a model too:')
const base = tiers.find((t) => t.tier === 'gpt-4o-mini')!
let shown = 0
for (const turn of sample) {
  if (shown >= 14) break
  const g = gold[turn.id]
  const got = base.byTurn[turn.id]
  const ok = !got
    ? !(g.place && g.placeIsSpace)
    : g.place && g.placeIsSpace && samePlace(got.place, g.place)
  if (ok) continue
  shown++
  console.log(
    `  ${(turn.world || turn.instance).slice(0, 26).padEnd(26)} seq ${String(turn.sequence).padStart(3)}  ` +
      `said ${JSON.stringify(got?.place ?? null).padEnd(28)} gold ${JSON.stringify(g.place)}${g.place && !g.placeIsSpace ? ' (not a space)' : ''}`,
  )
  if (g.quote) console.log(`      gold quote: "${g.quote.replace(/\s+/g, ' ').slice(0, 110)}"`)
}
