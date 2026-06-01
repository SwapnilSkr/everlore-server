import { Elysia } from 'elysia'
import { authPlugin } from '../middleware/auth'
import {
  CreateTemplateBody,
  UpdateTemplateBody,
  TemplateQueryParams,
  SuggestImageBody,
  GenerateImageBody,
} from '../schemas/template.schema'
import { templateController } from '../controllers/template.controller'

export const templateRoutes = new Elysia({ prefix: '/templates' })
  .use(authPlugin)

  .get('/', (ctx) => templateController.listPublished(ctx), { query: TemplateQueryParams })

  .get('/mine/list', (ctx) => templateController.listMine(ctx))

  .get('/:id', (ctx) => templateController.getById(ctx))

  .post('/image/suggest', (ctx) => templateController.suggestImagePrompt(ctx), {
    body: SuggestImageBody,
  })

  .post('/image/generate', (ctx) => templateController.generateImage(ctx), {
    body: GenerateImageBody,
  })

  .post('/', (ctx) => templateController.create(ctx), { body: CreateTemplateBody })

  .put('/:id', (ctx) => templateController.update(ctx), { body: UpdateTemplateBody })

  .post('/:id/publish', (ctx) => templateController.publish(ctx))

  .delete('/:id', (ctx) => templateController.delete(ctx))
