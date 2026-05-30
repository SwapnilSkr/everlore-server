import { callLLM } from './llm-client'
import type { CharacterCodexDelta } from '../../src/services/character-codex.service'

type ExistingCharacter = {
  canonical_name: string
  aliases?: string[]
  role?: string
  appearance?: string
  persona?: string
  disposition_to_player?: string
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw)
  } catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return {}
    try {
      return JSON.parse(m[0])
    } catch {
      return {}
    }
  }
}

function toDelta(raw: any): CharacterCodexDelta | null {
  const name = typeof raw?.name === 'string' ? raw.name.trim() : ''
  if (!name) return null
  return {
    name,
    aliases: Array.isArray(raw.aliases) ? raw.aliases.map(String) : [],
    resolved_name: typeof raw.resolved_name === 'string' ? raw.resolved_name.trim() : undefined,
    role: typeof raw.role === 'string' ? raw.role.trim() : undefined,
    appearance: typeof raw.appearance === 'string' ? raw.appearance.trim() : undefined,
    persona: typeof raw.persona === 'string' ? raw.persona.trim() : undefined,
    immutable_facts: Array.isArray(raw.immutable_facts)
      ? raw.immutable_facts.map(String).slice(0, 6)
      : [],
    mutable_state: Array.isArray(raw.mutable_state)
      ? raw.mutable_state.map(String).slice(0, 6)
      : [],
    disposition_to_player:
      typeof raw.disposition_to_player === 'string' ? raw.disposition_to_player.trim() : undefined,
    hidden_thought: typeof raw.hidden_thought === 'string' ? raw.hidden_thought.trim() : undefined,
  }
}

/**
 * Extract emergent NPC codex updates from a turn's player input + narration.
 * Returns compact deltas that can be merged into canonical character cards.
 */
export async function extractCharacterCodexDeltas(params: {
  playerInput: string
  aiResponse: string
  existing: ExistingCharacter[]
}): Promise<CharacterCodexDelta[]> {
  const { playerInput, aiResponse, existing } = params

  const existingText = existing.length
    ? existing
      .map((c) => {
        const aliases = (c.aliases || []).join(', ')
        return `- ${c.canonical_name}${aliases ? ` (aliases: ${aliases})` : ''}${c.role ? ` role: ${c.role}` : ''}`
      })
      .join('\n')
    : '(none yet)'

  const system = `You maintain an RPG character codex. Extract NPC updates from the turn.

Rules:
- Include ONLY non-player characters or entities.
- Prefer resolving to existing characters when aliases/titles refer to the same person.
- Return 0-4 characters.
- Keep hidden_thought private/internal (never spoken aloud), short and specific to the player.
- immutable_facts: stable details (identity, appearance, role, backstory).
- mutable_state: current mood/condition/intent that may change later.
- disposition_to_player: concise sentiment toward the player right now.

Existing characters:
${existingText}

Respond ONLY JSON:
{
  "characters": [
    {
      "name": "string",
      "resolved_name": "string optional; use canonical existing name when this is an alias/title",
      "aliases": ["string"],
      "role": "string",
      "appearance": "string",
      "persona": "string",
      "immutable_facts": ["string"],
      "mutable_state": ["string"],
      "disposition_to_player": "string",
      "hidden_thought": "string"
    }
  ]
}`

  let raw: string
  try {
    raw = await callLLM({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `Player input:\n${playerInput || '(none)'}\n\nNarration:\n${aiResponse}`,
        },
      ],
      temperature: 0.2,
      maxTokens: 900,
      responseFormat: { type: 'json_object' },
    })
  } catch {
    return []
  }

  const parsed = parseJsonObject(raw)
  const list = Array.isArray((parsed as any).characters) ? (parsed as any).characters : []
  const out: CharacterCodexDelta[] = []
  for (const item of list) {
    const delta = toDelta(item)
    if (!delta) continue
    out.push(delta)
    if (out.length >= 4) break
  }
  return out
}
