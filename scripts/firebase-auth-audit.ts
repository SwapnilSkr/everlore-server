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
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'
import type { FirebaseTokenPayload } from '../src/providers/firebase-auth.provider'
import type { UserDoc, UserInsertDoc } from '../src/models/user.model'
import { HttpError } from '../src/utils/http-error'

mock.module('../src/config/env', () => ({ env: { FORGE_OPEN_TO_ALL_TIERS: false } }))
const { profileFromFirebaseClaims } = await import('../src/providers/firebase-auth.provider')

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
let total = cases.length + 1
const failures: string[] = []

async function check(name: string, run: () => Promise<void>) {
  total++
  try {
    await run()
    passed++
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push(`${name} — ${error}`)
  }
}

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

try {
  let stored: UserDoc | null = null
  let inserts = 0
  let updates = 0
  let finds = 0
  let expectedQuery: unknown = { $or: [{ google_sub: '109876543210987654321' }, { email: 'player@example.com' }] }
  let insertFailure: { error: unknown; winner: UserDoc | null } | null = null
  let updateError: unknown = null
  let lastUpdate: { $set: Partial<UserDoc> } | null = null
  mock.module('../src/config/mongo', () => ({
    mongoColl: { users: () => ({
      findOne: async (query: unknown) => {
        finds++
        assert.deepEqual(query, expectedQuery, 'initial lookup and duplicate-key re-read use the same identity')
        return stored
      },
      insertOne: async (doc: UserInsertDoc) => {
        assert.equal(stored, null)
        inserts++
        if (insertFailure) {
          stored = insertFailure.winner
          throw insertFailure.error
        }
        const insertedId = new ObjectId('64b7f0c2a1b2c3d4e5f60718')
        stored = { ...doc, _id: insertedId } as UserDoc
        return { insertedId }
      },
      updateOne: async (query: unknown, update: { $set: Partial<UserDoc> }) => {
        assert.ok(stored)
        assert.deepEqual(query, { _id: stored._id })
        updates++
        lastUpdate = update
        if (updateError) throw updateError
        Object.assign(stored, update.$set)
        return { matchedCount: 1 }
      },
    }) },
  }))
  mock.module('../src/providers/firebase-auth.provider', () => ({
    profileFromFirebaseClaims,
    verifyFirebaseIdToken: async (token: string) => {
      assert.equal(token, 'firebase-audit-token')
      return profileFromFirebaseClaims(googleToken())
    },
  }))
  mock.module('../src/services/deletion.service', () => ({ deletionService: {} }))
  mock.module('../src/services/play-ws.service', () => ({ disconnectUserSockets: () => {} }))
  const { authController } = await import('../src/controllers/auth.controller')
  const { authService } = await import('../src/services/auth.service')
  let jwtCalls = 0
  const jwt = { sign: async (payload: { id: string; email: string; username: string; tier: string }) => {
    jwtCalls++
    assert.deepEqual(payload, { id: '64b7f0c2a1b2c3d4e5f60718', email: 'player@example.com', username: stored!.username, tier: 'free' })
    return 'firebase-audit-jwt'
  } }
  const first = await authController.google({ body: { id_token: 'firebase-audit-token' }, jwt })
  assert.equal(first.new_account, true, 'first Google sign-in: new_account true')
  assert.deepEqual(Object.keys(first).sort(), ['new_account', 'token', 'user'])
  assert.equal(first.token, 'firebase-audit-jwt')
  assert.deepEqual(first.user, {
    id: '64b7f0c2a1b2c3d4e5f60718', email: 'player@example.com', phone: null,
    username: stored!.username, tier: 'free', guest: false, can_forge: false,
    preferences: stored!.preferences, token_balance: 15000,
  })
  const second = await authController.google({ body: { id_token: 'firebase-audit-token' }, jwt })
  assert.equal(Object.hasOwn(second, 'new_account'), false, 'second Google sign-in: new_account omitted')
  assert.deepEqual(second, { token: first.token, user: first.user }, 'returning Google sign-in: other fields unchanged')
  assert.equal(inserts, 1)
  assert.equal(updates, 1)
  assert.equal(jwtCalls, 2)
  passed++
  console.log('PASS first Google sign-in returns new_account: true; second omits it (real service/controller, fake identity/Mongo/JWT)')

  const winner: UserDoc = { ...stored!, username: 'race_winner', providers: ['password'], token_balance: 7321 }
  function race(error: unknown, row: UserDoc | null) {
    stored = null
    finds = inserts = updates = 0
    lastUpdate = null
    updateError = null
    insertFailure = { error, winner: row ? { ...row } : null }
  }
  const google = () => authController.google({ body: { id_token: 'firebase-audit-token' }, jwt })
  await check('Google duplicate-key race returns winner, omits new_account and applies returning-user updates', async () => {
    race({ code: 11000 }, winner)
    const response = await google()
    assert.equal(Object.hasOwn(response, 'new_account'), false, 'Google race: new_account omitted')
    const merged = { ...winner, providers: ['password', 'google'] }
    assert.deepEqual(response, { token: 'firebase-audit-jwt', user: authService.serializeUser(merged) }, 'Google race: winner returned')
    assert.deepEqual(lastUpdate, { $set: {
      email: winner.email, google_sub: '109876543210987654321', firebase_uid: 'firebase-uid-abc',
      providers: ['password', 'google'], updated_at: lastUpdate?.$set.updated_at,
    } }, 'Google race: exact returning-user update')
    assert.ok(lastUpdate?.$set.updated_at instanceof Date, 'Google race: updated_at refreshed')
    assert.deepEqual([finds, inserts, updates], [2, 1, 1], 'Google race: one re-read, no second insert')
  })
  await check('Google duplicate-key race still refuses a banned winner', async () => {
    race({ code: 11000 }, { ...winner, account_status: 'banned' })
    await assert.rejects(google, (error: unknown) => error instanceof HttpError && error.statusCode === 403 && error.message === 'This account is banned')
    assert.deepEqual([finds, inserts, updates], [2, 1, 0])
  })
  await check('Google race preserves returning-user update errors', async () => {
    race({ code: 11000 }, winner)
    const error = { code: 11000, source: 'update' }
    updateError = error
    await assert.rejects(google, (caught: unknown) => caught === error)
    assert.deepEqual([finds, inserts, updates], [2, 1, 1])
  })
  await check('Google unrelated duplicate-key conflict rethrows the original error', async () => {
    const error = { code: 11000 }
    race(error, null)
    await assert.rejects(google, (caught: unknown) => caught === error)
    assert.deepEqual([finds, inserts, updates], [2, 1, 0])
  })
  await check('Google non-11000 insert errors propagate unchanged without a re-read', async () => {
    for (const error of [{ code: 91 }, { code: '11000' }, new Error('insert failed'), null, 'insert failed']) {
      race(error, winner)
      await assert.rejects(google, (caught: unknown) => caught === error)
      assert.deepEqual([finds, inserts, updates], [1, 1, 0])
    }
  })

  const registration = { email: 'registration@example.com', username: 'registration_audit', password: 'audit-only-password' }
  expectedQuery = { $or: [{ email: registration.email }, { username: registration.username }] }
  for (const [name, row, message] of [
    ['email', { ...winner, email: registration.email }, 'Email already registered'],
    ['username', { ...winner, username: registration.username }, 'Username taken'],
  ] as const) {
    await check(`password registration ${name} race returns the existing 409`, async () => {
      race({ code: 11000 }, row)
      await assert.rejects(() => authService.registerWithPassword(registration), (error: unknown) =>
        error instanceof HttpError && error.statusCode === 409 && error.message === message)
      assert.deepEqual([finds, inserts, updates], [2, 1, 0])
    })
  }
  await check('password registration unrelated duplicate rethrows the original error', async () => {
    const error = { code: 11000 }
    race(error, null)
    await assert.rejects(() => authService.registerWithPassword(registration), (caught: unknown) => caught === error)
    assert.deepEqual([finds, inserts, updates], [2, 1, 0])
  })
  await check('password registration non-11000 errors propagate unchanged without a re-read', async () => {
    for (const error of [{ code: 91 }, { code: '11000' }, new Error('insert failed'), null, 'insert failed']) {
      race(error, winner)
      await assert.rejects(() => authService.registerWithPassword(registration), (caught: unknown) => caught === error)
      assert.deepEqual([finds, inserts, updates], [1, 1, 0])
    }
  })
} catch (error) {
  failures.push(`Google new-account response — ${error}`)
}

console.log(`firebase-auth audit: ${passed}/${total} passed`)
for (const failure of failures) console.error('  FAIL', failure)
process.exit(failures.length === 0 ? 0 : 1)
