import { callLLM, AI_MODELS } from '../../src/ai'
import type { CharacterLifecycleDeltaDoc } from '../../src/models/world-event.model'
import { normalizeEntityName } from '../../src/services/entity-graph.service'

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
      if (!out.some((item) => item.name_normalized === normalizeEntityName(name))) {
        out.push({ name, name_normalized: normalizeEntityName(name), state: 'deceased', evidence, sequence: params.sequence })
      }
    }
    return out
  } catch {
    return []
  }
}
