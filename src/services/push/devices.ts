import { mongoColl } from '../../config/mongo'
import { requireIdentity } from '../guest-policy'
import { parseObjectId } from '../../utils/mongo-id'
import { HttpError } from '../../utils/http-error'

function deviceBody(body: unknown, registering: boolean): { token: string; platform?: 'android'; tz_offset_minutes?: number } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Please try again.')
  const input = body as Record<string, unknown>
  if (Object.keys(input).some(key => !['token', ...(registering ? ['platform', 'tz_offset_minutes'] : [])].includes(key)) ||
    typeof input.token !== 'string' || input.token.length < 1 || input.token.length > 4096 || /\s/.test(input.token) ||
    (registering && input.platform !== 'android') ||
    (input.tz_offset_minutes !== undefined && (!Number.isInteger(input.tz_offset_minutes) || Math.abs(input.tz_offset_minutes as number) > 14 * 60))) throw new HttpError(400, 'Please try again.')
  return { token: input.token, ...(registering ? { platform: 'android' as const } : {}),
    ...(input.tz_offset_minutes !== undefined ? { tz_offset_minutes: input.tz_offset_minutes as number } : {}) }
}

export async function registerPushDevice(playerId: string, body: unknown, now = new Date()) {
  await requireIdentity(playerId)
  const { token, tz_offset_minutes } = deviceBody(body, true)
  try {
    await mongoColl.pushDevices().updateOne({ token }, {
      $set: { player_id: parseObjectId(playerId), token, platform: 'android', updated_at: now, ...(tz_offset_minutes !== undefined ? { tz_offset_minutes } : {}) },
    }, { upsert: true })
  } catch { throw new HttpError(503, 'Please try again in a moment.') }
  return { success: true }
}

export async function removePushDevice(playerId: string, body: unknown) {
  await requireIdentity(playerId)
  const { token } = deviceBody(body, false)
  try {
    await mongoColl.pushDevices().deleteOne({ player_id: parseObjectId(playerId), token })
  } catch { throw new HttpError(503, 'Please try again in a moment.') }
  return { success: true }
}
