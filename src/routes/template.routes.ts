import { Elysia } from 'elysia'
import { authPlugin } from '../middleware/auth'
import { templateService } from '../services/template.service'
import { CreateTemplateBody, UpdateTemplateBody, TemplateQueryParams } from '../schemas/template.schema'
import { rateLimit } from '../middleware/rate-limit'

export const templateRoutes = new Elysia({ prefix: '/templates' })
  .use(authPlugin)

  // Browse published templates (public)
  .get('/', async ({ query }) => {
    return templateService.listPublished(
      Number(query.page) || 1,
      Number(query.limit) || 20,
      query.search,
    )
  }, { query: TemplateQueryParams })

  // Get template by ID (public)
  .get('/:id', async ({ params }) => {
    const template = await templateService.getById(params.id)
    if (!template) throw new Error('Template not found')
    return template
  })

  // Create template (authenticated)
  .post('/', async ({ user, body }) => {
    if (!user) throw new Error('Unauthorized')
    if (user.tier !== 'creator' && user.tier !== 'premium') {
      throw new Error('Creator or premium tier required')
    }
    const rl = await rateLimit(user.id, 'template_create')
    if (!rl.allowed) {
      throw new Error('Template creation rate limit exceeded. Try again later.')
    }
    return templateService.create(user.id, body)
  }, { body: CreateTemplateBody })

  // Update template (owner only)
  .put('/:id', async ({ user, params, body }) => {
    if (!user) throw new Error('Unauthorized')
    return templateService.update(params.id, user.id, body)
  }, { body: UpdateTemplateBody })

  // Publish template (owner only)
  .post('/:id/publish', async ({ user, params }) => {
    if (!user) throw new Error('Unauthorized')
    return templateService.publish(params.id, user.id)
  })

  // List my templates (creator)
  .get('/mine/list', async ({ user }) => {
    if (!user) throw new Error('Unauthorized')
    return templateService.listByCreator(user.id)
  })
