import { t } from 'elysia'

export const WsChatPayload = t.Object({
  message: t.String({ minLength: 1, maxLength: 4000 }),
})

export const WsMessage = t.Object({
  action: t.Union([
    t.Literal('chat'),
    t.Literal('ping'),
    t.Literal('load_instance'),
    t.Literal('edit_event'),
    t.Literal('edit_memory'),
  ]),
  instance_id: t.Optional(t.String()),
  payload: t.Optional(t.Any()),
})
