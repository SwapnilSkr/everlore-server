/**
 * Extract witness + FULL endpoint adjudication for worlds the corpus captured
 * no production extractions for, so `corpus:cast-ab` can be run on a HELD-OUT
 * set rather than only on the turns its rules were derived from.
 *
 * `corpus/ab-extractions.json` keeps only the three fields the location A/B
 * needs; the cast A/B needs the cited names and their evidence. Written to its
 * own file so the frozen location control is untouched.
 *
 * COSTS MONEY. Run: CAST_CACHE=corpus/x.json bun run corpus:cast-extract <ids>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { CorpusTurn } from './corpus-freeze'
import { extractSceneWitness } from '../worker/lib/metadata-extractor'
import { adjudicateSceneEndpoint } from '../worker/lib/scene-endpoint-adjudicator'
import { isSafeWitnessLocationCandidate } from '../worker/lib/movement-signal'

const instances = new Set((process.argv[2] || '').split(',').filter(Boolean))
const path = process.env.CAST_CACHE || 'corpus/cast-extractions.json'
const turns: CorpusTurn[] = JSON.parse(readFileSync('corpus/turns.json', 'utf8'))
const cache: Record<string, any> = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
const selected = turns
  .filter((t) => instances.has(t.instance))
  .sort((a, b) => (a.instance === b.instance ? a.sequence - b.sequence : a.instance.localeCompare(b.instance)))

for (const [i, turn] of selected.entries()) {
  if (cache[turn.id]) continue
  const knownPlaces = turn.context.knownPlaces.filter((p) => isSafeWitnessLocationCandidate(p.name))
  const people = turn.context.roster.map((c) => c.name)
  const witness = await extractSceneWitness(turn.prose, {
    playerInput: turn.playerInput,
    isSentient: turn.isSentient,
    currentLocationName: turn.context.priorLocation,
    priorPresent: turn.context.priorPresent,
    knownPlaces,
    protagonist: turn.context.protagonist,
    roster: turn.context.roster,
  }).catch(() => null)
  const endpoint = await adjudicateSceneEndpoint({
    prose: turn.prose,
    playerInput: turn.playerInput,
    candidates: [...turn.context.priorPresent, ...people],
  }).catch(() => null)
  cache[turn.id] = { witness, endpoint }
  if ((i + 1) % 10 === 0) {
    console.log(`  extracted ${i + 1}/${selected.length}`)
    writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`)
  }
}
writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`)
console.log(`wrote ${Object.keys(cache).length} extractions to ${path}`)
