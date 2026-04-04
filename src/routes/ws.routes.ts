import { Elysia, t } from 'elysia'
import { jwt } from '@elysiajs/jwt'
import { env } from '../config/env'
import { playWsController } from '../controllers/play-ws.controller'

export const wsRoutes = new Elysia()
  .use(jwt({ name: 'jwt', secret: env.JWT_SECRET }))
  .ws('/ws/play', {
    body: t.Object({
      action: t.String(),
      instance_id: t.Optional(t.String()),
      payload: t.Optional(t.Any()),
    }),

    open: playWsController.open,
    message: playWsController.message,
    close: playWsController.close,
  })
