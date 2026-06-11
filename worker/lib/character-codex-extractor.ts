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

/** Lowercase, strip punctuation to spaces, collapse runs — for grounding checks. */
function normForMatch(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** True when `name` (a proper name/epithet) literally appears in the turn text.
 *  Phrase match on the normalized strings, so "mysterious man" (coined from mood)
 *  fails even though the bare word "man" is present. */
function nameAppearsInText(name: string, normText: string): boolean {
  const n = normForMatch(name)
  if (!n || n.length < 2) return false
  return normText.includes(` ${n} `) || normText.startsWith(`${n} `) || normText.endsWith(` ${n}`) || normText === n
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

const METER_KEYS = ['trust', 'affection', 'fear', 'rivalry'] as const

function toRelationshipDeltas(raw: any): CharacterCodexDelta['relationship_deltas'] {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, number> = {}
  for (const key of METER_KEYS) {
    const v = Number((raw as Record<string, unknown>)[key])
    if (!Number.isFinite(v) || v === 0) continue
    out[key] = Math.max(-10, Math.min(10, Math.round(v)))
  }
  return Object.keys(out).length ? out : undefined
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
    relationship_deltas: toRelationshipDeltas(raw.relationship_deltas),
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
  /** Player persona name (sentient worlds): the human in the conversation.
   *  They must NEVER become a codex card — the codex tracks the world's cast. */
  playerPersonaName?: string
  /** Canonical names of the characters physically present in the scene THIS turn.
   *  Lets the extractor resolve a bare descriptor ("the man", "the woman") to the
   *  person it can only be — the anchor that stops invented duplicate cards. */
  presentCast?: string[]
}): Promise<CharacterCodexDelta[]> {
  const { playerInput, aiResponse, existing, seedPrompt, isSentient, protagonistName, playerPersonaName, presentCast } = params

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

  const presentList = (presentCast || []).map((n) => (n || '').trim()).filter(Boolean)
  const presentBlock = presentList.length
    ? `\nPRESENT THIS TURN (these exact people are in the scene now): ${presentList.join(', ')}.\nA bare descriptor in the narration ("the man", "the woman", "the figure", "the stranger", "the boy") almost always refers to one of these present people — resolve it to them, never to a new card.\n`
    : ''

  const protagonistBlock =
    isSentient && seedPrompt && seedPrompt.trim().length > 0
      ? `
MAIN CHARACTER (PROTAGONIST):
This is a sentient world. The player is in conversation WITH a single main character, described by the world's seed prompt below. When you extract THAT character, set "is_protagonist": true and resolve all of their aliases/titles to the same card (never split them). Track their evolving state (relationships, powers, status) accurately. Every other character is a side character with "is_protagonist": false.
THE PLAYER IS NOT A CHARACTER: the human player${playerPersonaName && playerPersonaName.trim() ? ` (who may be called "${playerPersonaName.trim()}")` : ''} is the person the main character talks to. NEVER create a card for the player, under any name, role, or title — "disposition_to_player" and "relationship_deltas" already capture how characters relate to them.
--- SEED PROMPT ---
${seedPrompt.trim().slice(0, 800)}
--- END SEED PROMPT ---
`
      : protagonistName && protagonistName.trim()
        ? `
PROTAGONIST (THE PLAYER): The player's own character is named "${protagonistName.trim()}". Treat them as a tracked character: set "is_protagonist": true for them, and update their evolving state from the turn — relationships formed/ended, powers gained, status changes (e.g. married, wounded, exiled). Everyone else is a side character with "is_protagonist": false.
ONE PERSON, ONE CARD — CRITICAL: the narration addresses the player in second person. "You"/"your" IS "${protagonistName.trim()}". So is any role title, epithet, or description the premise or narration uses for the player's role (e.g. "the heir", "the neglected son", "the stranger"). When the narration refers to the player by ANY such referent, resolve it to the "${protagonistName.trim()}" card via "resolved_name" — NEVER create a separate card for the player, their role, or "you". A new card is only ever for a DIFFERENT person the player can meet.${seedPrompt && seedPrompt.trim() ? `
--- WORLD PREMISE (defines the player's role — referents of this role are the player) ---
${seedPrompt.trim().slice(0, 800)}
--- END WORLD PREMISE ---` : ''}
`
        : ''

  const system = `You maintain an RPG character codex. Extract character updates from the turn.

Rules:
- Include non-player characters and entities (and the protagonist described below).
- ALWAYS create or update a card for any NAMED character who appears, speaks, or is referenced this turn — even with sparse detail. Do not skip newly introduced characters; capturing them promptly keeps the story consistent.
- Prefer resolving to existing characters when aliases/titles/pronouns refer to the same person; never split one character into two cards. Before creating a NEW card, check whether the name is actually a title, epithet, or description of someone already listed (or of the player) — if so, use "resolved_name" instead of a new card.
- Generic RELATIONAL or ROLE epithets — "the sister", "his sister", "Sister", "the twin", "Mother", "the father", "the guard", "the innkeeper" — are NOT a new person when the existing roster already has a character in that role. A shorter or vaguer label ("Sister") and a more specific one ("Twin Sister") for the same family role are the SAME person. Resolve the epithet to that existing card with "resolved_name"; never create a second card alongside it. Worked example: the roster already lists "Twin Sister"; this turn the narration says "his sister scoffed" → return that character with "resolved_name": "Twin Sister" (do NOT mint a separate "Sister" card).
- NEVER INVENT A NAME — NON-NEGOTIABLE. A character's "name" must be a proper name or fixed epithet that LITERALLY appears in this turn's text (player input or narration). NEVER coin a label from the scene's mood, tone, or an action — do NOT produce names like "Mysterious Man", "The Stranger", "Hooded Figure", "The Visitor", "Shadowy Man" unless those exact words appear in the text. A character being secretive, unnamed, or vague is STILL one of the existing roster / present cast — describe their secrecy in their fields, do not give them a new identity.
- A BARE DESCRIPTOR IS NEVER A NEW PERSON when a matching character is already present/listed. "the man", "the woman", "the figure", "the stranger", "the boy/girl", "the older man" → resolve to the present-cast or roster member it can only be (e.g. the only adult male in the room), via "resolved_name". This is the #1 source of accidental duplicates and is FORBIDDEN. Worked example: PRESENT THIS TURN includes "Father"; the narration says *the man tilted the screen away, shielding it from view* while being cagey about his work → that "man" IS the father → return him with "resolved_name": "Father" and capture his secrecy in his state — NEVER mint a "Mysterious Man" (or any new) card for him.
- Return 0-6 characters (most important / most active first).
- Keep hidden_thought private/internal (never spoken aloud), short and specific to the player.
- immutable_facts: PERMANENT history/identity that never stops being true once it happens (e.g. "was engaged to Lord X", "gained pyromancy", "married Mira"). Append-only — only NEW permanent facts from this turn.
- mutable_state: the character's CURRENT status that may change later (e.g. "unattached", "wields fire magic", "wounded"). Only NEW or newly-changed current-status items from this turn.
- retire_state: CRITICAL for continuity. Copy here, VERBATIM, any item from the character's existing "current state" (shown below) that THIS TURN made false or obsolete. Example: if existing state says "engaged to Lord X" and this turn the engagement is broken, put "engaged to Lord X" in retire_state. Leave [] if nothing became false. NEVER let an outdated status linger.
- disposition_to_player: concise sentiment toward the player right now.
- relationship_deltas: how THIS TURN shifted the character's stance toward the player, as integer changes to four meters: trust, affection, fear, rivalry. Include ONLY meters that genuinely moved, ONLY for characters present this turn. Scale: ±1-3 for small moments (kind words, minor friction), ±4-7 for significant ones (a gift, a confession, a public insult), ±8-10 ONLY for dramatic turning points (betrayal, a life saved, a vow broken). Omit the field entirely when nothing shifted. NEVER include it for the player's own protagonist card in a Game Master world (a character has no meters toward themself).
- is_protagonist: true ONLY for the world's main character (see below); otherwise false.
${protagonistBlock}${presentBlock}
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
      "relationship_deltas": { "trust": 0, "affection": 0, "fear": 0, "rivalry": 0 },
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

  // Deterministic anti-duplication backstop (defends the prompt rules above):
  // a brand-new card is only allowed when its name (or an alias) actually appears
  // in this turn's text. A name the model COINED from the scene's mood
  // ("Mysterious Man") — not grounded in the prose — is never a real new person
  // when a roster already exists; it is a duplicate of someone already carded.
  // Drop the phantom mint; the genuine character is re-emitted on adjacent turns.
  const normText = normForMatch(`${playerInput || ''} ${aiResponse || ''}`)
  const knownNames = new Set<string>()
  for (const c of existing) {
    knownNames.add(normForMatch(c.canonical_name))
    for (const a of c.aliases || []) knownNames.add(normForMatch(a))
  }
  for (const n of presentCast || []) knownNames.add(normForMatch(n))
  const resolvesToKnown = (d: CharacterCodexDelta): boolean => {
    const cands = [d.resolved_name || '', d.name, ...(d.aliases || [])].map(normForMatch)
    return cands.some((c) => c && knownNames.has(c))
  }

  const out: CharacterCodexDelta[] = []
  for (const item of list) {
    const delta = toDelta(item)
    if (!delta) continue
    // A NEW card (resolves to no known/present character) MUST be grounded in the
    // text. Protagonist-tagged deltas are exempt (handled by the one-protagonist
    // invariant downstream). When the roster is empty there is nothing to dup, so
    // the guard only engages once a cast exists.
    if (knownNames.size > 0 && delta.is_protagonist !== true && !resolvesToKnown(delta)) {
      const grounded =
        nameAppearsInText(delta.name, normText) ||
        (delta.aliases || []).some((a) => nameAppearsInText(a, normText)) ||
        (delta.resolved_name ? nameAppearsInText(delta.resolved_name, normText) : false)
      if (!grounded) {
        console.warn(
          `[codex-extractor] blocked ungrounded new card "${delta.name}" (not in turn text; likely a duplicate of an existing/present character)`,
        )
        continue
      }
    }
    out.push(delta)
    if (out.length >= 6) break
  }
  return out
}
