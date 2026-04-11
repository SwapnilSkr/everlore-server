import type { AuthUser } from '../middleware/auth'
import { instanceService } from '../services/instance.service'
import { deletionService } from '../services/deletion.service'
import { HttpError } from '../utils/http-error'

export const instanceController = {
  list: async ({
    user,
    query,
  }: {
    user: AuthUser | null
    query: { include_archived?: boolean }
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return instanceService.list(user.id, query.include_archived === true)
  },

  getById: async ({ user, params }: { user: AuthUser | null; params: { id: string } }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    const instance = await instanceService.getById(params.id, user.id)
    if (!instance) throw new HttpError(404, 'Instance not found')
    return instance
  },

  create: async ({
    user,
    body,
  }: {
    user: AuthUser | null
    body: { template_id: string }
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return instanceService.create(user.id, body.template_id, user.tier)
  },

  archive: async ({ user, params }: { user: AuthUser | null; params: { id: string } }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return instanceService.archive(params.id, user.id)
  },

  delete: async ({ user, params }: { user: AuthUser | null; params: { id: string } }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return deletionService.deleteInstance(params.id, user.id)
  },
}
