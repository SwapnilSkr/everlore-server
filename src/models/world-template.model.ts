import type { ObjectId } from 'mongodb'

export interface StatDefinitionDoc {
  default: number
  min: number
  max: number
  description: string
}

export interface FlagDefinitionDoc {
  type: 'boolean' | 'integer' | 'string'
  default: unknown
  description: string
}

export interface ModelPreferencesDoc {
  logic: string
  narration_nsfw: string
  narration_sfw: string
  summary: string
}

/**
 * world_templates — authored worlds (draft or published).
 */
export interface WorldTemplateDoc {
  _id: ObjectId
  creator_id: ObjectId
  title: string
  slug: string
  description: string
  is_published: boolean
  is_sentient: boolean
  is_nsfw_capable: boolean
  version: number
  seed_prompt: string
  global_lore: string
  base_stats_template: Record<string, StatDefinitionDoc>
  flag_definitions: Record<string, FlagDefinitionDoc>
  scene_tags: string[]
  model_preferences: ModelPreferencesDoc
  max_context_memories: number
  max_lore_results: number
  created_at: Date
  updated_at: Date
}

/** Projected fields when listing instances with template titles. */
export type WorldTemplateSummaryDoc = Pick<
  WorldTemplateDoc,
  '_id' | 'title' | 'is_sentient' | 'description'
>
