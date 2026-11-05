import { listNotifications, markNotificationsRead } from '../services/notifications.service'
import type { AuthUser } from '../middleware/auth'
import { HttpError } from '../utils/http-error'

export const notificationsController = {
  list: async ({ user, query }: { user: AuthUser | null; query: { before?: unknown } }) => {
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    return listNotifications(user.id, query ?? {})
  },

  read: async ({ user, body }: { user: AuthUser | null; body: unknown }) => {
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    return markNotificationsRead(user.id, body)
  },
}
