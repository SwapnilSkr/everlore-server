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
import { billingService } from '../services/billing.service'

type CreateBody = Static<typeof CreateTemplateBody>
type UpdateBody = Static<typeof UpdateTemplateBody>

export const templateController = {
  listPublished: async ({
    query,
    user,
  }: {
    query: { page?: number; limit?: number; search?: string }
    user: AuthUser | null
  }) => {
    return templateService.listPublished(
      Number(query.page) || 1,
      Number(query.limit) || 20,
      query.search,
      user?.id,
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
    headers,
  }: {
    user: AuthUser | null
    body: { prompt: string }
    headers: Record<string, string | undefined>
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    if (user.tier !== 'creator' && user.tier !== 'premium') {
      throw new HttpError(403, 'Creator or premium tier required')
    }
    const rl = await rateLimit(user.id, 'image_generate')
    if (!rl.allowed) {
      throw new HttpError(429, 'Image generation rate limit exceeded. Try again shortly.')
    }
    const reservation = await billingService.reserve(
      user.id,
      'image_preview',
      headers['x-idempotency-key'] || crypto.randomUUID(),
    )
    try {
      return await imageService.generatePreview(body.prompt)
    } catch (error) {
      await billingService.release(user.id, reservation.reservation_id)
      throw error
    }
  },

  // Stores a creator-selected image using the same preview → durable-media
  // lifecycle as generated artwork. The image service validates its real bytes
  // and creates a lossless WebP derivative before it reaches object storage.
  uploadImage: async ({
    user,
    body,
  }: {
    user: AuthUser | null
    body: { image: File }
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    if (user.tier !== 'creator' && user.tier !== 'premium') {
      throw new HttpError(403, 'Creator or premium tier required')
    }
    const rl = await rateLimit(user.id, 'image_upload')
    if (!rl.allowed) {
      throw new HttpError(429, 'Too many image uploads. Try again shortly.')
    }
    return imageService.uploadUserImage(body.image)
  },

  // One-shot creation autofill — drafts an entire world/character from a brief.
  autofill: async ({
    user,
    body,
    headers,
  }: {
    user: AuthUser | null
    body: {
      target: 'world' | 'character'
      brief?: string
      is_sentient?: boolean
      is_nsfw_capable?: boolean
      narrative_style?: string
    }
    headers: Record<string, string | undefined>
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
    const reservation = await billingService.reserve(
      user.id,
      body.target === 'character' ? 'character_autofill' : 'world_autofill',
      headers['x-idempotency-key'] || crypto.randomUUID(),
    )
    try {
      if (body.target === 'character') {
        return { target: 'character', draft: await autofillService.autofillCharacter(opts) }
      }
      return { target: 'world', draft: await autofillService.autofillWorld(opts) }
    } catch (error) {
      await billingService.release(user.id, reservation.reservation_id)
      throw error
    }
  },

  // Daily creation budget for a creator. The client can read this BEFORE the
  // creation flow (which spends real money on preview images) so it never lets
  // a creator craft a whole world only to be walled at the final submit.
  quota: async ({ user }: { user: AuthUser | null }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    const canCreate = user.tier === 'creator' || user.tier === 'premium'
    if (!canCreate) {
      return { can_create: false, reason: 'tier', remaining: 0, retry_after: null }
    }
    const rl = await rateLimit(user.id, 'template_create', { consume: false })
    return {
      can_create: rl.allowed,
      reason: rl.allowed ? null : 'daily_limit',
      remaining: rl.remaining === Infinity ? null : rl.remaining,
      retry_after: rl.retryAfter ?? null,
    }
  },

  create: async ({ user, body }: { user: AuthUser | null; body: CreateBody }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    if (user.tier !== 'creator' && user.tier !== 'premium') {
      throw new HttpError(403, 'Creator or premium tier required')
    }
    // Check the budget WITHOUT consuming it, so a create that fails validation
    // (or anything downstream) doesn't burn one of the day's slots.
    const rl = await rateLimit(user.id, 'template_create', { consume: false })
    if (!rl.allowed) {
      throw new HttpError(
        429,
        'Daily template creation limit reached. Try again later.',
        { retryAfter: rl.retryAfter ?? null, remaining: 0 },
      )
    }
    const template = await templateService.create(user.id, body)
    // Only now spend the slot — the world actually exists.
    await rateLimit(user.id, 'template_create')
    return template
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

  listMine: async ({ user, query }: { user: AuthUser | null; query: { page?: number; limit?: number; search?: string } }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return templateService.listByCreator(user.id, Number(query.page) || 1, Number(query.limit) || 20, query.search)
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
