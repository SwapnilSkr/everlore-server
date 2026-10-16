import { Elysia, t } from 'elysia'
import { authPlugin } from '../middleware/auth'
import { requestVoice } from '../services/media/service'
import { requestPicture, requestPersonaPortrait, requestPortrait, requestVideo, requestTurnVideo } from '../services/media/visual'
import { hideKeepsake, listKeepsakes } from '../services/media/keepsakes'
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
  .post('/instances/:id/events/:eventId/video', async ({ user, params, set }) => {
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    try {
      return queued(await requestTurnVideo(user.id, params.id, params.eventId), set)
    } catch (error) {
      return resting(error, set)
    }
  }, { params: t.Object(idParams) })
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
  .post('/personas/:personaId/portrait', async ({ user, params, query, set }) => {
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    try {
      // "Give yourself a face" paints from the persona's own description and
      // stores on the persona, with or without a save. It never resolves to
      // a card: the save's protagonist can belong to another world entirely.
      // An optional save paints that save's world style; an unknown or foreign
      // save is a 404 from the service. Personas live under /personas, never
      // under /instances/:id, so the save rides the query, not the path.
      return queued(await requestPersonaPortrait(user.id, params.personaId,
        { ...(query?.instance_id ? { instanceId: query.instance_id } : {}) }), set)
    } catch (error) {
      return resting(error, set)
    }
  }, {
    params: t.Object({ personaId: t.String({ pattern: '^[a-fA-F0-9]{24}$' }) }),
    query: t.Optional(t.Object({ instance_id: t.Optional(t.String({ pattern: '^[a-fA-F0-9]{24}$' })) })),
  })
  .get('/media/usage', async ({ user }) => {
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    if (!mediaEnabled()) throw new HttpError(404, 'That moment could not be found.')
    return mediaUsage(parseObjectId(user.id))
  })
  .get('/media/keepsakes', async ({ user, query }) => {
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    return listKeepsakes(user.id, { ...(query?.kind ? { kind: query.kind } : {}), ...(query?.before ? { before: query.before } : {}), ...(query?.limit ? { limit: query.limit } : {}) })
  }, {
    query: t.Optional(t.Object({
      kind: t.Optional(t.String()),
      before: t.Optional(t.String()),
      limit: t.Optional(t.String()),
    })),
  })
  // The param is :mediaId, never :id: one param name per path segment.
  .post('/media/keepsakes/:mediaId/hide', async ({ user, params, set }) => {
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    await hideKeepsake(user.id, params.mediaId)
    set.status = 204
  }, {
    params: t.Object({ mediaId: t.String({ pattern: '^[a-fA-F0-9]{24}$' }) }),
  })
