/**
 * One-time template cast extraction. Definitions are copied into each instance;
 * they are never shared mutable character cards.
 */
import { callLLM, AI_MODELS } from '../../src/ai'
import type { TemplateCastCharacterDoc } from '../../src/models/world-template.model'
import { isNonPersonRole } from '../../src/services/character-codex.service'
import { isAbstractNonPersonTerm } from '../../src/utils/person-identity'
import {
  relationshipInitializationFromEvidence,
  relationshipStateFromEvidence,
  type RelationshipInitialization,
  type RelationshipState,
} from '../../src/utils/relationship-baseline'

type TemplateCastInput = {
  title: string
  description?: string
  seedPrompt: string
  globalLore?: string
  openingLine?: string
  protagonistName?: string
}

function norm(value: string): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function appears(value: string, source: string): boolean {
  const key = norm(value)
  return !!key && (` ${norm(source)} `).includes(` ${key} `)
}

function stringList(value: unknown, max: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    const text = typeof item === 'string' ? item.replace(/\s+/g, ' ').trim().slice(0, maxChars) : ''
    const key = norm(text)
    if (!text || !key || seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= max) break
  }
  return out
}

function parse(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) } catch {
    const object = raw.match(/\{[\s\S]*\}/)?.[0]
    if (!object) return {}
    try { return JSON.parse(object) } catch { return {} }
  }
}

/** A deliberately narrow second authoring pass. The initial cast extraction is
 * optimized for identity/facts; this pass asks only about player bonds so small
 * models do not silently omit a crucial structured field. It is never on the
 * gameplay path. */
async function extractStartingRelationships(
  source: string,
  cast: TemplateCastCharacterDoc[],
): Promise<Map<string, { initialization: RelationshipInitialization; state?: RelationshipState }>> {
  if (!cast.length) return new Map()
  const candidates = cast.map((character) => ({
    name: character.name,
    aliases: character.aliases || [],
    role: character.role || '',
    facts: character.immutable_facts || [],
  }))
  let raw = ''
  try {
    raw = await callLLM({
      model: AI_MODELS.metadata,
      temperature: 0,
      maxTokens: 700,
      responseFormat: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'You extract ONLY explicit starting relationship profiles and bond context toward the player from an authored RPG world.',
            'For each listed character, include a profile only when the authored material explicitly establishes their bond with the player.',
            'Allowed kinds: best_friend, close_friend, friend, acquaintance, trusted_ally, reluctant_ally, mentor_bond, protector, dependent, romantic_partner, unrequited_attraction, ex_partner, family_warm, family_protective, family_strained, estranged, sibling_close, sibling_resentful, enemy, sworn_enemy, fearful, rival, indebted, betrayed, authority_trust.',
            'Use family_strained for explicit neglect, detachment, coldness, or treating the player like a stranger; do not choose a profile merely because someone is a parent, sibling, coworker, or roommate.',
            'Every evidence value must be a short exact excerpt from the authored material. Omit uncertain people. Never invent or infer.',
            'For every accepted profile, add relationship_state: a 1-sentence plain-language bond summary plus the same exact evidence and 1-4 descriptive tags. This is open-ended context, never a replacement for the numeric profile.',
            'Respond ONLY JSON: {"relationships":[{"name":"exact candidate name","relationship_initialization":{"kind":"one allowed kind","evidence":"exact source excerpt"},"relationship_state":{"summary":"plain-language bond meaning","evidence":"exact source excerpt","tags":["descriptive tag"]}}]}',
          ].join('\n'),
        },
        { role: 'user', content: `CANDIDATE CAST:\n${JSON.stringify(candidates)}\n\nAUTHORED MATERIAL:\n${source}` },
      ],
    })
  } catch {
    return new Map()
  }
  const list = Array.isArray(parse(raw).relationships) ? parse(raw).relationships as unknown[] : []
  const known = new Set(cast.map((character) => norm(character.name)))
  const out = new Map<string, { initialization: RelationshipInitialization; state?: RelationshipState }>()
  for (const entry of list) {
    const item = entry as Record<string, unknown>
    const name = typeof item.name === 'string' ? norm(item.name) : ''
    const initialization = relationshipInitializationFromEvidence(item.relationship_initialization, source)
    const state = relationshipStateFromEvidence(item.relationship_state, source)
    if (!name || !known.has(name) || !initialization || out.has(name)) continue
    out.set(name, { initialization, ...(state ? { state } : {}) })
  }
  return out
}

/** Extract clearly-established starting people from authored world material. */
export async function extractTemplateCast(input: TemplateCastInput): Promise<TemplateCastCharacterDoc[]> {
  const source = [input.title, input.description, input.seedPrompt, input.globalLore, input.openingLine]
    .filter((part): part is string => typeof part === 'string' && !!part.trim())
    .join('\n\n').slice(0, 7500)
  if (!source.trim()) return []

  const system = [
    'You extract the FIXED STARTING CAST from an authored interactive-fiction world template.',
    'Return only explicitly established people likely to matter as recurring characters from the beginning.',
    'Include a named person, or a stable role only when it clearly identifies a real person (Father, the Butler, Captain Rhea).',
    'Exclude the player, any you-role, and the locked sentient protagonist supplied separately.',
    'Never include places, organisations, objects, abstractions, emotions, personification, crowds, historical names, hypotheticals, or unnamed passers-by.',
    'Never invent names, aliases, appearance, motives, or facts. Every name and alias must literally appear in the source.',
    'Keep only durable starting facts in immutable_facts. No current mood, hidden thought, relationship meter, or scene-local state.',
    'Set relationship_initialization ONLY if the source explicitly establishes THIS person\'s starting bond toward the player (for example close friend, estranged father, sworn enemy). Return its kind plus an exact short source excerpt. Omit it when the relation is uncertain, inferred from a role, or belongs to someone else.',
    'Merge titles and names: if Sister is explicitly named Mara, output name Mara and aliases [Sister].',
    'Return at most 12 people. Empty is correct when no cast is established.',
    'Respond ONLY JSON: {"characters":[{"name":"string","aliases":["string"],"role":"string","appearance":"string","persona":"string","immutable_facts":["string"],"relationship_initialization":{"kind":"one allowed relationship kind","evidence":"exact source excerpt"}}]}',
  ].join('\n')

  let raw = ''
  try {
    raw = await callLLM({
      model: AI_MODELS.metadata,
      temperature: 0,
      maxTokens: 1000,
      responseFormat: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `LOCKED SENTIENT PROTAGONIST (exclude): ${input.protagonistName || '(none)'}\n\nAUTHORED MATERIAL:\n${source}` },
      ],
    })
  } catch {
    return []
  }

  const list = Array.isArray(parse(raw).characters) ? parse(raw).characters as unknown[] : []
  const out: TemplateCastCharacterDoc[] = []
  const seen = new Set<string>()
  const protagonist = norm(input.protagonistName || '')
  for (const entry of list) {
    const item = entry as Record<string, unknown>
    const name = typeof item.name === 'string' ? item.name.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
    const key = norm(name)
    if (!name || !key || key === protagonist || seen.has(key) || !appears(name, source)) continue
    const role = typeof item.role === 'string' ? item.role.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
    if (isAbstractNonPersonTerm(name) || isNonPersonRole(role)) continue
    const aliases = stringList(item.aliases, 8, 120).filter((alias) => norm(alias) !== key && appears(alias, source))
    const appearance = typeof item.appearance === 'string' ? item.appearance.replace(/\s+/g, ' ').trim().slice(0, 600) : ''
    const persona = typeof item.persona === 'string' ? item.persona.replace(/\s+/g, ' ').trim().slice(0, 1000) : ''
    const immutableFacts = stringList(item.immutable_facts, 8, 400)
    const relationshipInitialization = relationshipInitializationFromEvidence(item.relationship_initialization, source)
    seen.add(key)
    out.push({
      name,
      ...(aliases.length ? { aliases } : {}),
      ...(role ? { role } : {}),
      ...(appearance ? { appearance } : {}),
      ...(persona ? { persona } : {}),
      ...(immutableFacts.length ? { immutable_facts: immutableFacts } : {}),
      ...(relationshipInitialization ? { relationship_initialization: relationshipInitialization } : {}),
    })
    if (out.length >= 12) break
  }
  const startingRelationships = await extractStartingRelationships(source, out)
  return out.map((character) => {
    const relationship = startingRelationships.get(norm(character.name))
    if (!relationship) return character
    return {
      ...character,
      relationship_initialization: character.relationship_initialization || relationship.initialization,
      ...(relationship.state ? { relationship_state: relationship.state } : {}),
    }
  })
}
