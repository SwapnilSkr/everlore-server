import { callLLM, AI_MODELS } from '../../src/ai'
import { enforceSchema, type GenerationOutput } from './structured-output'

/** Structured fields derived from a narrative — everything except the prose itself. */
export type SceneMetadata = Omit<GenerationOutput, 'narrative'>

/** Schema mirrors the generation envelope minus `narrative` (callLLM uses strict:false). */
const METADATA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state_mutations: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          op: { type: 'string', enum: ['add', 'subtract', 'set'] },
          value: { type: 'number' },
        },
        required: ['op', 'value'],
      },
    },
    flag_mutations: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          op: { type: 'string', enum: ['set', 'increment', 'decrement'] },
          value: {
            anyOf: [
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
              { type: 'null' },
            ],
          },
        },
        required: ['op', 'value'],
      },
    },
    scene_tag: {
      type: 'string',
      enum: ['dialogue', 'combat', 'romantic', 'intimate', 'exploration', 'existential', 'cosmic', 'mundane'],
    },
    emotional_tone: { type: 'string' },
    choices: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          kind: { type: 'string', enum: ['act', 'say'] },
          send: { type: 'string' },
        },
        required: ['label', 'kind', 'send'],
      },
    },
    milestone: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
    },
    present_characters: {
      type: 'array',
      maxItems: 12,
      items: { type: 'string' },
    },
    current_location: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
    },
    time_elapsed: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
    },
    location_state_changes: {
      type: 'array',
      maxItems: 6,
      items: { type: 'string' },
    },
    location_permanent_facts: {
      type: 'array',
      maxItems: 6,
      items: { type: 'string' },
    },
  },
  required: ['state_mutations', 'flag_mutations', 'scene_tag', 'emotional_tone', 'choices', 'milestone', 'present_characters', 'current_location', 'time_elapsed', 'location_state_changes', 'location_permanent_facts'],
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw)
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        return JSON.parse(match[0])
      } catch {
        // fall through
      }
    }
    return {}
  }
}

/**
 * Derive ALL structured fields (state/flag mutations, scene tag, tone, choices,
 * milestone, presence, location, time) from a finished narrative. Runs on EVERY
 * turn: the narrator is always `proseOnly` (streamed prose, uncensored-model
 * compatible), so this cheap reliable model handles the structured bookkeeping.
 * `opts.protagonist` anchors first-person choice generation to the player so the
 * choice viewpoint can't drift in third-person prose. Falls back to a no-op
 * (scene stays `intimate` to preserve NSFW momentum) if extraction fails.
 */
export async function extractSceneMetadata(
  narrative: string,
  statKeys: string[],
  flagKeys: string[],
  opts?: {
    isSentient?: boolean
    currentLocationName?: string | null
    /** The player's character (GM worlds) or the player's persona (sentient
     *  worlds) — used to anchor first-person choices to the right person so the
     *  choice viewpoint never drifts in third-person prose. */
    protagonist?: { name?: string | null; aliases?: string[]; persona?: string | null } | null
  },
): Promise<SceneMetadata> {
  // Resolve who "I" is for the choices. In third-person GM prose the protagonist
  // is referred to by role ("the son", "the boy"); without naming them the
  // extractor cannot tell which character is the player and drifts the choice POV
  // (an external "Observe the son" label paired with a first-person "*I glance at
  // my brother*" send). The aliases carry the merged role-titles from the codex.
  const protagName = opts?.protagonist?.name?.trim() || null
  const protagAliases = (opts?.protagonist?.aliases || [])
    .map((a) => a.trim())
    .filter((a) => a && a.toLowerCase() !== (protagName || '').toLowerCase())
  const aliasClause = protagAliases.length
    ? ` (the prose may refer to them as: ${protagAliases.join(', ')} — all the same person)`
    : ''
  const perspective = opts?.isSentient
    ? `The player is a person interacting with the character(s) in the scene${
        protagName ? `; the player is "${protagName}"${aliasClause}` : ''
      }. The choices are the PLAYER's own next moves (what they say or do), NOT the character's.`
    : `The player IS the protagonist of this story${
        protagName
          ? `: "${protagName}"${aliasClause}. Whenever the prose refers to ${protagName} — by name, by role, or by pronoun — that is the player, and "I" in every choice means ${protagName}.`
          : '; their character acts within the world.'
      } Write every choice from ${
        protagName || 'the protagonist'
      }'s own first-person viewpoint. NEVER refer to the player's own character in the third person or by role in either the label or the send (e.g. do not write "Observe the son" when the player IS the son — write "Watch my brother" / "*I watch him closely*").`

  const system = `You are a game-state analyst for a narrative RPG engine. Given a narrative passage, determine what changed in the world and suggest next moves. Respond ONLY with JSON matching the required schema.

Rules:
- state_mutations: include ONLY stats that actually changed this passage. op is "add"|"subtract"|"set"; for add/subtract keep value between 1 and 20.
- flag_mutations: include ONLY flags that changed. op is "set"|"increment"|"decrement".
- scene_tag: one of dialogue, combat, romantic, intimate, exploration, existential, cosmic, mundane. Use "romantic" for affectionate/romantic but non-explicit scenes (flirting, kissing, emotional intimacy). Use "intimate" ONLY for explicit sexual content.
- emotional_tone: a single word.
- choices: 2-4 distinct suggested next moves for the player. ${perspective} Each is an object { label, kind, send }:
    - label: the short chip caption shown to the player — an imperative the player gives THEMSELF, 2-6 words, no trailing punctuation (e.g. "Take her hand", "Ask what she's hiding", "Draw your blade"). It must share the send's first-person viewpoint: address other people from the player's vantage ("Confront my brother"), never narrate the player's own character from outside ("Observe the son" when the player is the son is WRONG).
    - send: the player's move, in FIRST PERSON ("I ..."), pre-formatted so the player can edit it before sending. Wrap any narrated action/gesture in *single asterisks*; write spoken words as plain text OUTSIDE the asterisks (no quotation marks). You MAY combine a brief narration and a spoken line when it fits the moment. Examples:
        - silent action → send "*I reach out and take her hand.*"
        - spoken line → send "What are you hiding from me?"
        - narration + speech → send "*I step closer, lowering my voice.* What are you hiding from me?"
    - kind: "say" if send contains any spoken words (even alongside an action); "act" only for a silent action. Drives the chip's icon.
  The set must be distinct in spirit — mix bold / cautious / emotional / curious, and include at least one "say" and one "act" when both fit. Ground every choice in what THIS passage just established; never invent new characters, places, or facts.
- milestone: null almost always. Set a short evocative label (3-8 words) ONLY when this passage crossed a true story landmark: a vow or marriage, a first kiss, a death of a significant character, a title/power gained, a major victory or betrayal, a life-changing decision. Routine progress is NOT a milestone.
- present_characters: the proper names of the people (characters) physically present in the scene at the END of this passage — those in the same place as the viewpoint, able to be spoken to or acted on right now. Use the exact name as written in the prose. EXCLUDE anyone only mentioned, remembered, written about, or elsewhere; exclude the player/narrator themself. Empty array [] when the viewpoint is alone or no other character is in the scene.
- current_location: the concrete named place where the viewpoint/protagonist is physically located at the END of the passage. Use the most specific stable place name written or strongly implied by the prose ("Old Keep", "Mira's room", "North Road"). If the passage does not establish a concrete place, or the scene simply remains where it already was, return null. Prior known location: ${opts?.currentLocationName || '(unknown)'}.
- time_elapsed: how much IN-WORLD time the passage itself narrates passing during this turn — a short human label ("three days", "a week later", "a few hours", "the next morning"). Use this ONLY when the prose clearly skips or spans time (a journey, a "later that night", "weeks passed"). Return null for a continuous, real-time scene where no meaningful time elapses (most dialogue/combat turns). Do not invent time; report only what the passage states or strongly implies.
- location_state_changes: short clauses for what BECAME TRUE about the CURRENT place this turn — its mutable condition ("the gate now lies in ruins", "the tavern has burned down", "soldiers occupy the square"). Each clause must be self-contained and name what changed. Empty array [] when the place's condition did not change (the usual case).
- location_permanent_facts: short clauses for ENDURING, canonical facts about the current place newly established this turn ("the temple was built over a buried god", "this bridge is the only crossing for fifty miles"). These are lasting truths, not passing events or moods. Empty array [] almost always — use sparingly.

Tracked stats (only these names may appear in state_mutations): ${statKeys.length ? statKeys.join(', ') : '(none)'}
Tracked flags (only these names may appear in flag_mutations): ${flagKeys.length ? flagKeys.join(', ') : '(none)'}`

  let raw: string
  try {
    raw = await callLLM({
      model: AI_MODELS.metadata,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: narrative },
      ],
      temperature: 0.2,
      maxTokens: 500,
      responseSchema: METADATA_SCHEMA,
    })
  } catch {
    return {
      state_mutations: {},
      flag_mutations: {},
      scene_tag: 'intimate',
      emotional_tone: 'neutral',
      choices: [],
      milestone: null,
      present_characters: [],
      current_location: null,
      time_elapsed: null,
      location_state_changes: [],
      location_permanent_facts: [],
    }
  }

  // Reuse enforceSchema's field validation by injecting a placeholder narrative,
  // then drop it — keeps mutation/tag validation in one place.
  const validated = enforceSchema(
    JSON.stringify({ narrative: 'placeholder', ...safeParseObject(raw) }),
  )
  const { narrative: _omit, ...meta } = validated
  return meta
}
