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
 * Does this excerpt actually establish THIS person's death?
 *
 * (b) it names them, and it is NARRATION rather than a line of dialogue. See
 * the block comment at the call site for the three live deaths that had neither.
 */
export function verifyDeathCitation(params: {
  name: string
  aliases?: string[]
  evidence: string
  prose: string
}): boolean {
  const surfaces = [params.name, ...(params.aliases || [])].filter(Boolean)
  // (b) it names them.
  if (!surfaces.some((surface) => excerptNamesPerson(surface, params.evidence))) return false
  // (c) the death is PREDICATED OF THEM — they are the clause subject, not a
  // bystander in a sentence where the word "dead" belongs to something else.
  // Naming alone still buried a live man: "The sound of Kael's footsteps fades
  // down the stone stairwell, leaving the steward alone by the dead hearth" is
  // narration, and it names the steward, and the only thing dead in it is the
  // fireplace. He went on speaking for thirty more turns.
  if (!surfaces.some((surface) => excerptShowsSubjectPredicate(surface, params.evidence))) return false
  // …and it is NARRATION, not a line somebody spoke.
  return narrationOnly(params.prose).includes(params.evidence)
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
        { role: 'system', content: 'Extract only explicit, certain narrator-established deaths of known NPCs from STORY PROSE. Return [] for threats, attempted killings, hypotheticals, memories of an already-dead person, uncertain reports, metaphor, dialogue claims not confirmed by narration, or any player/protagonist. Every evidence field must be an exact contiguous excerpt of STORY PROSE.' },
        { role: 'user', content: `KNOWN NPCS (use canonical name only):\n${candidates.map((card) => `- ${card.name}${card.aliases.length ? ` (aliases: ${card.aliases.join(', ')})` : ''}`).join('\n')}\n\nSTORY PROSE:\n${prose}` },
      ],
    })
    params.onRaw?.(raw)
    const parsed = JSON.parse(raw) as { deaths?: Array<{ name?: unknown; evidence?: unknown; confidence?: unknown }> }
    const byName = new Map(candidates.map((candidate) => [normalizeEntityName(candidate.name), candidate.name]))
    const out: CharacterLifecycleDeltaDoc[] = []
    for (const death of parsed.deaths || []) {
      const name = byName.get(normalizeEntityName(String(death.name || '')))
      const evidence = String(death.evidence || '').trim()
      const confidence = Number(death.confidence)
      if (!name || !evidence || !prose.includes(evidence) || !Number.isFinite(confidence) || confidence < 0.82) continue
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
      if (!verifyDeathCitation({ name, aliases, evidence, prose })) continue
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
        out.push({ name, name_normalized: normalizeEntityName(name), state: 'deceased', evidence, sequence: params.sequence })
      }
    }
    return out
  } catch {
    return []
  }
}
