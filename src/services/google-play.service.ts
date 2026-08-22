import { createSign, createVerify } from 'node:crypto'
import { env } from '../config/env'
import { HttpError } from '../utils/http-error'

type ServiceAccount = {
  client_email: string
  private_key: string
  token_uri?: string
}

type AccessToken = { value: string; expiresAt: number }
let accessToken: AccessToken | null = null
let googleCerts: { values: Record<string, string>; expiresAt: number } | null = null

function b64url(value: string) {
  return Buffer.from(value).toString('base64url')
}

function credentials(): ServiceAccount {
  if (!env.GOOGLE_PLAY_PACKAGE_NAME || !env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) {
    throw new HttpError(503, 'Google Play billing is not configured yet')
  }
  try {
    return JSON.parse(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) as ServiceAccount
  } catch {
    throw new HttpError(500, 'Google Play service-account configuration is invalid')
  }
}

async function publisherToken() {
  if (accessToken && accessToken.expiresAt > Date.now() + 60_000) return accessToken.value
  const credential = credentials()
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: credential.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: credential.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }))}`
  const signer = createSign('RSA-SHA256')
  signer.update(unsigned)
  signer.end()
  const assertion = `${unsigned}.${signer.sign(credential.private_key, 'base64url')}`
  const response = await fetch(credential.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  if (!response.ok) throw new HttpError(502, 'Could not authenticate with Google Play')
  const body = await response.json() as { access_token?: string; expires_in?: number }
  if (!body.access_token) throw new HttpError(502, 'Google Play did not return an access token')
  accessToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 }
  return accessToken.value
}

async function publisherFetch(path: string, init?: RequestInit) {
  const token = await publisherToken()
  const response = await fetch(`https://androidpublisher.googleapis.com/androidpublisher/v3/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers || {}) },
  })
  if (!response.ok) {
    if (response.status === 404) throw new HttpError(400, 'This Google Play purchase could not be found')
    throw new HttpError(502, 'Google Play purchase verification failed')
  }
  return response.status === 204 ? null : response.json() as Promise<any>
}

export type VerifiedGooglePurchase =
  | { kind: 'subscription'; productId: string; basePlanId?: string; purchaseToken: string; expiresAt?: Date; active: boolean }
  | { kind: 'consumable'; productId: string; purchaseToken: string; active: boolean }

export const googlePlayService = {
  configured() {
    return Boolean(env.GOOGLE_PLAY_PACKAGE_NAME && env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON)
  },

  async verifyRtdnBearer(authorization?: string) {
    if (!env.GOOGLE_PLAY_RTDN_AUDIENCE || !env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL) {
      throw new HttpError(503, 'Google Play RTDN is not configured yet')
    }
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
    const [encodedHeader, encodedPayload, encodedSignature] = token.split('.')
    if (!encodedHeader || !encodedPayload || !encodedSignature) throw new HttpError(401, 'Invalid RTDN authorization')
    let header: { kid?: string }
    let payload: { aud?: string; iss?: string; exp?: number; email?: string }
    try {
      header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString())
      payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString())
    } catch {
      throw new HttpError(401, 'Invalid RTDN authorization')
    }
    if (!googleCerts || googleCerts.expiresAt < Date.now()) {
      const response = await fetch('https://www.googleapis.com/oauth2/v1/certs')
      if (!response.ok) throw new HttpError(502, 'Could not verify Google RTDN authorization')
      const cacheControl = response.headers.get('cache-control') || ''
      const seconds = Number(cacheControl.match(/max-age=(\d+)/)?.[1] || 300)
      googleCerts = { values: await response.json() as Record<string, string>, expiresAt: Date.now() + seconds * 1000 }
    }
    const certificate = header.kid ? googleCerts.values[header.kid] : undefined
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${encodedHeader}.${encodedPayload}`)
    verifier.end()
    const validSignature = Boolean(certificate) && verifier.verify(certificate!, encodedSignature, 'base64url')
    const validIssuer = payload.iss === 'accounts.google.com' || payload.iss === 'https://accounts.google.com'
    if (!validSignature || !validIssuer || payload.aud !== env.GOOGLE_PLAY_RTDN_AUDIENCE ||
        payload.email !== env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL || !payload.exp || payload.exp * 1000 < Date.now()) {
      throw new HttpError(401, 'Invalid RTDN authorization')
    }
  },

  async verify(input: { productId: string; purchaseToken: string; kind: 'subscription' | 'consumable' }): Promise<VerifiedGooglePurchase> {
    const packageName = env.GOOGLE_PLAY_PACKAGE_NAME
    if (!this.configured()) throw new HttpError(503, 'Google Play billing is not configured yet')
    const productId = encodeURIComponent(input.productId)
    const token = encodeURIComponent(input.purchaseToken)
    if (input.kind === 'consumable') {
      const row = await publisherFetch(`applications/${packageName}/purchases/products/${productId}/tokens/${token}`)
      if (row.purchaseState !== 0) throw new HttpError(400, 'This Google Play purchase is not complete')
      return { kind: 'consumable', productId: input.productId, purchaseToken: input.purchaseToken, active: true }
    }

    const row = await publisherFetch(`applications/${packageName}/purchases/subscriptionsv2/tokens/${token}`)
    const line = Array.isArray(row.lineItems)
      ? row.lineItems.find((item: any) => item.productId === input.productId) || row.lineItems[0]
      : null
    if (!line || line.productId !== input.productId) throw new HttpError(400, 'This purchase does not match that subscription')
    const expiresAt = line.expiryTime ? new Date(line.expiryTime) : undefined
    // A user can cancel auto-renewal while retaining access through the end of
    // the already-paid period. Revoked/expired/on-hold subscriptions do not
    // grant access, but CANCELLED remains entitled until its expiry time.
    const activeStates = new Set([
      'SUBSCRIPTION_STATE_ACTIVE',
      'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
      'SUBSCRIPTION_STATE_CANCELED',
    ])
    const active = activeStates.has(row.subscriptionState)
      && (!expiresAt || expiresAt.getTime() > Date.now())
    return {
      kind: 'subscription',
      productId: line.productId,
      basePlanId: line.offerDetails?.basePlanId,
      purchaseToken: input.purchaseToken,
      expiresAt,
      active,
    }
  },

  async acknowledgeSubscription(productId: string, purchaseToken: string) {
    const packageName = env.GOOGLE_PLAY_PACKAGE_NAME
    await publisherFetch(
      `applications/${packageName}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    )
  },

  async consume(productId: string, purchaseToken: string) {
    const packageName = env.GOOGLE_PLAY_PACKAGE_NAME
    await publisherFetch(
      `applications/${packageName}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:consume`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    )
  },
}
