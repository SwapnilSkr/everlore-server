import { Elysia, t } from 'elysia'
import { authPlugin } from '../middleware/auth'
import { billingController } from '../controllers/billing.controller'

export const billingRoutes = new Elysia({ prefix: '/billing' })
  .use(authPlugin)
  .get('/catalog', () => billingController.catalog())
  .get('/me', (ctx) => billingController.me(ctx))
  .post('/google/verify', (ctx) => billingController.verifyGoogle(ctx), {
    body: t.Object({
      product_id: t.String({ minLength: 1, maxLength: 120 }),
      purchase_token: t.String({ minLength: 1, maxLength: 4096 }),
      kind: t.Union([t.Literal('subscription'), t.Literal('consumable')]),
    }),
  })
  .post('/google/rtdn', (ctx) => billingController.googleRtdn(ctx), {
    body: t.Object({
      message: t.Optional(t.Object({ data: t.Optional(t.String()) })),
    }),
  })
