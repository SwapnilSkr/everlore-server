import { callLLM, AI_MODELS } from '../../src/ai'
import type { CharacterLifecycleDeltaDoc } from '../../src/models/world-event.model'
import { normalizeEntityName } from '../../src/services/entity-graph.service'
import { log } from '../../src/utils/logger'
import { excerptNamesPerson, excerptShowsSubjectPredicate, narrationOnly } from './scene-endpoint-adjudicator'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    changes: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          state: { type: 'string', enum: ['deceased', 'alive'] },
          source: { type: 'string', enum: ['player', 'narration'] },
          evidence: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['name', 'state', 'source', 'evidence', 'confidence'],
      },
    },
  },
  required: ['changes'],
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

/**
 * The lenient citation: the words are really there, and they really name this
 * person. No subject-predicate test.
 *
 * Used where the strict one would be answering the wrong question — for the
 * PLAYER'S OWN NARRATION, where there is no witness to cross-examine because
 * the player is the author, and for a REVIVAL, where the mistake only restores
 * someone to the story instead of removing them.
 */
export function findAuthoredCitation(params: {
  name: string
  aliases?: string[]
  evidence: string
  text: string
}): string | null {
  const surfaces = [params.name, ...(params.aliases || [])].filter(Boolean)
  const haystack = String(params.text || '')
  for (const sentence of String(params.evidence || '').split(/(?<=[.!?;])\s+/)) {
    const span = sentence.trim()
    if (!span) continue
    if (!haystack.includes(span) && !haystack.includes(span.replace(/[.!?;,]+$/, ''))) continue
    if (surfaces.some((surface) => excerptNamesPerson(surface, span))) return span
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
function unwrapSchemaEcho(parsed: any): { changes?: Array<Record<string, unknown>> } {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed.changes) && parsed.properties && typeof parsed.properties === 'object')
    return parsed.properties
  return parsed || {}
}

/**
 * Who lived and who died on this turn — in BOTH directions, from BOTH authors.
 *
 * Three rules decide what is written down, and they are deliberately unequal.
 *
 * 1. THE PLAYER'S PEN IS LAW. Anything the player authored inside *asterisks*
 *    is canon the moment they write it. If they write *Marn coughs and sits
 *    up*, Marn is alive; if they write *the knife goes into his throat*, he is
 *    dead. This is their story. The excerpt must be their own words and must
 *    name the person — that is all. It is never weighed against the narrator,
 *    who may not have caught up yet.
 *
 * 2. KILLING IS HELD TO A HIGHER BAR THAN SAVING. A death from NARRATION must
 *    survive the full citation stack, because burying the wrong person takes
 *    them out of the story. A revival only restores someone, so it needs the
 *    excerpt to be real and to name them — nothing more. Asymmetric on purpose:
 *    the two mistakes do not cost the same.
 *
 * 3. A DEATH IS NOT A TOMBSTONE. "The body in the coat wasn't his." "She was
 *    still breathing when they found her." The story is allowed to take a death
 *    back, and until now it had no way to say so.
 */
export async function extractLifecycleChanges(params: {
  prose: string
  playerNarration?: string[]
  candidates: Array<{ canonical_name: string; aliases?: string[]; is_protagonist?: boolean }>
  /** Who is currently marked dead. Only these people can be brought back. */
  deceasedNames?: string[]
  sequence: number
  onRaw?: (raw: string) => void
}): Promise<CharacterLifecycleDeltaDoc[]> {
  const prose = String(params.prose || '').trim()
  const authored = (params.playerNarration || []).map((f) => String(f || '').trim()).filter(Boolean)
  const playerText = authored.join('\n')
  const candidates = params.candidates
    .filter((card) => !card.is_protagonist && card.canonical_name)
    .map((card) => ({ name: card.canonical_name, aliases: card.aliases || [] }))
  // An abstention with no trace is how this extractor hid for months. Say why.
  if ((!prose && !playerText) || !candidates.length) {
    log.info('lifecycle.skipped', {
      sequence: params.sequence,
      reason: !candidates.length ? 'no_candidates' : 'no_text',
      candidates: params.candidates.length,
    })
    return []
  }
  try {
    const raw = await callLLM({
      model: AI_MODELS.metadata,
      purpose: 'character_deaths',
      temperature: 0,
      maxTokens: 260,
      responseSchema: SCHEMA,
      messages: [
        {
          role: 'system',
          content:
            'Report explicit changes to whether a known NPC is alive, from this turn only.\n' +
            'state "deceased" = they died in this passage. state "alive" = they are established as living after being thought dead (a body was misidentified, a wound was survivable, they wake, they return).\n' +
            'source "player" = established by PLAYER NARRATION. source "narration" = established by STORY PROSE.\n' +
            'Return [] for threats, attempts, hypotheticals, wishes, metaphor ("dead to me", "dead weight"), references to a death that happened earlier, uncertain reports, dialogue claims the narration does not confirm, and any player/protagonist character.\n' +
            'evidence must be ONE sentence copied exactly and contiguously from the source you named, which names the character and states what became of them.',
        },
        {
          role: 'user',
          content:
            `KNOWN NPCS (use canonical name only):\n${candidates
              .map((card) => `- ${card.name}${card.aliases.length ? ` (aliases: ${card.aliases.join(', ')})` : ''}`)
              .join('\n')}` +
            (playerText ? `\n\nPLAYER NARRATION (what the player authored this turn):\n${playerText}` : '') +
            `\n\nSTORY PROSE:\n${prose}`,
        },
      ],
    })
    params.onRaw?.(raw)
    const parsed = unwrapSchemaEcho(JSON.parse(raw))
    const byName = new Map(candidates.map((candidate) => [normalizeEntityName(candidate.name), candidate.name]))
    const deceased = new Set((params.deceasedNames || []).map((n) => normalizeEntityName(n)).filter(Boolean))
    const out: CharacterLifecycleDeltaDoc[] = []
    for (const change of parsed.changes || []) {
      const name = byName.get(normalizeEntityName(String((change as any).name || '')))
      const evidence = String((change as any).evidence || '').trim()
      const state = String((change as any).state || '')
      const source = String((change as any).source || 'narration') === 'player' ? 'player' : 'narration'
      const confidence = Number((change as any).confidence)
      if (!name || !evidence) continue
      if (state !== 'deceased' && state !== 'alive') continue
      if (!Number.isFinite(confidence) || confidence < 0.82) continue
      // ONLY THE DEAD CAN COME BACK. Asked "who changed?", the model reports
      // living people as alive — "Deshi stared, his own trembling hands going
      // still" was returned as a revival for a man who had never died. Harmless
      // as a write (setting alive on the living is a no-op) but it is noise in
      // the ledger and in the log, and a rule that reads plainly is worth more
      // than one that relies on the write being idempotent.
      if (state === 'alive' && !deceased.has(normalizeEntityName(name))) {
        log.info('lifecycle.refused', { sequence: params.sequence, name, state, source, reason: 'not_dead' })
        continue
      }
      const aliases = candidates.find((c) => c.name === name)?.aliases || []

      let cited: string | null = null
      if (source === 'player') {
        // RULE 1. The player wrote it, so there is nothing to verify except that
        // these are really their words and they really named this person. No
        // subject-predicate test: the player is not a witness being cross-examined,
        // they are the author.
        cited = findAuthoredCitation({ name, aliases, evidence, text: playerText })
      } else if (state === 'alive') {
        // RULE 2, the lenient half. Bringing someone back only restores them.
        cited = findAuthoredCitation({ name, aliases, evidence, text: narrationOnly(prose) })
      } else {
        // RULE 2, the strict half. A death from narration must survive the
        // full stack — verbatim, names them, and shows them as the subject.
        //
        // (b) THE EXCERPT MUST NAME THE PERSON IT BURIES. The only checks here
        // were once "the span is verbatim" and "confidence >= 0.82", and live
        // that killed an entire world's cast:
        //
        //   Ollen  <- "The mud took it last full moon."      (it = a PILING)
        //   Marn   <- "The Harbourmaster's gone, remember?"  (a DIFFERENT person)
        //
        // Neither excerpt contains the name of the character it was used to kill.
        // And a death asserted only INSIDE QUOTATION MARKS is a character's
        // claim, not a narrator-established fact — "Deshi's gone back up" buried
        // a floor manager who had walked upstairs. `gone` is a departure and a
        // euphemism at once; no word list separates them, but which side of the
        // quotation marks it falls on is punctuation.
        cited = findDeathCitation({ name, aliases, evidence, prose })
      }
      if (!cited) {
        log.info('lifecycle.refused', { sequence: params.sequence, name, state, source, evidence: evidence.slice(0, 120) })
        continue
      }

      const key = normalizeEntityName(name)
      const existing = out.findIndex((item) => item.name_normalized === key)
      const delta: CharacterLifecycleDeltaDoc = {
        name,
        name_normalized: key,
        state,
        evidence: cited,
        sequence: params.sequence,
        source,
      }
      // The player outranks the narrator on the same turn: they may write
      // someone up off the floor in the same breath the prose lays them on it.
      log.info('lifecycle.recorded', { sequence: params.sequence, name, state, source, evidence: cited.slice(0, 120) })
      if (existing < 0) out.push(delta)
      else if (source === 'player' && out[existing].source !== 'player') out[existing] = delta
    }
    return out
  } catch {
    return []
  }
}

/** Deprecated name kept for callers that only ever wanted deaths. */
export const extractCharacterDeaths = extractLifecycleChanges
