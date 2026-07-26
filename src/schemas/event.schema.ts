import { t } from 'elysia'

export const EventQueryParams = t.Object({
  page: t.Optional(t.Numeric()),
  limit: t.Optional(t.Numeric()),
  /** Stable cursor for feed-style history loading; avoids offset drift when a
   * new turn is added while the reader is paging through older history. */
  before_sequence: t.Optional(t.Numeric({ minimum: 1 })),
  type: t.Optional(t.String()),
})

export const EditEventBody = t.Object({
  ai_response: t.Optional(t.String({ maxLength: 10000 })),
  player_input: t.Optional(t.String({ maxLength: 4000 })),
})
