/**
 * WHERE THE STORY OPENS.
 *
 * A world's authored opening line says where the player is standing —
 *
 *   "The Counting House smelled of wet rope and tallow."
 *
 * — and until now nothing read it. The opening event was written with no
 * `location_anchor` and the instance with no `current_location`, so the FIRST
 * turn the witness model ever saw had a null cursor. That sends the location
 * decision down its loosest branch, the one that accepts a plausible name
 * without requiring the excerpt to NAME it, because the alternative at a first
 * anchor is no cursor at all.
 *
 * Live, on the world above, that produced `Harbourmaster office` cited to
 * "Ollen turned his head from the window" — an excerpt with no office in it.
 * The room then carried two names for eight turns, until the narrator wrote
 * "Counting House" itself and the cursor took it.
 *
 * The authored opening is the strongest location signal a world has. It is not
 * a model's reading of a passage, it is the author saying where this begins. So
 * it should not arrive through the witness at all — it should already be the
 * cursor before the first turn is generated, which turns a differently-named
 * room on turn 2 back into an ordinary re-description that the normal rules
 * refuse.
 *
 * This runs ONCE per instance, at creation, off any turn's latency path.
 */
import { callLLM, AI_MODELS } from '../ai'
import { isSafeWitnessLocationCandidate } from '../../worker/lib/movement-signal'
import { normalizeEntityName } from './entity-graph.service'
import { log } from '../utils/logger'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    place: { type: ['string', 'null'] },
  },
  required: ['place'],
}

/**
 * Take the payload out of a response that echoed the SCHEMA back instead —
 * `{"type":"object","properties":{…}}` rather than the object itself. The death
 * extractor did this on 27.65% of its calls and returned nothing at all,
 * silently, for months. Cheap to defend against, so defend against it here from
 * the start rather than after the same bug is found twice.
 */
function unwrapSchemaEcho(parsed: any): { place?: unknown } {
  if (parsed && typeof parsed === 'object' && parsed.place === undefined && parsed.properties && typeof parsed.properties === 'object')
    return parsed.properties
  return parsed || {}
}

export interface OpeningPlace {
  entity_id: null
  name: string
  name_normalized: string
}

/**
 * The verification half, kept pure so it can be audited without a model call.
 *
 * `reason` is for the log, not for control flow — a refusal is a refusal.
 */
export function verifyOpeningPlace(
  claimed: string,
  openingLine: string,
): { place: OpeningPlace | null; reason: string } {
  const name = String(claimed || '').trim()
  const opening = String(openingLine || '').trim()
  if (!name || !opening) return { place: null, reason: 'no_claim' }
  // (a) the author's own words, or nothing. A place the author did not write is
  // a place the model invented, and reading the opening is only worth doing
  // because the opening is authored canon.
  const at = opening.toLocaleLowerCase().indexOf(name.toLocaleLowerCase())
  if (at < 0) return { place: null, reason: 'not_verbatim' }
  // Take the AUTHOR'S casing, not the model's. "the author's own words" should
  // mean the characters they actually wrote — and the capitalisation test below
  // is then reading the opening line rather than the model's transcription of
  // it, so a model that lowercases what it copies costs nothing.
  const authored = opening.slice(at, at + name.length)
  // (b) a room, not a table — the same gate the witness's candidates pass.
  if (!isSafeWitnessLocationCandidate(authored, { proseCited: true }))
    return { place: null, reason: 'unsafe_candidate' }
  // (c) it must read as a PROPER NAME: every word after an optional leading
  // article capitalised, as the author wrote it.
  //
  // This is deliberately the narrowest useful rule, because a refusal here is
  // free — the world then opens exactly as it does today — while a bad accept
  // becomes the cursor before the first turn even runs. Two things get through
  // (a) and (b) that must not become a cursor:
  //
  //   "the table"                             — furniture passes a room's
  //                                             grammar; placehood is not
  //                                             structural and never has been
  //   "The Counting House smelled of wet rope" — a clause the model returned
  //                                             as if it were a name
  //
  // Capitalisation separates both, and it is orthography rather than a list of
  // which nouns count as places, which is the distinction this whole stack is
  // built on. The cost is that a genuinely authored lowercase place — "the
  // tide-stair" — is refused and falls back to today's behaviour. That is the
  // right side to err on: it loses an improvement, it cannot cause a wrong one.
  const words = authored.split(/\s+/).filter(Boolean)
  const head = /^(the|a|an)$/i.test(words[0] || '') ? words.slice(1) : words
  if (!head.length || !head.every((word) => /^[\p{Lu}][\p{L}'’\u2019-]*$/u.test(word)))
    return { place: null, reason: 'not_a_proper_name' }
  const normalized = normalizeEntityName(authored)
  if (!normalized) return { place: null, reason: 'unnormalizable' }
  return { place: { entity_id: null, name: authored, name_normalized: normalized }, reason: 'accepted' }
}


/**
 * The place the authored opening puts the player in, or null.
 *
 * PROVISIONAL by construction — `entity_id` is null, nothing is minted, and the
 * place earns the atlas exactly the way every other place does, by being
 * entered and left and entered again. An authored opening establishes WHERE THE
 * PLAYER IS; it does not establish that the world has a map yet.
 *
 * Verified on the same terms as every other location claim on this branch:
 *
 *   (a) the name appears VERBATIM in the opening line. A place the author did
 *       not write is a place the model invented, and the whole point of reading
 *       the opening is that it is the author's own words.
 *   (b) it survives `isSafeWitnessLocationCandidate`, so "the table", "here"
 *       and a sentence fragment are all refused.
 *
 * Any failure returns null and the world opens exactly as it does today. This
 * can improve the first anchor; it can never make it worse.
 */
export async function extractOpeningPlace(params: {
  openingLine: string
  instanceId?: string
}): Promise<OpeningPlace | null> {
  const opening = String(params.openingLine || '').trim()
  if (!opening) return null
  try {
    const raw = await callLLM({
      model: AI_MODELS.metadata,
      purpose: 'opening_place',
      temperature: 0,
      maxTokens: 60,
      responseSchema: SCHEMA,
      messages: [
        {
          role: 'system',
          content:
            'You are given the opening line of a story. Return the name of the PLACE the viewpoint character is in, copied exactly as it appears in the line. Return null if the line names no place, if it only mentions a place someone is going to or talking about, or if the only candidate is a piece of furniture or a part of a room rather than the room itself.',
        },
        { role: 'user', content: opening },
      ],
    })
    const parsed = unwrapSchemaEcho(JSON.parse(raw))
    const verdict = verifyOpeningPlace(String(parsed.place ?? ''), opening)
    log.info(verdict.place ? 'opening_place.accepted' : 'opening_place.refused', {
      instanceId: params.instanceId,
      name: String(parsed.place ?? '') || null,
      reason: verdict.reason,
    })
    return verdict.place
  } catch (err) {
    // A world must open whether or not this works.
    log.info('opening_place.failed', { instanceId: params.instanceId, error: (err as Error).message })
    return null
  }
}
