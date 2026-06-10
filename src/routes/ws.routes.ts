import { Elysia } from 'elysia'
import { jwt } from '@elysiajs/jwt'
import { env } from '../config/env'
import { playWsController } from '../controllers/play-ws.controller'
import { WsMessage } from '../schemas/ws-message.schema'

export const wsRoutes = new Elysia()
  .use(jwt({ name: 'jwt', secret: env.JWT_SECRET }))
  .ws('/ws/play', {
    // NOTE: t.Object defaults to additionalProperties:false, so EVERY field any
    // action sends must be declared on WsMessage or Elysia rejects the frame
    // at validation (before the handler runs). See ws-message.schema.ts.
    body: WsMessage,

    open: playWsController.open,
    message: playWsController.message,
    close: playWsController.close,
  })
