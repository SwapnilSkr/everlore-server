import { Elysia, t } from 'elysia'
import { jwt } from '@elysiajs/jwt'
import { env } from '../config/env'
import { playWsController } from '../controllers/play-ws.controller'

export const wsRoutes = new Elysia()
  .use(jwt({ name: 'jwt', secret: env.JWT_SECRET }))
  .ws('/ws/play', {
    // NOTE: t.Object defaults to additionalProperties:false, so EVERY field any
    // action sends must be declared here or Elysia rejects the whole message at
    // validation (before the handler runs) with a `validation` frame. The
    // `replay` action carries `event_id` — omitting it silently broke replay.
    body: t.Object({
      action: t.String(),
      instance_id: t.Optional(t.String()),
      event_id: t.Optional(t.String()),
      payload: t.Optional(t.Any()),
    }),

    open: playWsController.open,
    message: playWsController.message,
    close: playWsController.close,
  })
