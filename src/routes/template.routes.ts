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
  GroupDraftBody,
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

const STARTER_CHOICES_DEFAULT = 4
const STARTER_CHOICES_MAX = 8
const TEMPLATE_ID_PATTERN = /^[a-fA-F0-9]{24}$/

/** `count` is a whole number 1..8; absent means four, anything else is a 400. */
function parseStarterCount(raw: unknown): number {
  if (raw === undefined) return STARTER_CHOICES_DEFAULT
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new HttpError(400, 'count must be a whole number from 1 to 8.')
  }
  const value = Number(raw)
  if (value < 1 || value > STARTER_CHOICES_MAX) {
    throw new HttpError(400, 'count must be a whole number from 1 to 8.')
  }
  return value
}

/** `exclude` is a comma-separated list of template ids; a bad id is a 400. */
function parseStarterExclude(raw: unknown): string[] {
  if (raw === undefined) return []
  if (typeof raw !== 'string') throw new HttpError(400, 'exclude must be a comma-separated list of template ids.')
  const ids = raw.split(',').map((id) => id.trim()).filter(Boolean)
  if (ids.some((id) => !TEMPLATE_ID_PATTERN.test(id))) {
    throw new HttpError(400, 'exclude must be a comma-separated list of template ids.')
  }
  return [...new Set(ids.map((id) => id.toLowerCase()))]
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

  // The four cards a new player picks from. Declared before /:id, like /starter,
  // or the path would be read as an id.
  .get('/starter-choices', async ({ user, query }) => {
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    const count = parseStarterCount(query.count)
    const exclude = parseStarterExclude(query.exclude)
    const templates = await templateService.starterChoices(user.id, count, exclude)
    return { templates: templates.map(publicTemplate) }
  })

  .get('/mine/list', (ctx) => templateController.listMine(ctx), { query: MyTemplateQueryParams })

  .get('/mine/quota', (ctx) => templateController.quota(ctx))

  // The owner's own read of a saved group, for editing. Declared before /:id
  // so the route is never mistaken for a template id.
  .get('/:id/authoring', (ctx) => templateController.groupAuthoring(ctx))

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

  .post('/group-draft', (ctx) => templateController.groupDraft(ctx), {
    body: GroupDraftBody,
  })

  .post('/', (ctx) => templateController.create(ctx), { body: CreateTemplateBody })

  .put('/:id', (ctx) => templateController.update(ctx), { body: UpdateTemplateBody })

  .post('/:id/publish', (ctx) => templateController.publish(ctx), { body: t.Optional(PublishTemplateBody) })

  // One person's face in a player-made group. The index is the cast position
  // the app read; a repaint is the player asking for the same look again.
  .post('/:id/cast/:index/portrait', (ctx) => templateController.castPortrait(ctx), {
    params: t.Object({
      id: t.String({ pattern: '^[a-fA-F0-9]{24}$' }),
      index: t.String({ pattern: '^[0-5]$' }),
    }),
    query: t.Optional(t.Object({ repaint: t.Optional(t.String()) })),
  })

  .delete('/:id', (ctx) => templateController.delete(ctx))
