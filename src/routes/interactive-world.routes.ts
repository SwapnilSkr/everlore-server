import { Elysia, t } from 'elysia'
import { authPlugin } from '../middleware/auth'
import { interactiveWorldService } from '../services/interactive-world.service'
import { instanceService } from '../services/instance.service'
import { HttpError } from '../utils/http-error'

export const interactiveWorldRoutes = new Elysia({ prefix: '/interactive-worlds' })
  .use(authPlugin)
  // The walkable worlds this player may enter. Listed BEFORE the keyed routes
  // so '/interactive-worlds' is not read as a world called nothing.
  .get('/', ({ user }) => {
    if (!user) throw new HttpError(401, 'Sign in to walk these worlds.')
    return interactiveWorldService.listPlayable(user.id)
  })
  .get('/:worldKey', ({ params }) => interactiveWorldService.definition(params.worldKey))
  // Find-or-mint the player's save. Missing this is how the map opened as
  // a preview that could not persist.
  .get('/:worldKey/instance', ({ user, params }) => {
    if (!user) throw new HttpError(401, 'Sign in to walk this world.')
    return instanceService.resolveInteractiveWorld(params.worldKey, user.id, user.tier)
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
      type: t.Union([t.Literal('move'), t.Literal('choose'), t.Literal('rule'), t.Literal('talk')]),
      location_id: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
      choice_id: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
      petition_id: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
      resolution_id: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
      character_id: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
      // Bounded here rather than in the service: this is the one field a player
      // writes themselves, and an unbounded one is a prompt someone else pays
      // for. Long enough to say something real, short enough to be a remark.
      said: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
    }),
  })
