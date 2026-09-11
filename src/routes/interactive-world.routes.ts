import { Elysia, t } from 'elysia'
import { authPlugin } from '../middleware/auth'
import { interactiveWorldService } from '../services/interactive-world.service'
import { interactiveWorldInstanceService } from '../services/interactive-world-instance.service'
import { deletionService } from '../services/deletion.service'
import { HttpError } from '../utils/http-error'

export const interactiveWorldRoutes = new Elysia({ prefix: '/interactive-worlds' })
  .use(authPlugin)
  .get('/', ({ user, query }) => {
    return interactiveWorldService.listPublished(user?.id, query.search)
  }, {
    query: t.Object({
      search: t.Optional(t.String()),
    }),
  })
  .get('/mine', ({ user, query }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return interactiveWorldService.listMine(
      user.id,
      Number(query.page) || 1,
      Number(query.limit) || 20,
      query.search,
    )
  }, {
    query: t.Object({
      page: t.Optional(t.Numeric()),
      limit: t.Optional(t.Numeric()),
      search: t.Optional(t.String()),
    }),
  })
  .get('/instances', ({ user, query }) => {
    if (!user) throw new HttpError(401, 'Sign in to see your walks.')
    return interactiveWorldInstanceService.listRealms(
      user.id,
      query.include_archived === true,
      Number(query.page) || 1,
      Number(query.limit) || 12,
      query.search,
    )
  }, {
    query: t.Object({
      page: t.Optional(t.Numeric()),
      limit: t.Optional(t.Numeric()),
      include_archived: t.Optional(t.Boolean()),
      search: t.Optional(t.String()),
    }),
  })
  .post('/instances/:instanceId/archive', ({ user, params }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return interactiveWorldInstanceService.archive(params.instanceId, user.id)
  })
  .delete('/instances/:instanceId', ({ user, params }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return deletionService.deleteInstance(params.instanceId, user.id)
  })
  .get('/play-status/:worldId', ({ user, params }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return interactiveWorldInstanceService.getPlayStatus(user.id, params.worldId)
  })
  .get('/by-world/:worldId', ({ user, params }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return interactiveWorldInstanceService.listByWorld(user.id, params.worldId)
  })
  .post('/:worldKey/publish', ({ user, params }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return interactiveWorldService.publish(params.worldKey, user.id)
  })
  .delete('/:worldKey', ({ user, params }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return interactiveWorldService.deleteOwned(params.worldKey, user.id)
  })
  .post('/:worldKey/instances', ({ user, params }) => {
    if (!user) throw new HttpError(401, 'Sign in to walk this world.')
    return interactiveWorldInstanceService.create(user.id, params.worldKey, user.tier).then(({ instance }) => ({
      instance: {
        _id: instance._id,
        template_id: instance.world_id,
        world_id: instance.world_id,
        world_key: instance.world_key,
        player_id: instance.player_id,
        meta: instance.meta,
        created_at: instance.created_at,
        updated_at: instance.updated_at,
      },
    }))
  })
  .get('/:worldKey', ({ params }) => interactiveWorldService.definition(params.worldKey))
  .get('/:worldKey/instance', ({ user, params }) => {
    if (!user) throw new HttpError(401, 'Sign in to walk this world.')
    return interactiveWorldInstanceService.resolve(params.worldKey, user.id, user.tier)
  })
  .get('/:worldKey/instances/:instanceId', ({ user, params }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return interactiveWorldService.state(params.worldKey, params.instanceId, user.id)
  })
  .post('/:worldKey/instances/:instanceId/actions', ({ user, params, body }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return interactiveWorldService.act(params.worldKey, params.instanceId, user.id, body)
  }, {
    body: t.Object({
      type: t.Union([
        t.Literal('move'),
        t.Literal('choose'),
        t.Literal('rule'),
        t.Literal('talk'),
        t.Literal('bind'),
        t.Literal('begin'),
        t.Literal('restore'),
        t.Literal('rebind'),
        t.Literal('train'),
        t.Literal('tour'),
      ]),
      location_id: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
      choice_id: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
      petition_id: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
      resolution_id: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
      character_id: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
      checkpoint_id: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
      drill_id: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
      said: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
    }),
  })
