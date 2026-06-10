import { t } from 'elysia'

export const MemoryQueryParams = t.Object({
  include_archived: t.Optional(t.Boolean()),
  /** Full-text query over memory text/subjects/objects (idx_memories_text_search). */
  q: t.Optional(t.String({ maxLength: 200 })),
  type: t.Optional(t.String({ maxLength: 40 })),
  min_importance: t.Optional(t.Number({ minimum: 1, maximum: 5 })),
  /** Restrict to open threads only. */
  unresolved: t.Optional(t.Boolean()),
})

export const EditMemoryBody = t.Object({
  text: t.String({ minLength: 1, maxLength: 1000 }),
  type: t.Optional(t.Union([
    t.Literal('relationship'),
    t.Literal('promise'),
    t.Literal('lore'),
    t.Literal('observation'),
    t.Literal('emotion'),
    t.Literal('secret'),
  ])),
  importance: t.Optional(t.Number({ minimum: 1, maximum: 5 })),
})
