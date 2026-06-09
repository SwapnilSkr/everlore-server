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
  },
  required: ['state_mutations', 'flag_mutations', 'scene_tag', 'emotional_tone', 'choices', 'milestone'],
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
 * Derive state/flag mutations, scene tag, and tone from a finished narrative.
 * Used on the NSFW path, where the uncensored model writes prose only and a
 * cheap, reliable model handles the structured bookkeeping. Falls back to a
 * no-op (scene stays `intimate` to preserve NSFW momentum) if extraction fails.
 */
export async function extractSceneMetadata(
  narrative: string,
  statKeys: string[],
  flagKeys: string[],
  opts?: { isSentient?: boolean },
): Promise<SceneMetadata> {
  const perspective = opts?.isSentient
    ? 'The player is a person interacting with the character in the scene.'
    : "The player is the protagonist; their character acts within the world."

  const system = `You are a game-state analyst for a narrative RPG engine. Given a narrative passage, determine what changed in the world and suggest next moves. Respond ONLY with JSON matching the required schema.

Rules:
- state_mutations: include ONLY stats that actually changed this passage. op is "add"|"subtract"|"set"; for add/subtract keep value between 1 and 20.
- flag_mutations: include ONLY flags that changed. op is "set"|"increment"|"decrement".
- scene_tag: one of dialogue, combat, romantic, intimate, exploration, existential, cosmic, mundane. Use "romantic" for affectionate/romantic but non-explicit scenes (flirting, kissing, emotional intimacy). Use "intimate" ONLY for explicit sexual content.
- emotional_tone: a single word.
- choices: 2-4 distinct suggested next moves for the player. ${perspective} Each is an object { label, kind, send }:
    - label: the short chip caption shown to the player — imperative, 2-6 words, no trailing punctuation (e.g. "Take her hand", "Ask what she's hiding", "Draw your blade").
    - send: the player's move, in FIRST PERSON ("I ..."), pre-formatted so the player can edit it before sending. Wrap any narrated action/gesture in *single asterisks*; write spoken words as plain text OUTSIDE the asterisks (no quotation marks). You MAY combine a brief narration and a spoken line when it fits the moment. Examples:
        - silent action → send "*I reach out and take her hand.*"
        - spoken line → send "What are you hiding from me?"
        - narration + speech → send "*I step closer, lowering my voice.* What are you hiding from me?"
    - kind: "say" if send contains any spoken words (even alongside an action); "act" only for a silent action. Drives the chip's icon.
  The set must be distinct in spirit — mix bold / cautious / emotional / curious, and include at least one "say" and one "act" when both fit. Ground every choice in what THIS passage just established; never invent new characters, places, or facts.
- milestone: null almost always. Set a short evocative label (3-8 words) ONLY when this passage crossed a true story landmark: a vow or marriage, a first kiss, a death of a significant character, a title/power gained, a major victory or betrayal, a life-changing decision. Routine progress is NOT a milestone.

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
