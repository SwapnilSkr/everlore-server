import { rateLimit } from '../middleware/rate-limit'
import type { AuthUser } from '../middleware/auth'
import { templateService } from '../services/template.service'
import type { Static } from '@sinclair/typebox'
import type { CreateTemplateBody, UpdateTemplateBody } from '../schemas/template.schema'
import { HttpError } from '../utils/http-error'
import { idString } from '../utils/mongo-id'

type CreateBody = Static<typeof CreateTemplateBody>
type UpdateBody = Static<typeof UpdateTemplateBody>

export const templateController = {
  listPublished: async ({
    query,
  }: {
    query: { page?: number; limit?: number; search?: string }
  }) => {
    return templateService.listPublished(
      Number(query.page) || 1,
      Number(query.limit) || 20,
      query.search,
    )
  },

  getById: async ({
    params,
    user,
  }: {
    params: { id: string }
    user: AuthUser | null
  }) => {
    const template = await templateService.getById(params.id)
    if (!template) throw new HttpError(404, 'Template not found')

    if (!template.is_published) {
      if (!user) throw new HttpError(401, 'Unauthorized')
      if (idString(template.creator_id) !== user.id) {
        throw new HttpError(403, 'You do not have access to this template')
      }
    }

    return template
  },

  create: async ({ user, body }: { user: AuthUser | null; body: CreateBody }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    if (user.tier !== 'creator' && user.tier !== 'premium') {
      throw new HttpError(403, 'Creator or premium tier required')
    }
    const rl = await rateLimit(user.id, 'template_create')
    if (!rl.allowed) {
      throw new HttpError(429, 'Template creation rate limit exceeded. Try again later.')
    }
    return templateService.create(user.id, body)
  },

  update: async ({
    user,
    params,
    body,
  }: {
    user: AuthUser | null
    params: { id: string }
    body: UpdateBody
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return templateService.update(params.id, user.id, body)
  },

  publish: async ({ user, params }: { user: AuthUser | null; params: { id: string } }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return templateService.publish(params.id, user.id)
  },

  listMine: async ({ user }: { user: AuthUser | null }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return templateService.listByCreator(user.id)
  },
}
