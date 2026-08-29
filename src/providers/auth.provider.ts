import { env } from '../config/env'

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

/*
 * verifyGoogleIdToken lived here. Google sign-in now arrives as a Firebase ID
 * token and is verified in providers/firebase-auth.provider.ts, against
 * Google's published keys rather than by asking the `tokeninfo` endpoint to
 * vouch for the string. Removed rather than left dormant so nothing can
 * accidentally authenticate against the old path.
 */

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
