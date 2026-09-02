/**
 * GOLD LABELS — the ground truth the system has never had.
 *
 * Every accuracy number so far has been a proxy: citation survival, passage
 * support, cross-tier agreement. None of them says whether the system was RIGHT.
 * You cannot drive a number you do not have, so this produces one.
 *
 * A strong model reads the full passage plus the same context the pipeline had,
 * with room to reason and no schema pressure, and answers two questions a human
 * can check in seconds:
 *   - where is the player physically standing at the end of this passage?
 *   - who else is physically in that place with them?
 *
 * This is LLM-as-labeller, so it is spot-checked by hand and the verification
 * rate is reported alongside every accuracy figure that uses it. It is NOT used
 * to re-rank the model tiers — one of those tiers is the labeller.
 *
 * COSTS MONEY. Run: bun run corpus:gold [turns] [model]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { CorpusTurn } from './corpus-freeze'
import { stratifiedSample } from './corpus-sample'
import { callLLM } from '../src/ai'

const SAMPLE = Number(process.argv[2] || 50)
const MODEL = process.argv[3] || 'gpt-5.6-luna'

export interface GoldLabel {
  id: string
  /** The player's physical location at the end — INCLUDING one carried forward
   *  from the previous turn. null only when nobody could tell. */
  place: string | null
  /** True when the place is a SPACE (room/street/building/settlement/vehicle),
   *  false when the only thing named is furniture or an object. */
  placeIsSpace: boolean
  /** Everyone physically with the player at the final moment. */
  cast: string[]
  /** Did THIS passage show where they are, or was it inherited? */
  establishedHere: boolean
  /** Same physical place the previous turn left them in? */
  sameAsPrior: boolean
  /** Did the player physically change place during this passage? */
  moved: boolean
  /** The labeller's own quoted justification, so a human can check it fast. */
  quote: string
}

const turns: CorpusTurn[] = JSON.parse(readFileSync('corpus/turns.json', 'utf8'))
const sample = stratifiedSample(turns, SAMPLE)
const existing: Record<string, GoldLabel> = existsSync('corpus/gold.json')
  ? JSON.parse(readFileSync('corpus/gold.json', 'utf8'))
  : {}

let labelled = 0
for (const [index, turn] of sample.entries()) {
  if (existing[turn.id]) continue
  const prompt = `You are establishing GROUND TRUTH for a story engine's map, by careful reading. Take your time and be exact.

Read the PASSAGE and decide where the PLAYER physically is at the moment it ENDS.

Return only JSON:
{"place": string|null, "place_is_space": boolean, "established_here": boolean, "same_as_prior": boolean, "cast": string[], "moved": boolean, "quote": "the sentence you based the place on"}

- place: a SHORT STABLE LABEL a map would use for where the player is standing — "the great hall", "root cellars", "Marrow Ford", "the noodle bar". NOT a poetic description of it: a passage that says "a cramped hole-in-the-wall where the lighting is dim" is labelled "the noodle bar" if that is what it is; "a road between two fires" is "the road". If the world already knows this place under one of the names listed below, USE THAT EXACT NAME.
- A scene CONTINUES unless the passage moves them. If the passage shows them still where the previous turn left them — or simply carries on there without moving them — the place is still the previous one, and established_here is false. Return null ONLY when nobody could tell where they are: no prior place is established AND this passage names no setting.
- place_is_space: true if that place is a SPACE the player is inside and could walk out of (a room, a street, a building, an outdoor area, a settlement, a vehicle interior). false if the only thing the passage attaches them to is furniture or an object (a table, a bench, a hearth, a window, a terminal, a bed). Judge the PLACE you named.
- established_here: true only if THIS passage itself physically shows where they are, rather than it being inherited from the previous turn.
- same_as_prior: true if this is the same physical place the previous turn left them in.
- cast: everyone ELSE physically present with the player at that final moment. Not the player. Not people who left, are remembered, are spoken about, or appear only in a cutaway or inside dialogue. If the passage does not show them leaving, someone who was there previously is still there. Use the canonical character names listed below where they apply.
- moved: true only if the player physically changed place DURING this passage.
- quote: the exact sentence that decided it, or "" if it is inherited.

CONTEXT the story engine had (the passage wins on anything it contradicts):
  where the previous turn left them: ${turn.context.priorLocation ?? '(nowhere established)'}
  who was with them previously: ${JSON.stringify(turn.context.priorPresent)}
  places this world knows: ${JSON.stringify(turn.context.knownPlaces.map((p) => p.name).slice(0, 25))}
  characters this world knows: ${JSON.stringify(turn.context.roster.map((c) => c.name).slice(0, 25))}
  the player is called: ${turn.context.protagonist?.name ?? '(unnamed)'}

WHAT THE PLAYER TYPED:
${turn.playerInput.slice(0, 1200)}

PASSAGE:
${turn.prose.slice(0, 12000)}`

  try {
    const raw = await callLLM({
      model: MODEL,
      purpose: 'corpus_gold',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 700,
      responseFormat: { type: 'json_object' },
    })
    const parsed = JSON.parse(raw)
    existing[turn.id] = {
      id: turn.id,
      place: typeof parsed.place === 'string' && parsed.place.trim() ? parsed.place.trim() : null,
      placeIsSpace: parsed.place_is_space === true,
      cast: Array.isArray(parsed.cast) ? parsed.cast.map((n: unknown) => String(n)).filter(Boolean) : [],
      establishedHere: parsed.established_here === true,
      sameAsPrior: parsed.same_as_prior === true,
      moved: parsed.moved === true,
      quote: String(parsed.quote || ''),
    }
    labelled++
  } catch (err) {
    console.log(`  ! ${turn.id}: ${(err as Error).message}`)
  }
  if ((index + 1) % 10 === 0) console.log(`  ${index + 1}/${sample.length}`)
}

writeFileSync('corpus/gold.json', `${JSON.stringify(existing, null, 2)}\n`)
console.log(`\ncorpus/gold.json — ${Object.keys(existing).length} labels (${labelled} new, model ${MODEL})`)
