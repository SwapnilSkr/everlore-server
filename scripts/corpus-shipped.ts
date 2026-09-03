/**
 * SHIPPED accuracy — what actually reached the map, not what the extractor said.
 *
 * Every accuracy figure so far scores the RAW extractor claim. That is the input
 * to the gates, not the output: the citation stack, the placehood check and the
 * corroborators exist precisely to refuse a large fraction of those claims. The
 * number that decides whether a player sees a broken world is what the cursor
 * ended up holding.
 *
 * Scores `observed.committedPlace` — the event's own location_anchor — against
 * gold, over turns that ran through the CURRENT stack.
 *
 * Run: bun run corpus:shipped <instanceId,instanceId> <minSequence>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { CorpusTurn } from './corpus-freeze'
import type { GoldLabel } from './corpus-gold'
import { callLLM } from '../src/ai'

const instances = new Set((process.argv[2] || '').split(',').filter(Boolean))
const minSeq = Number(process.argv[3] || 0)
const turns: CorpusTurn[] = JSON.parse(readFileSync('corpus/turns.json', 'utf8'))
const selected = turns.filter((t) => instances.has(t.instance) && t.sequence >= minSeq)
console.log(`${selected.length} turns ran through the current stack\n`)

const goldPath = 'corpus/gold-shipped.json'
const gold: Record<string, GoldLabel> = existsSync(goldPath) ? JSON.parse(readFileSync(goldPath, 'utf8')) : {}

for (const turn of selected) {
  if (gold[turn.id]) continue
  const prompt = `You are establishing GROUND TRUTH for a story engine's map, by careful reading.

Return only JSON: {"place": string|null, "place_is_space": boolean, "quote": string}

- place: a SHORT STABLE LABEL for where the PLAYER is physically standing when the passage ENDS. If the world already knows this place under a name below, use THAT EXACT NAME. A scene CONTINUES unless the passage moves them — if nothing moves them, the place is still the previous one. Return null only if nobody could tell.
- place_is_space: true if it is a SPACE the player is inside and could walk out of; false if the only thing named is furniture or an object (a bench, a table, a hearth, a terminal).
- quote: the sentence that decided it, or "".

previous turn left them: ${turn.context.priorLocation ?? '(nowhere)'}
places this world knows: ${JSON.stringify(turn.context.knownPlaces.map((p) => p.name).slice(0, 25))}
the player is called: ${turn.context.protagonist?.name ?? '(unnamed)'}

WHAT THE PLAYER TYPED:
${turn.playerInput.slice(0, 900)}

PASSAGE:
${turn.prose.slice(0, 10000)}`
  try {
    const raw = await callLLM({
      model: 'gpt-5.6-luna',
      purpose: 'corpus_gold_shipped',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 600,
      responseFormat: { type: 'json_object' },
    })
    const p = JSON.parse(raw)
    gold[turn.id] = {
      id: turn.id,
      place: typeof p.place === 'string' && p.place.trim() ? p.place.trim() : null,
      placeIsSpace: p.place_is_space === true,
      establishedHere: false,
      sameAsPrior: false,
      cast: [],
      moved: false,
      quote: String(p.quote || ''),
    }
  } catch (err) {
    console.log(`  ! ${turn.id}: ${(err as Error).message}`)
  }
}
writeFileSync(goldPath, `${JSON.stringify(gold, null, 2)}\n`)

const norm = (v: string) =>
  v.toLowerCase().replace(/^(?:the|a|an|my|our)\s+/, '').replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim()
// Singular/plural is a naming variant, not a map error: "root cellars" and
// "root cellar" are the same room, and counting them as a miss inflated the
// error rate with pure noise.
const stem = (t: string) => t.replace(/(?:es|s)$/, '')
const toks = (v: string) => new Set(norm(v).split(' ').filter((t) => t.length >= 3).map(stem))
function same(a: string, b: string): boolean {
  if (norm(a) === norm(b)) return true
  const [x, y] = [toks(a), toks(b)]
  if (!x.size || !y.size) return false
  const shared = [...x].filter((t) => y.has(t)).length
  return shared > 0 && shared === Math.min(x.size, y.size)
}

const CUTOVER = Number(process.argv[4] || 0)
type Bucket = { right: number; harmful: number; furniture: number; placehood: number; held: number; wrong: string[] }
const buckets: Record<string, Bucket> = {
  before: { right: 0, harmful: 0, furniture: 0, placehood: 0, held: 0, wrong: [] },
  after: { right: 0, harmful: 0, furniture: 0, placehood: 0, held: 0, wrong: [] },
}
for (const turn of selected) {
  const g = gold[turn.id]
  if (!g) continue
  const b = buckets[CUTOVER && turn.sequence >= CUTOVER ? 'after' : 'before']
  const shipped = turn.observed.committedPlace
  if (!shipped) {
    b.held++
    continue
  }
  const nameMatches = !!g.place && same(shipped, g.place)
  if (nameMatches && g.placeIsSpace) b.right++
  else if (nameMatches && !g.placeIsSpace) {
    // The map and the labeller agree on WHAT it is called and disagree on
    // whether that is a place at all. That is the placehood question, not a
    // wrong cursor — bucket it separately rather than blaming the map.
    b.placehood++
  } else {
    b.harmful++
    if (g.place && !g.placeIsSpace) b.furniture++
    if (b.wrong.length < 10) {
      b.wrong.push(
        `  ${(turn.world || '').slice(0, 22).padEnd(22)} seq ${String(turn.sequence).padStart(3)}  ` +
          `map=${JSON.stringify(shipped).padEnd(20)} gold=${JSON.stringify(g.place)}${g.place && !g.placeIsSpace ? ' (not a space)' : ''}`,
      )
    }
  }
}
for (const [label, b] of Object.entries(buckets)) {
  const n = b.right + b.harmful + b.placehood + b.held
  if (!n) continue
  const pc = (x: number) => `${((x / n) * 100).toFixed(1)}%`.padStart(6)
  console.log(`\nSHIPPED cursor — ${label === 'after' ? `turns >= ${CUTOVER} (current stack)` : `turns < ${CUTOVER || 'all'} (old stack)`} — ${n} turns`)
  console.log(`  correct                ${String(b.right).padStart(3)}  ${pc(b.right)}`)
  console.log(`  WRONG place on the map ${String(b.harmful).padStart(3)}  ${pc(b.harmful)}`)
  console.log(`    ...furniture         ${String(b.furniture).padStart(3)}`)
  console.log(`  placehood dispute      ${String(b.placehood).padStart(3)}  ${pc(b.placehood)}   (same name; is it a place?)`)
  console.log(`  no cursor at all       ${String(b.held).padStart(3)}  ${pc(b.held)}`)
  if (b.wrong.length) console.log(`  wrong:\n${b.wrong.join('\n')}`)
}
