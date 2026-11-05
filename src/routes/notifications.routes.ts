import { Elysia, t } from 'elysia'
import { authPlugin } from '../middleware/auth'
import { notificationsController } from '../controllers/notifications.controller'

/** The bell (group-chat.md, "In-app notifications"): own rows only, 30 a page. */
export const notificationRoutes = new Elysia({ prefix: '/notifications' })
  .use(authPlugin)

  // The cursor is validated in the service so a bad value is a calm 400, not a
  // framework parse failure.
  .get('/', (ctx) => notificationsController.list(ctx))

  .post('/read', (ctx) => notificationsController.read(ctx), { body: t.Unknown() })
