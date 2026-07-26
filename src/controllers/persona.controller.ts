import type { AuthUser } from '../middleware/auth'
import { personaService, type PersonaInput } from '../services/persona.service'
import { HttpError } from '../utils/http-error'

export const personaController = {
  list: async ({ user, query }: { user: AuthUser | null; query: { page?: number; limit?: number; search?: string } }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return personaService.list(user.id, Number(query.page) || 1, Number(query.limit) || 20, query.search)
  },

  create: async ({ user, body }: { user: AuthUser | null; body: PersonaInput }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return personaService.create(user.id, body as any)
  },

  update: async ({
    user,
    params,
    body,
  }: {
    user: AuthUser | null
    params: { id: string }
    body: PersonaInput
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return personaService.update(user.id, params.id, body)
  },

  delete: async ({ user, params }: { user: AuthUser | null; params: { id: string } }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return personaService.delete(user.id, params.id)
  },
}
