import { Elysia, t } from 'elysia'
import { authPlugin } from '../middleware/auth'
import { requestVoice } from '../services/media/service'
import { requestPicture, requestPersonaPortrait, requestPortrait, requestVideo } from '../services/media/visual'
import { mediaUsage } from '../services/media/usage'
import { mediaEnabled } from '../services/media/config'
import { HttpError } from '../utils/http-error'
import { parseObjectId } from '../utils/mongo-id'

const queued = (result: { status: string }, set: { status?: unknown }) => {
  set.status = result.status === 'ready' ? 200 : 202
  return result
}
const resting = (error: unknown, set: { status?: unknown }) => {
  if (error instanceof HttpError && (error.statusCode === 422 || error.statusCode === 429) && error.details?.status) {
    set.status = error.statusCode
    return error.details
  }
  throw error
}

const idParams = {
  id: t.String({ pattern: '^[a-fA-F0-9]{24}$' }),
  eventId: t.String({ pattern: '^[a-fA-F0-9]{24}$' }),
}

export const mediaRoutes = new Elysia()
  .use(authPlugin)
  // Elysia's router needs one param name per path segment: instance routes already use `:id`.
  .post('/instances/:id/events/:eventId/lines/:lineId/voice', async ({ user, params, set }) => {
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    try {
      const result = await requestVoice(user.id, params.id, params.eventId, params.lineId)
      set.status = result.status === 'ready' ? 200 : 202
      return result
    } catch (error) {
      if (error instanceof HttpError && (error.statusCode === 422 || error.statusCode === 429) && error.details?.status) {
        set.status = error.statusCode
        return error.details
      }
      throw error
    }
  }, { params: t.Object({ id: t.String({ pattern: '^[a-fA-F0-9]{24}$' }), eventId: t.String({ pattern: '^[a-fA-F0-9]{24}$' }), lineId: t.String({ pattern: '^l[0-9]+$' }) }) })
  .post('/instances/:id/events/:eventId/picture', async ({ user, params, set }) => {
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    try {
      return queued(await requestPicture(user.id, params.id, params.eventId), set)
    } catch (error) {
      return resting(error, set)
    }
  }, { params: t.Object(idParams) })
  .post('/instances/:id/events/:eventId/lines/:lineId/video', async ({ user, params, set }) => {
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    try {
      return queued(await requestVideo(user.id, params.id, params.eventId, params.lineId), set)
    } catch (error) {
      return resting(error, set)
    }
  }, { params: t.Object({ ...idParams, lineId: t.String({ pattern: '^l[0-9]+$' }) }) })
  .post('/instances/:id/characters/:characterId/portrait', async ({ user, params, query, set }) => {
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    try {
      return queued(await requestPortrait(user.id, params.id, params.characterId, { repaint: query?.repaint === 'true' }), set)
    } catch (error) {
      return resting(error, set)
    }
  }, {
    params: t.Object({ id: t.String({ pattern: '^[a-fA-F0-9]{24}$' }), characterId: t.String({ pattern: '^[a-fA-F0-9]{24}$' }) }),
    query: t.Optional(t.Object({ repaint: t.Optional(t.String()) })),
  })
  .post('/personas/:personaId/portrait', async ({ user, params, set }) => {
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    try {
      // "Give yourself a face" paints from the persona's own description and
      // stores on the persona, with or without a save. It never resolves to
      // a card: the save's protagonist can belong to another world entirely.
      return queued(await requestPersonaPortrait(user.id, params.personaId), set)
    } catch (error) {
      return resting(error, set)
    }
  }, { params: t.Object({ personaId: t.String({ pattern: '^[a-fA-F0-9]{24}$' }) }) })
  .get('/media/usage', async ({ user }) => {
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    if (!mediaEnabled()) throw new HttpError(404, 'That moment could not be found.')
    return mediaUsage(parseObjectId(user.id))
  })
