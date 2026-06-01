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
  kind: t.Optional(t.Union([t.Literal('world'), t.Literal('character')])),
  is_sentient: t.Boolean(),
  is_nsfw_capable: t.Boolean(),
  seed_prompt: t.String({ minLength: 10, maxLength: 10000 }),
  global_lore: t.String({ maxLength: 50000 }),
  narrative_style: t.Optional(t.String({ maxLength: 50 })),
  style_notes: t.Optional(t.String({ maxLength: 500 })),
  image_url: t.Optional(t.String({ maxLength: 600 })),
  image_prompt: t.Optional(t.String({ maxLength: 1200 })),
  opening_line: t.Optional(t.String({ maxLength: 2000 })),
  protagonist: t.Optional(
    t.Object({
      name: t.String({ minLength: 1, maxLength: 120 }),
      persona: t.Optional(t.String({ maxLength: 400 })),
      appearance: t.Optional(t.String({ maxLength: 400 })),
    }),
  ),
  // Optional: Character-kind templates may have zero stats. Worlds still require
  // at least one (enforced in templateService for kind 'world').
  base_stats_template: t.Optional(t.Record(t.String(), StatDefinition)),
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

export const GenerateImageBody = t.Object({
  prompt: t.String({ minLength: 4, maxLength: 1200 }),
})

export const AutofillBody = t.Object({
  target: t.Union([t.Literal('world'), t.Literal('character')]),
  brief: t.Optional(t.String({ maxLength: 1500 })),
  is_sentient: t.Optional(t.Boolean()),
  is_nsfw_capable: t.Optional(t.Boolean()),
  narrative_style: t.Optional(t.String({ maxLength: 50 })),
})

export const TemplateQueryParams = t.Object({
  page: t.Optional(t.Numeric()),
  limit: t.Optional(t.Numeric()),
  search: t.Optional(t.String()),
})
