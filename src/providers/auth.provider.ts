import { timingSafeEqual } from 'node:crypto'
import { env } from '../config/env'
import { HttpError } from '../utils/http-error'

type PhoneVerifyReason = 'code_invalid' | 'code_locked' | 'code_expired'
  | 'verify_limited' | 'send_limited' | 'phone_invalid' | 'verify_unavailable'

const PHONE_VERIFY_ERRORS: Record<PhoneVerifyReason, { status: number; message: string; retryAfter?: number }> = {
  code_invalid: { status: 400, message: "That code isn't right. Check it and try again." },
  code_locked: { status: 429, message: 'Too many tries. Send a new code.' },
  code_expired: { status: 410, message: 'That code has expired. Send a new code.' },
  verify_limited: { status: 429, message: 'Too many tries. Wait a few minutes, then send a new code.', retryAfter: 600 },
  send_limited: { status: 429, message: "You've asked for a lot of codes. Wait 10 minutes, then try again.", retryAfter: 600 },
  phone_invalid: { status: 400, message: "That number doesn't look right. Check it and try again." },
  verify_unavailable: { status: 503, message: "We couldn't send or check codes just now. Try again in a moment." },
}

/** Fixed player copy is shared by provider failures, wrong codes and local limits. */
export function phoneVerifyError(reason: PhoneVerifyReason, retryAfter?: number): HttpError {
  const error = PHONE_VERIFY_ERRORS[reason]
  const retry = retryAfter ?? error.retryAfter
  return new HttpError(error.status, error.message, {
    code: reason,
    ...(retry === undefined ? {} : { retryAfter: retry }),
  })
}

type VerifyEndpoint = 'send' | 'verify'

function twilioCode(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object' || !('code' in payload)) return null
  return typeof payload.code === 'number' && Number.isInteger(payload.code) ? payload.code : null
}

/** Provider messages are deliberately never used to classify or build a response. */
export function classifyTwilioError(endpoint: VerifyEndpoint, payload: unknown): HttpError {
  switch (twilioCode(payload)) {
    case 60200: return phoneVerifyError(endpoint === 'send' ? 'phone_invalid' : 'code_invalid')
    case 60202: return phoneVerifyError(endpoint === 'send' ? 'send_limited' : 'code_locked')
    case 20404: return phoneVerifyError(endpoint === 'send' ? 'phone_invalid' : 'code_expired')
    case 60203:
      if (endpoint === 'send') return phoneVerifyError('send_limited')
  }
  return phoneVerifyError('verify_unavailable')
}

/**
 * The one phone number Google Play's reviewers are allowed to sign in with.
 *
 * Play will not review an app it cannot get into, and it says so plainly:
 * reviewers cannot create accounts, cannot use their own, and cannot receive
 * our SMS. Everlore authenticates by phone OTP and Google sign-in, so without
 * this there is no credential we can hand them at all.
 *
 * This is deliberately a bypass, so it is fenced in hard:
 *
 *  - it is inert unless BOTH env vars are set, so no default build has it;
 *  - it matches exactly ONE number, compared after normalisation;
 *  - the code must be exactly six digits (the app's OTP field is six wide) and
 *    must not be one of the guessable ones — a weak code here is a permanent
 *    account, not a one-off;
 *  - the comparison is timing-safe, so the code cannot be recovered a digit at
 *    a time;
 *  - it never reaches Twilio in either direction, so we never send an SMS to a
 *    number we do not own;
 *  - it grants a plain free-tier account and nothing else. Rate limiting is
 *    upstream in middleware/rate-limit.ts and still applies.
 *
 * Rotate REVIEW_DEMO_OTP whenever you would rotate a password, and unset both
 * vars the day Everlore has a sign-in path a reviewer can use unaided.
 */
const TRIVIAL_CODES = new Set([
  '123456', '654321', '111111', '000000', '121212', '112233', '123123',
])

export interface ReviewAccessConfig {
  phone: string
  code: string
}

/** Digits only, with a single leading `+`, so `+1 202-555-0142` == `+12025550142`. */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return digits ? `+${digits}` : ''
}

/**
 * The configured reviewer credential, or null when the path is not armed.
 *
 * Pure and exported so the audit can exercise every rejection without fighting
 * the module cache that `env` lives behind.
 */
export function resolveReviewAccess(
  rawPhone: string | undefined,
  rawCode: string | undefined,
): ReviewAccessConfig | null {
  const phone = normalizePhone(rawPhone || '')
  const code = (rawCode || '').trim()
  if (!phone || !code) return null
  if (!/^\d{6}$/.test(code) || TRIVIAL_CODES.has(code)) return null
  return { phone, code }
}

function codesMatch(expected: string, supplied: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(supplied.trim(), 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Whether this phone/code pair is the armed reviewer credential. */
export function isReviewCredential(
  config: ReviewAccessConfig | null,
  phone: string,
  code: string,
): boolean {
  if (!config) return false
  if (normalizePhone(phone) !== config.phone) return false
  return codesMatch(config.code, code)
}

function reviewAccess(): ReviewAccessConfig | null {
  return resolveReviewAccess(env.REVIEW_DEMO_PHONE, env.REVIEW_DEMO_OTP)
}

/** True when this is the reviewer number and reviewer access is configured. */
function isReviewPhone(phone: string): boolean {
  const access = reviewAccess()
  return access !== null && normalizePhone(phone) === access.phone
}

function isMockTwilioMode(): boolean {
  return process.env.NODE_ENV !== 'production' && (
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

async function requestPhoneVerification(
  endpoint: VerifyEndpoint,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  let status: number | null = null
  let response: Response
  let payload: unknown
  try {
    const path = endpoint === 'send' ? 'Verifications' : 'VerificationCheck'
    response = await fetch(
      `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}/${path}`,
      {
        method: 'POST',
        headers: {
          Authorization: twilioAuthHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(params),
      },
    )
    status = response.status
    payload = await response.json()
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw phoneVerifyError('verify_unavailable')
    }
  } catch {
    console.warn('auth.phone_verify_failed', { endpoint, status, code: null })
    throw phoneVerifyError('verify_unavailable')
  }

  if (!response.ok) {
    console.warn('auth.phone_verify_failed', { endpoint, status, code: twilioCode(payload) })
    throw classifyTwilioError(endpoint, payload)
  }
  return payload as Record<string, unknown>
}

/*
 * verifyGoogleIdToken lived here. Google sign-in now arrives as a Firebase ID
 * token and is verified in providers/firebase-auth.provider.ts, against
 * Google's published keys rather than by asking the `tokeninfo` endpoint to
 * vouch for the string. Removed rather than left dormant so nothing can
 * accidentally authenticate against the old path.
 */

/**
 * The code mock mode will accept, or null when nothing is being mocked.
 *
 * This used to be returned from `/auth/otp/send` unconditionally as
 * `mockCode: '123456'` — a development convenience that shipped to production
 * and told every caller, truthfully or not, that a fixed code existed. It is
 * only ever non-null on a deployment that is genuinely mocking Twilio.
 */
export function mockOtpCode(phone: string): string | null {
  if (isReviewPhone(phone)) return null
  return isMockTwilioMode() ? '123456' : null
}

export async function sendPhoneOtp(phone: string): Promise<void> {
  // The reviewer's code is fixed and already in Play Console. Sending an SMS
  // to a number we do not own would be both useless and rude.
  if (isReviewPhone(phone)) return

  if (isMockTwilioMode()) return

  await requestPhoneVerification('send', { To: phone, Channel: 'sms' })
}

export async function verifyPhoneOtp(
  phone: string,
  code: string,
): Promise<boolean> {
  const review = reviewAccess()
  if (review && normalizePhone(phone) === review.phone) {
    return isReviewCredential(review, phone, code)
  }

  if (isMockTwilioMode()) {
    return code === '123456'
  }

  const payload = await requestPhoneVerification('verify', { To: phone, Code: code })
  return payload.status === 'approved'
}
