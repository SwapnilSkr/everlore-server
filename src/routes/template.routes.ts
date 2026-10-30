import { Elysia, t } from 'elysia'
import { Value } from '@sinclair/typebox/value'
import { authPlugin } from '../middleware/auth'
import {
  CreateTemplateBody,
  UpdateTemplateBody,
  TemplateQueryParams,
  MyTemplateQueryParams,
  GenerateImageBody,
  UploadImageBody,
  AutofillBody,
  PublishTemplateBody,
} from '../schemas/template.schema'
import { templateController } from '../controllers/template.controller'
import { HttpError } from '../utils/http-error'
import { VALIDATION_MESSAGE } from '../utils/validation-response'
import { templateService } from '../services/template.service'
import { publicTemplate } from '../utils/template-public-projection'

/**
 * A list query outside the schema is a bad request, not an unprocessable entity.
 *
 * Elysia answers a failed schema with 422, and a route-local `onError` cannot
 * lower that: once the app registers a global `onError` (src/index.ts), the
 * parent's handler claims the error first whichever `as` the local one declares.
 * So the Explore parameters are checked in the transform stage, which runs
 * before validation, where a thrown HttpError keeps its own status through the
 * global handler. The query schema stays the authority; this only picks 400.
 *
 * Only the four Explore parameters are picked: `page` and `limit` arrive as raw
 * strings at this stage and are left to the schema.
 */
const ListQueryValues = t.Pick(TemplateQueryParams, ['kind', 'genre', 'styles', 'sort'])

function assertListQuery(query: unknown) {
  if (!Value.Check(ListQueryValues, query)) throw new HttpError(400, VALIDATION_MESSAGE)
}

export const templateRoutes = new Elysia({ prefix: '/templates' })
  .use(authPlugin)

  .get('/', (ctx) => templateController.listPublished(ctx), {
    query: TemplateQueryParams,
    transform: ({ query }) => assertListQuery(query),
  })

  // Must precede /:id or the shelf list would be read as an id.
  .get('/genres', (ctx) => templateController.listGenres(ctx))

  .get('/starter', async ({ user }) => {
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    const template = await templateService.starter(user.id)
    return { template: template ? publicTemplate(template) : null }
  })

  .get('/mine/list', (ctx) => templateController.listMine(ctx), { query: MyTemplateQueryParams })

  .get('/mine/quota', (ctx) => templateController.quota(ctx))

  .get('/:id', (ctx) => templateController.getById(ctx))

  .post('/image/generate', (ctx) => templateController.generateImage(ctx), {
    body: GenerateImageBody,
  })

  .post('/image/upload', (ctx) => templateController.uploadImage(ctx), {
    body: UploadImageBody,
  })

  .post('/autofill', (ctx) => templateController.autofill(ctx), {
    body: AutofillBody,
  })

  .post('/', (ctx) => templateController.create(ctx), { body: CreateTemplateBody })

  .put('/:id', (ctx) => templateController.update(ctx), { body: UpdateTemplateBody })

  .post('/:id/publish', (ctx) => templateController.publish(ctx), { body: t.Optional(PublishTemplateBody) })

  .delete('/:id', (ctx) => templateController.delete(ctx))
