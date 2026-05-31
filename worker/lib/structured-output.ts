import type { FlagMutation, Mutation } from '../../src/utils/state-mutator'

export interface GenerationOutput {
  narrative: string
  state_mutations: Record<string, Mutation>
  flag_mutations: Record<string, FlagMutation>
  scene_tag: string
  emotional_tone: string
}

const VALID_SCENE_TAGS = new Set([
  'dialogue', 'combat', 'romantic', 'intimate', 'exploration',
  'existential', 'cosmic', 'mundane',
])

export function enforceSchema(rawResponse: string): GenerationOutput {
  try {
    const parsed = JSON.parse(rawResponse)

    // Validate required fields
    if (!parsed.narrative || typeof parsed.narrative !== 'string') {
      throw new Error('Missing or invalid narrative')
    }

    // Ensure state_mutations is an object
    if (!parsed.state_mutations || typeof parsed.state_mutations !== 'object') {
      parsed.state_mutations = {}
    }

    // Validate each mutation
    const rawState = parsed.state_mutations as Record<string, unknown>
    const stateMutations: Record<string, Mutation> = {}
    for (const [key, val] of Object.entries(rawState)) {
      if (!val || typeof val !== 'object') continue
      const m = val as { op?: unknown; value?: unknown }
      if (m.op !== 'add' && m.op !== 'subtract' && m.op !== 'set') continue
      if (typeof m.value !== 'number') continue
      stateMutations[key] = { op: m.op, value: m.value }
    }
    parsed.state_mutations = stateMutations

    // Ensure flag_mutations is an object
    if (!parsed.flag_mutations || typeof parsed.flag_mutations !== 'object') {
      parsed.flag_mutations = {}
    }

    const rawFlags = parsed.flag_mutations as Record<string, unknown>
    const flagMutations: Record<string, FlagMutation> = {}
    for (const [key, val] of Object.entries(rawFlags)) {
      if (!val || typeof val !== 'object') continue
      const m = val as { op?: unknown; value?: unknown }
      if (m.op !== 'set' && m.op !== 'increment' && m.op !== 'decrement') continue
      flagMutations[key] = m.op === 'set' ? { op: 'set', value: m.value } : { op: m.op }
    }
    parsed.flag_mutations = flagMutations

    // Validate scene_tag
    if (!parsed.scene_tag || !VALID_SCENE_TAGS.has(parsed.scene_tag)) {
      parsed.scene_tag = 'dialogue'
    }

    // Ensure emotional_tone
    if (!parsed.emotional_tone || typeof parsed.emotional_tone !== 'string') {
      parsed.emotional_tone = 'neutral'
    }

    return parsed as GenerationOutput
  } catch (err) {
    // Attempt to extract narrative from malformed response
    return repairResponse(rawResponse)
  }
}

function repairResponse(raw: string): GenerationOutput {
  // Try to extract JSON from markdown code blocks
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (jsonMatch) {
    try {
      return enforceSchema(jsonMatch[1])
    } catch {
      // Fall through to text extraction
    }
  }

  // Try to find JSON object in the response
  const objectMatch = raw.match(/\{[\s\S]*\}/)
  if (objectMatch) {
    try {
      return enforceSchema(objectMatch[0])
    } catch {
      // Fall through
    }
  }

  // Last resort: use the raw text as narrative with neutral mutations
  return {
    narrative: raw.slice(0, 2000),
    state_mutations: {},
    flag_mutations: {},
    scene_tag: 'dialogue',
    emotional_tone: 'neutral',
  }
}
