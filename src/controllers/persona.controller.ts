import type { AuthUser } from '../middleware/auth'
import { personaService, type PersonaInput } from '../services/persona.service'
import { HttpError } from '../utils/http-error'

export const personaController = {
  list: async ({ user }: { user: AuthUser | null }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return personaService.list(user.id)
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
