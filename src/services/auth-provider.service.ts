import { env } from '../config/env'

interface GoogleTokenInfo {
  sub?: string
  email?: string
  email_verified?: string
  name?: string
  picture?: string
  aud?: string
}

export interface VerifiedGoogleProfile {
  subject: string
  email: string
  name?: string
  picture?: string
}

function isMockTwilioMode(): boolean {
  return (
    !env.TWILIO_ACCOUNT_SID ||
    !env.TWILIO_AUTH_TOKEN ||
    !env.TWILIO_VERIFY_SERVICE_SID ||
    env.TWILIO_ACCOUNT_SID === 'AC_MOCK_SID'
  )
}

function twilioAuthHeader(): string {
  const credentials = Buffer.from(
    `${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`,
  ).toString('base64')
  return `Basic ${credentials}`
}

async function parseJsonSafely(response: Response): Promise<any> {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

export async function verifyGoogleIdToken(
  idToken: string,
): Promise<VerifiedGoogleProfile> {
  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
  )
  const payload = (await parseJsonSafely(response)) as GoogleTokenInfo & {
    error_description?: string
  }

  if (!response.ok) {
    throw new Error(payload.error_description || 'Invalid Google token')
  }

  if (!payload.sub || !payload.email) {
    throw new Error('Google token is missing required user information')
  }

  if (payload.email_verified !== 'true') {
    throw new Error('Google account email is not verified')
  }

  if (env.GOOGLE_CLIENT_ID && payload.aud !== env.GOOGLE_CLIENT_ID) {
    throw new Error('Google token audience mismatch')
  }

  return {
    subject: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
  }
}

export async function sendPhoneOtp(phone: string): Promise<void> {
  if (isMockTwilioMode()) return

  const response = await fetch(
    `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}/Verifications`,
    {
      method: 'POST',
      headers: {
        Authorization: twilioAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: phone,
        Channel: 'sms',
      }),
    },
  )

  if (!response.ok) {
    const payload = await parseJsonSafely(response)
    throw new Error(payload.message || 'Failed to send OTP')
  }
}

export async function verifyPhoneOtp(
  phone: string,
  code: string,
): Promise<boolean> {
  if (isMockTwilioMode()) {
    return code === '123456'
  }

  const response = await fetch(
    `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`,
    {
      method: 'POST',
      headers: {
        Authorization: twilioAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: phone,
        Code: code,
      }),
    },
  )

  const payload = await parseJsonSafely(response)
  if (!response.ok) {
    throw new Error(payload.message || 'Failed to verify OTP')
  }

  return payload.status === 'approved'
}
