import type { AuthUser } from '../middleware/auth'
import { instanceService } from '../services/instance.service'
import { deletionService } from '../services/deletion.service'
import { HttpError } from '../utils/http-error'

export const instanceController = {
  list: async ({ user, query }: { user: AuthUser | null; query: { include_archived?: boolean } }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return instanceService.list(user.id, query.include_archived === true)
  },

  listRealms: async ({
    user,
    query,
  }: {
    user: AuthUser | null
    query: { page?: number; limit?: number; include_archived?: boolean; search?: string }
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return instanceService.listRealms(
      user.id,
      query.include_archived === true,
      Number(query.page) || 1,
      Number(query.limit) || 12,
      query.search,
    )
  },

  playStatus: async ({ user, params }: { user: AuthUser | null; params: { templateId: string } }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return instanceService.getPlayStatus(user.id, params.templateId)
  },

  listByTemplate: async ({ user, params }: { user: AuthUser | null; params: { templateId: string } }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return instanceService.listByTemplate(user.id, params.templateId)
  },

  getById: async ({ user, params }: { user: AuthUser | null; params: { id: string } }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    const instance = await instanceService.getById(params.id, user.id)
    if (!instance) throw new HttpError(404, 'Instance not found')
    return instance
  },

  create: async ({ user, body }: { user: AuthUser | null; body: { template_id: string; persona_id?: string } }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return instanceService.create(user.id, body.template_id, user.tier, body.persona_id)
  },

  archive: async ({ user, params }: { user: AuthUser | null; params: { id: string } }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return instanceService.archive(params.id, user.id)
  },

  reset: async ({ user, params }: { user: AuthUser | null; params: { id: string } }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return deletionService.resetInstance(params.id, user.id)
  },

  delete: async ({ user, params }: { user: AuthUser | null; params: { id: string } }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return deletionService.deleteInstance(params.id, user.id)
  },

  setProtagonist: async ({
    user,
    params,
    body,
  }: {
    user: AuthUser | null
    params: { id: string }
    body: { name?: string; identity?: string; reuse_from_instance_id?: string }
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return instanceService.setPlayerProtagonist(params.id, user.id, body)
  },

  reusableProtagonists: async ({ user, params }: { user: AuthUser | null; params: { id: string } }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return instanceService.listReusableProtagonists(params.id, user.id)
  },

  updateSettings: async ({
    user,
    params,
    body,
  }: {
    user: AuthUser | null
    params: { id: string }
    body: {
      narration_pov?: 'first' | 'third'
      mode?: string
      message_length?: 'short' | 'medium' | 'long'
      narrative_style_override?: string | null
      narration_tone?: string
      focus_character_id?: string | null
      persona_id?: string | null
    }
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return instanceService.updateSettings(params.id, user.id, body)
  },
}
