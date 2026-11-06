import { sign } from 'node:crypto'
import { env } from '../../config/env'
import { mongoColl } from '../../config/mongo'
import { log } from '../../utils/logger'
import type { PushDeviceDoc } from '../../models/push-device.model'

export interface DirectNotification {
  notification: { title: string; body: string }
  data: { type: 'group_direct'; instanceId: string; characterId: string }
}

/** Every push the server sends. The phone routes by `data.type` and ignores the
 *  rest. Nothing from a reply's text is ever carried: `notification` is the
 *  bell row's own words. */
export interface PushPayload {
  notification: { title: string; body: string }
  data:
    | { type: 'group_direct'; instanceId: string; characterId: string }
    | { type: 'story_reply'; instanceId: string; thread?: 'room' | 'direct' }
    | { type: 'film_ready'; instanceId: string; mediaId: string }
}

export function directNotification(title: string, name: string, instanceId: string, characterId: string): DirectNotification {
  return { notification: { title, body: `${name} sent you a message` }, data: { type: 'group_direct', instanceId, characterId } }
}

export function storyReplyNotification(title: string, body: string, instanceId: string, thread?: 'room' | 'direct'): PushPayload {
  return { notification: { title, body }, data: { type: 'story_reply', instanceId, ...(thread ? { thread } : {}) } }
}

/** No provider response or thrown transport error is logged: either may echo a token. */
export function createFcmSender(deps: {
  credentials?: () => string; enabled?: () => boolean; now?: () => Date; fetch?: typeof fetch
} = {}) {
  const credentials = deps.credentials ?? (() => env.FCM_SERVICE_ACCOUNT_JSON)
  const enabled = deps.enabled ?? (() => env.GROUP_NOTIFICATIONS_ENABLED)
  const now = deps.now ?? (() => new Date())
  const request = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  let warned = false
  let access: { token: string; expires: number } | undefined
  let authorizing: Promise<string> | undefined
  function configured() {
    if (!enabled()) return false
    if (credentials().trim()) return true
    if (!warned) { warned = true; log.warn('push.credentials_missing') }
    return false
  }
  async function authorize(account: { client_email: string; private_key: string }) {
    if (access && access.expires > now().getTime() + 60_000) return access.token
    if (authorizing) return authorizing
    authorizing = (async () => {
      const iat = Math.floor(now().getTime() / 1000)
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
      const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: account.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 })}`
      const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url')}`
      const response = await request('https://oauth2.googleapis.com/token', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }), signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error('Push authorization failed')
      const body = await response.json() as { access_token?: unknown; expires_in?: unknown }
      if (typeof body.access_token !== 'string' || !body.access_token || !Number.isFinite(Number(body.expires_in)) || Number(body.expires_in) <= 0) throw new Error('Push authorization failed')
      access = { token: body.access_token, expires: now().getTime() + Math.min(3600, Number(body.expires_in)) * 1000 }
      return access.token
    })()
    try { return await authorizing } finally { authorizing = undefined }
  }
  async function send(device: PushDeviceDoc, payload: PushPayload): Promise<boolean> {
    if (!configured()) return false
    try {
      const account = JSON.parse(credentials()) as { project_id: string; client_email: string; private_key: string }
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(account.project_id) || !account.client_email || !account.private_key) return false
      const bearer = await authorize(account)
      if (!enabled()) return false
      if (!await mongoColl.pushDevices().findOne({ token: device.token, player_id: device.player_id, updated_at: device.updated_at })) return false
      const response = await request(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
        method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token: device.token, notification: payload.notification, data: payload.data } }), signal: AbortSignal.timeout(10_000),
      })
      if (response.ok) return true
      const body = await response.json().catch(() => ({})) as { error?: { details?: Array<{ '@type'?: string; errorCode?: string }> } }
      const invalid = body.error?.details?.some(detail => detail['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError' &&
        (detail.errorCode === 'UNREGISTERED' || detail.errorCode === 'INVALID_ARGUMENT'))
      if (invalid) await mongoColl.pushDevices().deleteOne({ token: device.token, player_id: device.player_id, updated_at: device.updated_at })
      return false
    } catch { log.warn('push.send_failed'); return false }
  }
  return { configured, send }
}

export const fcmSender = createFcmSender()
