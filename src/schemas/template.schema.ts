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

// ── Field length caps (characters) ──────────────────────────────────────────
// Single source of truth shared with the frontend field caps and the autofill
// clamps. Kept deliberately lean so the world/character static prompt prefix
// stays small and cacheable (healthy TTFT). Storage caps carry a little headroom
// above the per-field UI caps because character creation COMPOSES several fields
// (seed = "You are {name}. {tagline}.\n\n{persona}"; backstory -> global_lore;
// greeting -> opening_line), so the stored value can be a bit longer than any
// single field the creator typed.
export const FIELD_LIMITS = {
  title: 80, // UI cap 60 (name/world name) + headroom
  description: 600, // UI cap 400 (world) / 120 (tagline) + headroom
  seedPrompt: 2500, // UI cap 1500 (world seed / character persona) + composition headroom
  globalLore: 3000, // UI cap 2500 (lore / backstory) + headroom
  openingLine: 600, // UI cap 400 (opening / greeting) + headroom
  styleNotes: 500,
  imagePrompt: 1400, // decorated prompt (visual core ≤500 + style/composition suffix)
  protagonistName: 80,
  protagonistText: 400,
} as const

export const CreateTemplateBody = t.Object({
  title: t.String({ minLength: 1, maxLength: FIELD_LIMITS.title }),
  description: t.String({ minLength: 1, maxLength: FIELD_LIMITS.description }),
  kind: t.Optional(t.Union([t.Literal('world'), t.Literal('character')])),
  is_sentient: t.Boolean(),
  is_nsfw_capable: t.Boolean(),
  seed_prompt: t.String({ minLength: 10, maxLength: FIELD_LIMITS.seedPrompt }),
  global_lore: t.String({ maxLength: FIELD_LIMITS.globalLore }),
  narrative_style: t.Optional(t.String({ maxLength: 50 })),
  style_notes: t.Optional(t.String({ maxLength: FIELD_LIMITS.styleNotes })),
  image_url: t.Optional(t.String({ maxLength: 600 })),
  image_prompt: t.Optional(t.String({ maxLength: FIELD_LIMITS.imagePrompt })),
  opening_line: t.Optional(t.String({ maxLength: FIELD_LIMITS.openingLine })),
  protagonist: t.Optional(
    t.Object({
      name: t.String({ minLength: 1, maxLength: FIELD_LIMITS.protagonistName }),
      persona: t.Optional(t.String({ maxLength: FIELD_LIMITS.protagonistText })),
      appearance: t.Optional(t.String({ maxLength: FIELD_LIMITS.protagonistText })),
    }),
  ),
  // Optional: Character-kind templates may have zero stats. Worlds still require
  // at least one (enforced in templateService for kind 'world').
  base_stats_template: t.Optional(t.Record(t.String(), StatDefinition)),
  flag_definitions: t.Optional(t.Record(t.String(), FlagDefinition)),
  scene_tags: t.Optional(t.Array(t.String({ maxLength: 24 }), { maxItems: 8 })),
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
  prompt: t.String({ minLength: 4, maxLength: FIELD_LIMITS.imagePrompt }),
})

/** Image bytes are validated again from their decoded content server-side. */
export const UploadImageBody = t.Object({
  image: t.File({ maxSize: '15m' }),
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

export const MyTemplateQueryParams = t.Object({
  page: t.Optional(t.Numeric({ minimum: 1 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50 })),
  search: t.Optional(t.String({ maxLength: 100 })),
})
