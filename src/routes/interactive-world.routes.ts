import { Elysia, t } from 'elysia'
import { authPlugin } from '../middleware/auth'
import { interactiveWorldService } from '../services/interactive-world.service'
import { HttpError } from '../utils/http-error'

export const interactiveWorldRoutes = new Elysia({ prefix: '/interactive-worlds' })
  .use(authPlugin)
  .get('/:worldKey', ({ params }) => interactiveWorldService.definition(params.worldKey))
  .get('/:worldKey/instances/:instanceId', ({ user, params }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return interactiveWorldService.state(params.worldKey, params.instanceId, user.id)
  })
  .post('/:worldKey/instances/:instanceId/actions', ({ user, params, body }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return interactiveWorldService.act(params.worldKey, params.instanceId, user.id, body)
  }, {
    body: t.Object({
      type: t.Union([t.Literal('move'), t.Literal('choose'), t.Literal('rule')]),
      location_id: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
      choice_id: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
      petition_id: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
      resolution_id: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
    }),
  })
