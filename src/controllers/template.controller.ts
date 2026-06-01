import { rateLimit } from '../middleware/rate-limit'
import type { AuthUser } from '../middleware/auth'
import { templateService } from '../services/template.service'
import { deletionService } from '../services/deletion.service'
import { imageService } from '../services/image.service'
import { autofillService } from '../services/autofill.service'
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

  // Generate a preview image from a (creator-edited) prompt → returns CDN url.
  // Creator may call this repeatedly to re-roll until satisfied.
  generateImage: async ({
    user,
    body,
  }: {
    user: AuthUser | null
    body: { prompt: string }
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    if (user.tier !== 'creator' && user.tier !== 'premium') {
      throw new HttpError(403, 'Creator or premium tier required')
    }
    const rl = await rateLimit(user.id, 'image_generate')
    if (!rl.allowed) {
      throw new HttpError(429, 'Image generation rate limit exceeded. Try again shortly.')
    }
    return imageService.generatePreview(body.prompt)
  },

  // One-shot creation autofill — drafts an entire world/character from a brief.
  autofill: async ({
    user,
    body,
  }: {
    user: AuthUser | null
    body: {
      target: 'world' | 'character'
      brief?: string
      is_sentient?: boolean
      is_nsfw_capable?: boolean
      narrative_style?: string
    }
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    if (user.tier !== 'creator' && user.tier !== 'premium') {
      throw new HttpError(403, 'Creator or premium tier required')
    }
    const rl = await rateLimit(user.id, 'autofill')
    if (!rl.allowed) {
      throw new HttpError(429, 'Autofill rate limit exceeded. Try again shortly.')
    }
    const opts = {
      brief: body.brief,
      isSentient: body.is_sentient ?? (body.target === 'character'),
      isNsfwCapable: body.is_nsfw_capable ?? false,
      narrativeStyle: body.narrative_style,
    }
    if (body.target === 'character') {
      return { target: 'character', draft: await autofillService.autofillCharacter(opts) }
    }
    return { target: 'world', draft: await autofillService.autofillWorld(opts) }
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

  delete: async ({
    user,
    params,
  }: {
    user: AuthUser | null
    params: { id: string }
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return deletionService.deleteTemplate(params.id, user.id)
  },
}
