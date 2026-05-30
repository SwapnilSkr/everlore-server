import { callLLM } from './llm-client'
import { enforceSchema, type GenerationOutput } from './structured-output'

/** Structured fields derived from a narrative — everything except the prose itself. */
export type SceneMetadata = Omit<GenerationOutput, 'narrative'>

/** Schema mirrors the generation envelope minus `narrative` (llm-client uses strict:false). */
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
      enum: ['dialogue', 'combat', 'intimate', 'exploration', 'existential', 'cosmic', 'mundane'],
    },
    emotional_tone: { type: 'string' },
  },
  required: ['state_mutations', 'flag_mutations', 'scene_tag', 'emotional_tone'],
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
): Promise<SceneMetadata> {
  const system = `You are a game-state analyst for a narrative RPG engine. Given a narrative passage, determine what changed in the world. Respond ONLY with JSON matching the required schema.

Rules:
- state_mutations: include ONLY stats that actually changed this passage. op is "add"|"subtract"|"set"; for add/subtract keep value between 1 and 20.
- flag_mutations: include ONLY flags that changed. op is "set"|"increment"|"decrement".
- scene_tag: one of dialogue, combat, intimate, exploration, existential, cosmic, mundane. Use "intimate" for romantic or sexual scenes.
- emotional_tone: a single word.

Tracked stats (only these names may appear in state_mutations): ${statKeys.length ? statKeys.join(', ') : '(none)'}
Tracked flags (only these names may appear in flag_mutations): ${flagKeys.length ? flagKeys.join(', ') : '(none)'}`

  let raw: string
  try {
    raw = await callLLM({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: narrative },
      ],
      temperature: 0.2,
      maxTokens: 400,
      responseSchema: METADATA_SCHEMA,
    })
  } catch {
    return { state_mutations: {}, flag_mutations: {}, scene_tag: 'intimate', emotional_tone: 'neutral' }
  }

  // Reuse enforceSchema's field validation by injecting a placeholder narrative,
  // then drop it — keeps mutation/tag validation in one place.
  const validated = enforceSchema(
    JSON.stringify({ narrative: 'placeholder', ...safeParseObject(raw) }),
  )
  const { narrative: _omit, ...meta } = validated
  return meta
}
