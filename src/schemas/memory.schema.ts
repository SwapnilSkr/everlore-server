import { t } from 'elysia'

export const MemoryQueryParams = t.Object({
  include_archived: t.Optional(t.Boolean()),
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
