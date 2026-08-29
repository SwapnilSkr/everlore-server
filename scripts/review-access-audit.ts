/**
 * The Google Play reviewer sign-in path, which is a deliberate auth bypass and
 * therefore the one place in this codebase where a mistake hands somebody a
 * real account for free.
 *
 * Everything here is about the fence around it: that it stays inert unless
 * fully configured, that a weak code refuses to activate it, that it matches
 * exactly one number, and that no near-miss code is ever accepted.
 *
 *   bun run audit:review-access
 */
import { resolveReviewAccess, isReviewCredential } from '../src/providers/auth.provider'

const REAL_PHONE = '+12025550142'
const REAL_CODE = '804731'

type Case = {
  name: string
  env: { phone: string; otp: string }
  phone: string
  code: string
  expect: 'accept' | 'reject'
}

const cases: Case[] = [
  // The one thing it must do.
  { name: 'the configured reviewer number and code sign in', env: { phone: REAL_PHONE, otp: REAL_CODE }, phone: REAL_PHONE, code: REAL_CODE, expect: 'accept' },
  { name: 'the number is matched after normalisation', env: { phone: REAL_PHONE, otp: REAL_CODE }, phone: '+1 (202) 555-0142', code: REAL_CODE, expect: 'accept' },

  // Inert unless deliberately configured — a default deploy must not have it.
  { name: 'unset entirely: nothing is accepted', env: { phone: '', otp: '' }, phone: REAL_PHONE, code: REAL_CODE, expect: 'reject' },
  { name: 'phone set but code missing: inert', env: { phone: REAL_PHONE, otp: '' }, phone: REAL_PHONE, code: REAL_CODE, expect: 'reject' },
  { name: 'code set but phone missing: inert', env: { phone: '', otp: REAL_CODE }, phone: REAL_PHONE, code: REAL_CODE, expect: 'reject' },

  // A weak code must disable the path rather than weakly enable it.
  { name: 'a guessable code (123456) refuses to activate', env: { phone: REAL_PHONE, otp: '123456' }, phone: REAL_PHONE, code: '123456', expect: 'reject' },
  { name: 'a repeated-digit code refuses to activate', env: { phone: REAL_PHONE, otp: '000000' }, phone: REAL_PHONE, code: '000000', expect: 'reject' },
  { name: 'a short code refuses to activate', env: { phone: REAL_PHONE, otp: '4731' }, phone: REAL_PHONE, code: '4731', expect: 'reject' },
  { name: 'a non-numeric code refuses to activate', env: { phone: REAL_PHONE, otp: 'letmein' }, phone: REAL_PHONE, code: 'letmein', expect: 'reject' },

  // One number, one code. No neighbours.
  { name: 'a different number does not get the reviewer code', env: { phone: REAL_PHONE, otp: REAL_CODE }, phone: '+12025550143', code: REAL_CODE, expect: 'reject' },
  { name: 'the right number with the wrong code is refused', env: { phone: REAL_PHONE, otp: REAL_CODE }, phone: REAL_PHONE, code: '804732', expect: 'reject' },
  { name: 'a code prefix is refused (no length oracle)', env: { phone: REAL_PHONE, otp: REAL_CODE }, phone: REAL_PHONE, code: '8047', expect: 'reject' },
  { name: 'the mock-mode code does not work on the reviewer number', env: { phone: REAL_PHONE, otp: REAL_CODE }, phone: REAL_PHONE, code: '123456', expect: 'reject' },
]

let passed = 0
const failures: string[] = []

for (const testCase of cases) {
  const config = resolveReviewAccess(testCase.env.phone, testCase.env.otp)
  const approved = isReviewCredential(config, testCase.phone, testCase.code)
  const got = approved ? 'accept' : 'reject'
  if (got !== testCase.expect) {
    failures.push(`${testCase.name} — expected ${testCase.expect}, got ${got}`)
    continue
  }
  passed++
}

console.log(`review-access audit: ${passed}/${cases.length} passed`)
for (const failure of failures) console.error('  FAIL', failure)
process.exit(failures.length === 0 ? 0 : 1)
