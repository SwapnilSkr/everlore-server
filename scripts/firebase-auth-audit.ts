/**
 * What a Firebase ID token has to say before it can sign somebody in.
 *
 * `jwtVerify` handles signature, issuer, audience and expiry — that is jose's
 * job and it is well covered. This exercises the decisions written by hand in
 * firebase-auth.provider.ts, which are the ones that would silently let the
 * wrong person into an account.
 *
 *   bun run audit:firebase-auth
 */
import { profileFromFirebaseClaims, type FirebaseTokenPayload } from '../src/providers/firebase-auth.provider'
import { HttpError } from '../src/utils/http-error'

type Case = { name: string; payload: FirebaseTokenPayload; expect: 'accept' | 'reject' }

const googleToken = (over: Partial<FirebaseTokenPayload> = {}): FirebaseTokenPayload => ({
  sub: 'firebase-uid-abc',
  email: 'player@example.com',
  email_verified: true,
  name: 'A Player',
  firebase: { sign_in_provider: 'google.com', identities: { 'google.com': ['109876543210987654321'] } },
  ...over,
})

const cases: Case[] = [
  { name: 'a genuine Google sign-in is accepted', payload: googleToken(), expect: 'accept' },

  // The migration's whole premise: existing rows key on the Google subject, so
  // it has to survive the trip through Firebase intact.
  { name: 'the Google subject is preserved, not replaced by the Firebase uid', payload: googleToken(), expect: 'accept' },

  { name: 'an anonymous sign-in is refused', expect: 'reject',
    payload: googleToken({ firebase: { sign_in_provider: 'anonymous', identities: {} } }) },
  { name: 'a phone sign-in is refused on the Google endpoint', expect: 'reject',
    payload: googleToken({ firebase: { sign_in_provider: 'phone', identities: { phone: ['+15551234567'] } } }) },
  // The dangerous shape: provider claims google.com but carries no Google
  // identity, so there is no subject to key an account on.
  { name: 'a google.com provider with no Google identity is refused', expect: 'reject',
    payload: googleToken({ firebase: { sign_in_provider: 'google.com', identities: {} } }) },
  { name: 'a token with no firebase claim at all is refused', expect: 'reject',
    payload: googleToken({ firebase: undefined }) },
  { name: 'an unverified email is refused', expect: 'reject',
    payload: googleToken({ email_verified: false }) },
  { name: 'a missing email is refused', expect: 'reject', payload: googleToken({ email: undefined }) },
  { name: 'a missing subject is refused', expect: 'reject', payload: googleToken({ sub: undefined }) },
]

let passed = 0
const failures: string[] = []

for (const testCase of cases) {
  let outcome: 'accept' | 'reject'
  let profile: ReturnType<typeof profileFromFirebaseClaims> | null = null
  try {
    profile = profileFromFirebaseClaims(testCase.payload)
    outcome = 'accept'
  } catch (error) {
    outcome = error instanceof HttpError && error.statusCode === 401 ? 'reject' : 'accept'
    if (!(error instanceof HttpError)) failures.push(`${testCase.name} — threw a non-HttpError: ${error}`)
  }
  if (outcome !== testCase.expect) {
    failures.push(`${testCase.name} — expected ${testCase.expect}, got ${outcome}`)
    continue
  }
  if (testCase.name.includes('preserved') && profile) {
    if (profile.googleSubject !== '109876543210987654321') {
      failures.push(`${testCase.name} — googleSubject was "${profile.googleSubject}"`)
      continue
    }
    if (profile.firebaseUid === profile.googleSubject) {
      failures.push(`${testCase.name} — uid and Google subject collapsed into one value`)
      continue
    }
  }
  passed++
}

console.log(`firebase-auth audit: ${passed}/${cases.length} passed`)
for (const failure of failures) console.error('  FAIL', failure)
process.exit(failures.length === 0 ? 0 : 1)
