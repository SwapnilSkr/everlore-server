import { t } from 'elysia'

export const EventQueryParams = t.Object({
  page: t.Optional(t.Numeric()),
  limit: t.Optional(t.Numeric()),
  type: t.Optional(t.String()),
})

export const EditEventBody = t.Object({
  ai_response: t.Optional(t.String({ maxLength: 10000 })),
  player_input: t.Optional(t.String({ maxLength: 4000 })),
})
