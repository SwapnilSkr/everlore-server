import { callLLM, AI_MODELS } from '../../src/ai'
import type { CharacterLifecycleDeltaDoc } from '../../src/models/world-event.model'
import { normalizeEntityName } from '../../src/services/entity-graph.service'
import { excerptNamesPerson, excerptShowsSubjectPredicate, narrationOnly } from './scene-endpoint-adjudicator'

const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    deaths: {
      type: 'array', maxItems: 3,
      items: {
        type: 'object', additionalProperties: false,
        properties: { name: { type: 'string' }, evidence: { type: 'string' }, confidence: { type: 'number' } },
        required: ['name', 'evidence', 'confidence'],
      },
    },
  },
  required: ['deaths'],
}

/**
 * Does this excerpt actually establish THIS person's death? Returns the single
 * NARRATION SENTENCE that establishes it, or null.
 *
 * A sentence qualifies only if it satisfies the whole stack at once: it appears
 * verbatim in the narration (a), it names them (b), and it shows them as the
 * subject of a predicate (c). Returning the sentence rather than a boolean means
 * what gets STORED as the death's evidence is that verified sentence, not the
 * paragraph the model happened to paste around it.
 */
export function findDeathCitation(params: {
  name: string
  aliases?: string[]
  evidence: string
  prose: string
}): string | null {
  const surfaces = [params.name, ...(params.aliases || [])].filter(Boolean)
  // (b) it names them, and (c) the death is PREDICATED OF THEM — they are the
  // clause subject, not a bystander in a sentence where the word "dead" belongs
  // to something else. Naming alone still buried a live man: "The sound of
  // Kael's footsteps fades down the stone stairwell, leaving the steward alone
  // by the dead hearth" is narration, and it names the steward, and the only
  // thing dead in it is the fireplace. He went on speaking for thirty more
  // turns.
  //
  // Both halves must hold in the SAME SENTENCE, and every sentence of the
  // excerpt gets a turn. Testing the excerpt whole anchored (c) to its HEAD,
  // which is the same decapitation the presence verifier had to unlearn: a
  // model citing a death cites the paragraph around it, and English narrates a
  // death by naming the person once and then pronouncing them —
  //
  //   "He didn't cry out; he just went still. … Marn's sharp eyes were open,
  //    fixed on nothing."
  //
  // — so the excerpt opens on "He" and the naming sentence arrives third. That
  // refused a beam-crushing death the model reported at confidence 1.0. Per
  // sentence this is STRICTER than an excerpt-wide (b) ∧ (c), which would let
  // one sentence supply the name and a different one supply the predicate.
  //
  // Requiring the WHOLE excerpt to be verbatim, meanwhile, recorded zero of two
  // unambiguous live deaths. Asked for a contiguous span, the model returns the
  // death's sentences with the scene-setting between them dropped —
  //
  //   "Deshi's footing was already gone. … The surface closed over him without
  //    a ripple. Deshi did not come up."
  //
  // — which is four real sentences and one join that never existed in the
  // prose, and `prose.includes(evidence)` refused the lot. Checking (a) per
  // sentence discards exactly the fabricated joins and keeps every sentence the
  // narrator actually wrote. It loosens nothing: the sentence that buries
  // someone must still be one the narrator wrote, outside quotation marks.
  const narration = narrationOnly(params.prose)
  // A model asked for "one sentence" returns a clause with a period stuck on the
  // end — "Bryn's body slumped against the crates." for prose that reads "his
  // eyes locked on Bryn's body slumped against the crates". Dropping a trailing
  // sentence mark before looking is NORMALISATION, not judgement: the span still
  // has to appear in the narrator's own words, character for character.
  const appearsInNarration = (span: string) =>
    narration.includes(span) || narration.includes(span.replace(/[.!?;,]+$/, ''))
  for (const sentence of params.evidence.split(/(?<=[.!?;])\s+/)) {
    const span = sentence.trim()
    // …and it is NARRATION, not a line somebody spoke.
    if (!span || !appearsInNarration(span)) continue
    if (
      surfaces.some(
        (surface) => excerptNamesPerson(surface, span) && excerptShowsSubjectPredicate(surface, span),
      )
    )
      return span
  }
  return null
}

/** Boolean form, for audits and callers that only need the verdict. */
export function verifyDeathCitation(params: {
  name: string
  aliases?: string[]
  evidence: string
  prose: string
}): boolean {
  return findDeathCitation(params) !== null
}

/**
 * Take the payload out of a response that echoed the SCHEMA back instead —
 * `{"type":"object","properties":{"deaths":[…]}}` rather than `{"deaths":[…]}`.
 *
 * This is not hypothetical tolerance. Over the whole `extractor_raw` corpus the
 * echo rate is:
 *
 *   character_deaths      27.65%
 *   scene_endpoint         0%
 *   scene_witness          0%
 *   choice_metadata        0%
 *   entity_adjudication    0%
 *   player_interaction     0%
 *
 * Only this extractor, and better than one call in four. `parsed.deaths` was
 * simply `undefined` on those, so a real death vanished with no error, no log
 * and no dead-letter — the failure looked exactly like "nobody died". Whatever
 * makes this prompt attract the echo, the shape is unmistakable and unwrapping
 * it costs nothing: a genuine payload has no `properties` key.
 */
function unwrapSchemaEcho(parsed: any): { deaths?: Array<{ name?: unknown; evidence?: unknown; confidence?: unknown }> } {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed.deaths) && parsed.properties && typeof parsed.properties === 'object')
    return parsed.properties
  return parsed || {}
}

/** Strict post-prose witness. It can only transition an already-known NPC and
 * needs an exact excerpt of narrator prose; death threats, hypotheticals, past
 * mentions, reports of uncertain death, and player characters are abstentions. */
export async function extractCharacterDeaths(params: {
  prose: string
  candidates: Array<{ canonical_name: string; aliases?: string[]; is_protagonist?: boolean }>
  sequence: number
  onRaw?: (raw: string) => void
}): Promise<CharacterLifecycleDeltaDoc[]> {
  const prose = String(params.prose || '').trim()
  const candidates = params.candidates
    .filter((card) => !card.is_protagonist && card.canonical_name)
    .map((card) => ({ name: card.canonical_name, aliases: card.aliases || [] }))
  if (!prose || !candidates.length) return []
  try {
    const raw = await callLLM({
      model: AI_MODELS.metadata, purpose: 'character_deaths', temperature: 0, maxTokens: 180, responseSchema: SCHEMA,
      messages: [
        { role: 'system', content: 'Extract only explicit, certain narrator-established deaths of known NPCs from STORY PROSE. Return [] for threats, attempted killings, hypotheticals, memories of an already-dead person, uncertain reports, metaphor, dialogue claims not confirmed by narration, or any player/protagonist. The evidence field must be ONE sentence, copied exactly and contiguously from STORY PROSE, that names the character and states what became of them.' },
        { role: 'user', content: `KNOWN NPCS (use canonical name only):\n${candidates.map((card) => `- ${card.name}${card.aliases.length ? ` (aliases: ${card.aliases.join(', ')})` : ''}`).join('\n')}\n\nSTORY PROSE:\n${prose}` },
      ],
    })
    params.onRaw?.(raw)
    const parsed = unwrapSchemaEcho(JSON.parse(raw))
    const byName = new Map(candidates.map((candidate) => [normalizeEntityName(candidate.name), candidate.name]))
    const out: CharacterLifecycleDeltaDoc[] = []
    for (const death of parsed.deaths || []) {
      const name = byName.get(normalizeEntityName(String(death.name || '')))
      const evidence = String(death.evidence || '').trim()
      const confidence = Number(death.confidence)
      if (!name || !evidence || !Number.isFinite(confidence) || confidence < 0.82) continue
      // (b) THE EXCERPT MUST NAME THE PERSON IT BURIES.
      //
      // The only checks here were "the span is verbatim" and "confidence >=
      // 0.82" — the same (a)-only mistake the location and presence stacks each
      // had to unlearn, in the one extractor whose write cannot be undone by a
      // later turn. Live, it killed an entire world's cast:
      //
      //   Ollen  <- "The mud took it last full moon."      (it = a PILING)
      //   Marn   <- "The Harbourmaster's gone, remember?"  (a DIFFERENT person)
      //
      // Neither excerpt contains the name of the character it was used to kill.
      const aliases = candidates.find((c) => c.name === name)?.aliases || []
      const cited = findDeathCitation({ name, aliases, evidence, prose })
      if (!cited) continue
      // A death asserted only INSIDE QUOTATION MARKS is a character's claim, not
      // a narrator-established fact. The prompt has always asked for exactly
      // this — "dialogue claims not confirmed by narration" — and nothing
      // verified it. All three live false deaths were spoken lines, and the
      // third buried a floor manager who had walked upstairs:
      //
      //   Deshi  <- "Deshi's gone back up."
      //
      // `gone` is a departure and a euphemism at once; no word list separates
      // them. Which side of the quotation marks it falls on is punctuation.

      if (!out.some((item) => item.name_normalized === normalizeEntityName(name))) {
        out.push({ name, name_normalized: normalizeEntityName(name), state: 'deceased', evidence: cited, sequence: params.sequence })
      }
    }
    return out
  } catch {
    return []
  }
}
