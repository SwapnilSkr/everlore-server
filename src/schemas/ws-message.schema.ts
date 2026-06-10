import { t } from 'elysia'

export const WsChatPayload = t.Object({
  message: t.String({ minLength: 1, maxLength: 4000 }),
})

export const WsContinuePayload = t.Object({
  advance: t.Optional(
    t.Union([
      t.Literal('hours'),
      t.Literal('day'),
      t.Literal('days'),
      t.Literal('season'),
    ]),
  ),
})

export const WsSideChatPayload = t.Object({
  character_id: t.String(),
  message: t.String({ minLength: 1, maxLength: 4000 }),
})

/** Inbound WebSocket frame for `/ws/play`. Validated before the handler runs. */
export const WsMessage = t.Object({
  action: t.Union([
    t.Literal('chat'),
    t.Literal('continue'),
    t.Literal('side_chat'),
    t.Literal('replay'),
    t.Literal('ping'),
    t.Literal('load_instance'),
  ]),
  instance_id: t.Optional(t.String()),
  event_id: t.Optional(t.String()),
  payload: t.Optional(t.Any()),
})
