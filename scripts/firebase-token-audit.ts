/**
 * The full token path, signed for real.
 *
 * Complements audit:firebase-auth, which covers claim rules with plain
 * objects. This one generates an RSA keypair, signs actual Firebase-shaped ID
 * tokens with it, and runs them through verifyFirebaseIdToken — so signature,
 * issuer, audience and expiry are all genuinely exercised rather than assumed.
 *
 *   bun run audit:firebase-token
 */
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JSONWebKeySet } from 'jose'
import { verifyFirebaseIdToken } from '../src/providers/firebase-auth.provider'
import { env } from '../src/config/env'

const PROJECT = env.FIREBASE_PROJECT_ID
if (!PROJECT) {
  console.error('FIREBASE_PROJECT_ID is not set; this audit needs it to build issuer/audience.')
  process.exit(1)
}

const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwk = await exportJWK(publicKey)
jwk.kid = 'audit-key'
jwk.alg = 'RS256'
const goodKeys = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet)

// A second, unrelated keypair: tokens signed with this must never verify
// against the first, which is what "somebody else signed this" looks like.
const other = await generateKeyPair('RS256')

const claims = {
  email: 'player@example.com',
  email_verified: true,
  name: 'A Player',
  firebase: { sign_in_provider: 'google.com', identities: { 'google.com': ['109876543210987654321'] } },
}

async function mint(over: {
  iss?: string; aud?: string; exp?: string | number; key?: CryptoKey; body?: Record<string, unknown>
} = {}) {
  return new SignJWT({ ...claims, ...(over.body || {}) })
    .setProtectedHeader({ alg: 'RS256', kid: 'audit-key' })
    .setSubject('firebase-uid-abc')
    .setIssuer(over.iss ?? `https://securetoken.google.com/${PROJECT}`)
    .setAudience(over.aud ?? PROJECT)
    .setIssuedAt()
    .setExpirationTime(over.exp ?? '1h')
    .sign(over.key ?? privateKey)
}

const cases: { name: string; token: string; expect: 'accept' | 'reject' }[] = [
  { name: 'a correctly signed Google token verifies', token: await mint(), expect: 'accept' },
  { name: "another project's token is refused (wrong audience)", token: await mint({ aud: 'someone-elses-project' }), expect: 'reject' },
  { name: 'a token from the wrong issuer is refused', token: await mint({ iss: 'https://evil.example.com' }), expect: 'reject' },
  { name: 'an expired token is refused', token: await mint({ exp: Math.floor(Date.now() / 1000) - 60 }), expect: 'reject' },
  { name: 'a token signed by a different key is refused', token: await mint({ key: other.privateKey }), expect: 'reject' },
  { name: 'a tampered payload is refused', token: (await mint()).replace(/\.(.+)\./, (m, p) => `.${p.slice(0, -2)}XY.`), expect: 'reject' },
  { name: 'garbage is refused', token: 'not-a-jwt', expect: 'reject' },
  { name: 'an alg:none token is refused', token: `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'x', iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, ...claims })).toString('base64url')}.`, expect: 'reject' },
]

let passed = 0
const failures: string[] = []

for (const testCase of cases) {
  let outcome: 'accept' | 'reject' = 'reject'
  let subject = ''
  try {
    const profile = await verifyFirebaseIdToken(testCase.token, goodKeys)
    outcome = 'accept'
    subject = profile.googleSubject
  } catch { /* rejected */ }

  if (outcome !== testCase.expect) {
    failures.push(`${testCase.name} — expected ${testCase.expect}, got ${outcome}`)
  } else if (outcome === 'accept' && subject !== '109876543210987654321') {
    failures.push(`${testCase.name} — googleSubject came back as "${subject}"`)
  } else {
    passed++
  }
}

console.log(`firebase-token audit: ${passed}/${cases.length} passed`)
for (const failure of failures) console.error('  FAIL', failure)
process.exit(failures.length === 0 ? 0 : 1)
