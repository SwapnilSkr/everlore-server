import { rateLimit } from '../middleware/rate-limit'
import type { AuthUser } from '../middleware/auth'
import { templateService } from '../services/template.service'
import type { Static } from '@sinclair/typebox'
import type { CreateTemplateBody, UpdateTemplateBody } from '../schemas/template.schema'

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

  getById: async ({ params }: { params: { id: string } }) => {
    const template = await templateService.getById(params.id)
    if (!template) throw new Error('Template not found')
    return template
  },

  create: async ({ user, body }: { user: AuthUser | null; body: CreateBody }) => {
    if (!user) throw new Error('Unauthorized')
    if (user.tier !== 'creator' && user.tier !== 'premium') {
      throw new Error('Creator or premium tier required')
    }
    const rl = await rateLimit(user.id, 'template_create')
    if (!rl.allowed) {
      throw new Error('Template creation rate limit exceeded. Try again later.')
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
    if (!user) throw new Error('Unauthorized')
    return templateService.update(params.id, user.id, body)
  },

  publish: async ({ user, params }: { user: AuthUser | null; params: { id: string } }) => {
    if (!user) throw new Error('Unauthorized')
    return templateService.publish(params.id, user.id)
  },

  listMine: async ({ user }: { user: AuthUser | null }) => {
    if (!user) throw new Error('Unauthorized')
    return templateService.listByCreator(user.id)
  },
}
