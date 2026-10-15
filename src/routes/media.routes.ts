import { Elysia, t } from 'elysia'
import { authPlugin } from '../middleware/auth'
import { requestVoice } from '../services/media/service'
import { mediaUsage } from '../services/media/usage'
import { mediaEnabled } from '../services/media/config'
import { HttpError } from '../utils/http-error'
import { parseObjectId } from '../utils/mongo-id'

export const mediaRoutes = new Elysia()
  .use(authPlugin)
  .post('/instances/:instanceId/events/:eventId/lines/:lineId/voice', async ({ user, params, set }) => {
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    try {
      const result = await requestVoice(user.id, params.instanceId, params.eventId, params.lineId)
      set.status = result.status === 'ready' ? 200 : 202
      return result
    } catch (error) {
      if (error instanceof HttpError && (error.statusCode === 422 || error.statusCode === 429) && error.details?.status) {
        set.status = error.statusCode
        return error.details
      }
      throw error
    }
  }, { params: t.Object({ instanceId: t.String({ pattern: '^[a-fA-F0-9]{24}$' }), eventId: t.String({ pattern: '^[a-fA-F0-9]{24}$' }), lineId: t.String({ pattern: '^l[0-9]+$' }) }) })
  .get('/media/usage', async ({ user }) => {
    if (!user) throw new HttpError(401, 'Sign in to continue.')
    if (!mediaEnabled()) throw new HttpError(404, 'That moment could not be found.')
    return mediaUsage(parseObjectId(user.id))
  })
