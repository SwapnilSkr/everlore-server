import { Elysia } from 'elysia'
import { authPlugin } from '../middleware/auth'
import { CreateTemplateBody, UpdateTemplateBody, TemplateQueryParams } from '../schemas/template.schema'
import { templateController } from '../controllers/template.controller'

export const templateRoutes = new Elysia({ prefix: '/templates' })
  .use(authPlugin)

  .get('/', (ctx) => templateController.listPublished(ctx), { query: TemplateQueryParams })

  .get('/mine/list', (ctx) => templateController.listMine(ctx))

  .get('/:id', (ctx) => templateController.getById(ctx))

  .post('/', (ctx) => templateController.create(ctx), { body: CreateTemplateBody })

  .put('/:id', (ctx) => templateController.update(ctx), { body: UpdateTemplateBody })

  .post('/:id/publish', (ctx) => templateController.publish(ctx))
