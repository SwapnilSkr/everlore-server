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

/** Every acting frame: exactly the shape that existed before presence, still
 *  strict. `action` is required here. */
const WsActionMessage = t.Object({
  action: t.Union([
    t.Literal('chat'),
    t.Literal('continue'),
    t.Literal('world_action'),
    t.Literal('replay'),
    t.Literal('ping'),
    t.Literal('load_instance'),
  ]),
  instance_id: t.Optional(t.String()),
  event_id: t.Optional(t.String()),
  kind: t.Optional(t.Literal('action')),
  direct_with: t.Optional(t.String()),
  payload: t.Optional(t.Any()),
})

// The app's lifecycle frame. The release on phones (1.0.13) sends exactly
// `{type:'presence', foreground:<bool>}` with NO `action`, and the presence
// branch in play-ws.service has therefore never run in production: a strict
// `action` union rejected every lifecycle change as a validation error, which
// the app showed as "The scene could not start". Presence is its own frame
// shape, not another action, so it gets its own strict object rather than
// loosening the one above (`action` stays required there).
const WsPresenceTypeMessage = t.Object(
  { type: t.Literal('presence'), foreground: t.Boolean() },
  { additionalProperties: false },
)

/** The same frame carried as an action, for clients that spell it that way. */
const WsPresenceActionMessage = t.Object(
  { action: t.Literal('presence'), foreground: t.Boolean() },
  { additionalProperties: false },
)

/** Inbound WebSocket frame for `/ws/play`. Validated before the handler runs. */
export const WsMessage = t.Union([
  WsActionMessage,
  WsPresenceTypeMessage,
  WsPresenceActionMessage,
])
