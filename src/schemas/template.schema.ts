import { t } from 'elysia'

const StatDefinition = t.Object({
  default: t.Number(),
  min: t.Number(),
  max: t.Number(),
  description: t.String(),
})

const FlagDefinition = t.Object({
  type: t.Union([t.Literal('boolean'), t.Literal('integer'), t.Literal('string')]),
  default: t.Any(),
  description: t.String(),
})

export const CreateTemplateBody = t.Object({
  title: t.String({ minLength: 1, maxLength: 200 }),
  description: t.String({ minLength: 1, maxLength: 2000 }),
  is_sentient: t.Boolean(),
  is_nsfw_capable: t.Boolean(),
  seed_prompt: t.String({ minLength: 10, maxLength: 10000 }),
  global_lore: t.String({ maxLength: 50000 }),
  base_stats_template: t.Record(t.String(), StatDefinition),
  flag_definitions: t.Optional(t.Record(t.String(), FlagDefinition)),
  scene_tags: t.Optional(t.Array(t.String())),
  model_preferences: t.Optional(t.Object({
    logic: t.Optional(t.String()),
    narration_nsfw: t.Optional(t.String()),
    narration_sfw: t.Optional(t.String()),
    summary: t.Optional(t.String()),
  })),
  max_context_memories: t.Optional(t.Number({ minimum: 5, maximum: 50 })),
  max_lore_results: t.Optional(t.Number({ minimum: 3, maximum: 20 })),
})

export const UpdateTemplateBody = t.Partial(CreateTemplateBody)

export const TemplateQueryParams = t.Object({
  page: t.Optional(t.Numeric()),
  limit: t.Optional(t.Numeric()),
  search: t.Optional(t.String()),
})
