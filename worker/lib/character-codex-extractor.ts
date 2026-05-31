import { callLLM, AI_MODELS } from '../../src/ai'
import type { CharacterCodexDelta } from '../../src/services/character-codex.service'

type ExistingCharacter = {
  canonical_name: string
  aliases?: string[]
  role?: string
  appearance?: string
  persona?: string
  disposition_to_player?: string
  /** Current status snapshot the extractor must reconcile (supersede stale items). */
  mutable_state?: string[]
  /** Permanent history; provided for context so new facts aren't duplicated. */
  immutable_facts?: string[]
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
    retire_state: Array.isArray(raw.retire_state)
      ? raw.retire_state.map(String).slice(0, 6)
      : [],
    disposition_to_player:
      typeof raw.disposition_to_player === 'string' ? raw.disposition_to_player.trim() : undefined,
    hidden_thought: typeof raw.hidden_thought === 'string' ? raw.hidden_thought.trim() : undefined,
    is_protagonist: raw.is_protagonist === true,
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
  /** Seed prompt of a sentient world — describes the main persona the player
   *  talks TO. Lets the extractor tag that card as the protagonist instead of
   *  treating it like a random NPC. Omit/empty for Game Master worlds. */
  seedPrompt?: string
  isSentient?: boolean
  /** Name of the locked protagonist. For GM worlds this is the PLAYER's own
   *  character — the extractor must track their evolving state and tag them. */
  protagonistName?: string
}): Promise<CharacterCodexDelta[]> {
  const { playerInput, aiResponse, existing, seedPrompt, isSentient, protagonistName } = params

  const existingText = existing.length
    ? existing
      .map((c) => {
        const aliases = (c.aliases || []).join(', ')
        const state = (c.mutable_state || []).filter(Boolean)
        const stateLine = state.length ? `\n    current state: ${state.join('; ')}` : ''
        return `- ${c.canonical_name}${aliases ? ` (aliases: ${aliases})` : ''}${c.role ? ` role: ${c.role}` : ''}${stateLine}`
      })
      .join('\n')
    : '(none yet)'

  const protagonistBlock =
    isSentient && seedPrompt && seedPrompt.trim().length > 0
      ? `
MAIN CHARACTER (PROTAGONIST):
This is a sentient world. The player is in conversation WITH a single main character, described by the world's seed prompt below. When you extract THAT character, set "is_protagonist": true and resolve all of their aliases/titles to the same card (never split them). Track their evolving state (relationships, powers, status) accurately. Every other character is a side character with "is_protagonist": false.
--- SEED PROMPT ---
${seedPrompt.trim().slice(0, 800)}
--- END SEED PROMPT ---
`
      : protagonistName && protagonistName.trim()
        ? `
PROTAGONIST (THE PLAYER): The player's own character is named "${protagonistName.trim()}". Treat them as a tracked character: set "is_protagonist": true for them, and update their evolving state from the turn — relationships formed/ended, powers gained, status changes (e.g. married, wounded, exiled). Everyone else is a side character with "is_protagonist": false.
`
        : ''

  const system = `You maintain an RPG character codex. Extract character updates from the turn.

Rules:
- Include non-player characters and entities (and the protagonist described below).
- ALWAYS create or update a card for any NAMED character who appears, speaks, or is referenced this turn — even with sparse detail. Do not skip newly introduced characters; capturing them promptly keeps the story consistent.
- Prefer resolving to existing characters when aliases/titles/pronouns refer to the same person; never split one character into two cards.
- Return 0-6 characters (most important / most active first).
- Keep hidden_thought private/internal (never spoken aloud), short and specific to the player.
- immutable_facts: PERMANENT history/identity that never stops being true once it happens (e.g. "was engaged to Lord X", "gained pyromancy", "married Mira"). Append-only — only NEW permanent facts from this turn.
- mutable_state: the character's CURRENT status that may change later (e.g. "unattached", "wields fire magic", "wounded"). Only NEW or newly-changed current-status items from this turn.
- retire_state: CRITICAL for continuity. Copy here, VERBATIM, any item from the character's existing "current state" (shown below) that THIS TURN made false or obsolete. Example: if existing state says "engaged to Lord X" and this turn the engagement is broken, put "engaged to Lord X" in retire_state. Leave [] if nothing became false. NEVER let an outdated status linger.
- disposition_to_player: concise sentiment toward the player right now.
- is_protagonist: true ONLY for the world's main character (see below); otherwise false.
${protagonistBlock}
Existing characters (with their current state — reconcile against this):
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
      "retire_state": ["existing current-state items that are now false/obsolete"],
      "disposition_to_player": "string",
      "hidden_thought": "string",
      "is_protagonist": false
    }
  ]
}`

  let raw: string
  try {
    raw = await callLLM({
      model: AI_MODELS.codexExtraction,
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
    if (out.length >= 6) break
  }
  return out
}
