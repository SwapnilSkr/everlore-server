import { t } from 'elysia'

export const WsChatPayload = t.Object({
  message: t.String({ minLength: 1, maxLength: 4000 }),
})

export const WsMessage = t.Object({
  action: t.Union([
    t.Literal('chat'),
    t.Literal('continue'),
    t.Literal('replay'),
    t.Literal('ping'),
    t.Literal('load_instance'),
  ]),
  instance_id: t.Optional(t.String()),
  event_id: t.Optional(t.String()),
  payload: t.Optional(t.Any()),
})
