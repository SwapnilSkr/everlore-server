/** Offline contract checks through the real phone controller/service/provider. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { mock } from 'bun:test'
import { Elysia } from 'elysia'
import { HttpError } from '../src/utils/http-error'
import type { UserDoc, UserInsertDoc } from '../src/models/user.model'

if (process.argv.includes('--bites')) {
  const path = new URL('../src/providers/auth.provider.ts', import.meta.url)
  const original = readFileSync(path, 'utf8')
  const before = "case 60202: return phoneVerifyError(endpoint === 'send' ? 'send_limited' : 'code_locked')"
  const after = "case 60202: return phoneVerifyError(endpoint === 'send' ? 'send_limited' : 'code_invalid')"
  assert.equal(original.split(before).length, 2, 'one real mapping mutation target')
  try {
    writeFileSync(path, original.replace(before, after))
    const proc = Bun.spawn([process.execPath, '--no-env-file', 'run', import.meta.path], {
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ])
    console.log(`TAMPERED AUDIT (exit ${exit}):\n${stdout}${stderr}`)
    assert.notEqual(exit, 0, 'tampered mapping must fail')
    assert.ok((stdout + stderr).includes('verify 60202: status'), 'must fail the intended contract assertion')
  } finally {
    writeFileSync(path, original)
  }
  assert.equal(readFileSync(path, 'utf8'), original)
  console.log('BITE: 60202 mapping mutation rejected; provider restored byte for byte')
  process.exit(0)
}

// Set synthetic configuration before any import that loads config/env.
for (const key of ['JWT_SECRET', 'MONGODB_URI', 'REDIS_URL', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'PINECONE_API_KEY']) {
  process.env[key] = 'phone-audit-fake'
}
const mockMode = process.argv.includes('--mock')
process.env.TWILIO_ACCOUNT_SID = mockMode ? '' : 'AC_PHONE_AUDIT_FAKE'
process.env.TWILIO_AUTH_TOKEN = mockMode ? '' : 'phone-audit-fake'
process.env.TWILIO_VERIFY_SERVICE_SID = mockMode ? '' : 'VA_PHONE_AUDIT_FAKE'
process.env.REVIEW_DEMO_PHONE = ''
process.env.REVIEW_DEMO_OTP = ''
process.env.DISABLE_OTP_RATE_LIMIT = 'false'
process.env.FORGE_OPEN_TO_ALL_TIERS = 'false'

const phone = '+12025550142'
const enteredCode = '847293'
const originalFetch = globalThis.fetch
const originalWarn = console.warn
let fetchCalls = 0
let reply: () => Response | Promise<Response> = () => { throw new Error('Unexpected fetch') }
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  fetchCalls++
  assert.match(String(input), /^https:\/\/verify\.twilio\.com\/v2\/Services\/VA_PHONE_AUDIT_FAKE\/(Verifications|VerificationCheck)$/)
  assert.equal(init?.method, 'POST')
  const params = new URLSearchParams(String(init?.body))
  assert.equal(params.get('To'), phone)
  assert.equal(params.get('Code'), String(input).endsWith('VerificationCheck') ? enteredCode : null)
  assert.equal(params.get('Channel'), String(input).endsWith('Verifications') ? 'sms' : null)
  return reply()
}, { preconnect: () => {} })

try {
  const provider = await import('../src/providers/auth.provider')
  if (mockMode) {
    assert.equal(provider.mockOtpCode(phone), '123456')
    assert.equal(await provider.verifyPhoneOtp(phone, '123456'), true)
    assert.equal(await provider.verifyPhoneOtp(phone, '000000'), false)
    assert.equal(await provider.sendPhoneOtp(phone), undefined)
    assert.equal(fetchCalls, 0, 'mock mode never calls fetch')
    console.log('mock mode: 123456 accepted, wrong code refused, send skipped, mockCode preserved, zero fetches')
  } else {
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    const counts = new Map<string, number>()
    let retryAfter = 137
    mock.module('../src/config/redis', () => ({
      getRedisClient: () => ({
        incr: async (key: string) => { const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return n },
        expire: async () => 1,
        ttl: async () => retryAfter,
      }),
    }))
    let dbCalls = 0
    const user = {
      _id: 'phone-audit-user', phone, username: 'phone_audit', tier: 'free',
      providers: ['phone'], preferences: { theme: 'dark' }, token_balance: 15000,
    }
    type AuditUser = typeof user & { account_status?: UserDoc['account_status'] }
    let storedUser: AuditUser | null = user
    let inserts = 0
    let finds = 0
    let updates = 0
    let insertFailure: { error: unknown; winner: AuditUser | null } | null = null
    let updateError: unknown = null
    const writtenUpdates: { $set: Partial<UserDoc> }[] = []
    mock.module('../src/config/mongo', () => ({
      mongoColl: { users: () => ({
        findOne: async (query: unknown) => {
          dbCalls++
          finds++
          assert.deepEqual(query, { phone }, 'initial lookup and duplicate-key re-read use the same phone')
          return storedUser
        },
        insertOne: async (doc: UserInsertDoc) => {
          dbCalls++
          assert.equal(storedUser, null)
          inserts++
          if (insertFailure) {
            storedUser = insertFailure.winner
            throw insertFailure.error
          }
          storedUser = { ...doc, _id: user._id, phone }
          return { insertedId: user._id }
        },
        updateOne: async (query: unknown, update: { $set: Partial<UserDoc> }) => {
          dbCalls++
          updates++
          assert.ok(storedUser)
          assert.deepEqual(query, { _id: storedUser._id })
          writtenUpdates.push(update)
          if (updateError) throw updateError
          Object.assign(storedUser, update.$set)
          return { matchedCount: 1 }
        },
      }) },
    }))
    mock.module('../src/services/deletion.service', () => ({ deletionService: {} }))
    mock.module('../src/services/play-ws.service', () => ({ disconnectUserSockets: () => {} }))
    const { authController } = await import('../src/controllers/auth.controller')
    let jwtCalls = 0
    const jwt = { sign: async () => { jwtCalls++; return 'phone-audit-token' } }
    const app = new Elysia()
      .onError(({ error, set }) => {
        // The same HttpError branch as src/index.ts; other errors must fail the audit.
        if (error instanceof HttpError) {
          set.status = error.statusCode
          return { error: error.message, ...(error.details || {}) }
        }
        set.status = 500
        return { error: 'Internal server error' }
      })
      .post('/auth/otp/send', ({ body }) => authController.sendOtp({ body: body as { phone: string } }))
      .post('/auth/otp/verify', ({ body }) => authController.verifyOtp({ body: body as { phone: string; code: string }, jwt }))

    type Endpoint = 'send' | 'verify'
    type Expected = { status: number; code: string; error: string; retryAfter?: number }
    const invalid: Expected = { status: 400, code: 'code_invalid', error: "That code isn't right. Check it and try again." }
    const locked: Expected = { status: 429, code: 'code_locked', error: 'Too many tries. Send a new code.' }
    const expired: Expected = { status: 410, code: 'code_expired', error: 'That code has expired. Send a new code.' }
    const limited: Expected = { status: 429, code: 'send_limited', error: "You've asked for a lot of codes. Wait 10 minutes, then try again.", retryAfter: 600 }
    const badPhone: Expected = { status: 400, code: 'phone_invalid', error: "That number doesn't look right. Check it and try again." }
    const unavailable: Expected = { status: 503, code: 'verify_unavailable', error: "We couldn't send or check codes just now. Try again in a moment." }
    const localVerify: Expected = { status: 429, code: 'verify_limited', error: 'Too many tries. Wait a few minutes, then send a new code.', retryAfter: 137 }
    let passed = 0
    const request = (endpoint: Endpoint) => app.handle(new Request(`http://localhost/auth/otp/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: ` ${phone} `, ...(endpoint === 'verify' ? { code: ` ${enteredCode} ` } : {}) }),
    }))
    async function checkFailure(name: string, endpoint: Endpoint, expected: Expected, sentinel: string, providerCode: number | null, providerStatus: number | null, local = false) {
      const before = { fetch: fetchCalls, db: dbCalls, jwt: jwtCalls, logs: warnings.length }
      const response = await request(endpoint)
      const body = await response.json()
      assert.equal(response.status, expected.status, `${name}: status`)
      const { status: _status, ...expectedBody } = expected
      assert.deepEqual(body, expectedBody, `${name}: exact body (code/copy/retryAfter)`)
      assert.ok(!JSON.stringify(body).includes(sentinel), `${name}: provider text excluded`)
      assert.equal(dbCalls, before.db, `${name}: no database access`)
      assert.equal(jwtCalls, before.jwt, `${name}: no token signed`)
      assert.equal(fetchCalls - before.fetch, local ? 0 : 1, `${name}: fetch count`)
      if (!local && providerStatus !== 200) {
        assert.deepEqual(warnings.slice(before.logs), [[
          'auth.phone_verify_failed', { endpoint, status: providerStatus, code: providerCode },
        ]], `${name}: safe provider diagnostics`)
      }
      const logs = JSON.stringify(warnings.slice(before.logs))
      for (const privateText of [phone, enteredCode, sentinel]) assert.ok(!logs.includes(privateText), `${name}: private text excluded from logs`)
      counts.clear()
      passed++
    }

    for (const [endpoint, code, expected] of [
      ['verify', 60200, invalid], ['verify', 60202, locked], ['verify', 20404, expired],
      ['send', 60200, badPhone], ['send', 60203, limited], ['send', 60202, limited], ['send', 20404, badPhone],
    ] as const) {
      const sentinel = `PROVIDER_PRIVATE_${endpoint}_${code}_not found_Too many_limit`
      const payload = { code, message: sentinel }
      reply = () => Response.json(payload, { status: 400 })
      await checkFailure(`${endpoint} ${code}`, endpoint, expected, sentinel, code, 400)
      const mapped = provider.classifyTwilioError(endpoint, payload)
      assert.ok(mapped instanceof HttpError)
      assert.deepEqual({ status: mapped.statusCode, error: mapped.message, ...mapped.details }, expected, `${endpoint} ${code}: pure mapping`)
    }
    reply = () => Response.json({ status: 'pending', message: 'PROVIDER_PRIVATE_pending' })
    await checkFailure('wrong code pending', 'verify', invalid, 'PROVIDER_PRIVATE_pending', null, 200)

    for (const endpoint of ['send', 'verify'] as const) {
      const sentinel = `PROVIDER_PRIVATE_${endpoint}_unknown_not found_Too many_limit`
      for (const status of [404, 429, 500]) {
        reply = () => Response.json({ code: 99999, message: sentinel }, { status })
        await checkFailure(`${endpoint} unknown ${status}`, endpoint, unavailable, sentinel, 99999, status)
      }
      reply = () => Response.json({ code: '60202', message: sentinel }, { status: 400 })
      await checkFailure(`${endpoint} nonnumeric code`, endpoint, unavailable, sentinel, null, 400)
      for (const status of [200, 502]) {
        reply = () => new Response(`<html>${sentinel}</html>`, { status })
        await checkFailure(`${endpoint} non-JSON ${status}`, endpoint, unavailable, sentinel, null, status)
      }
      for (const payload of [null, [], sentinel]) {
        reply = () => Response.json(payload, { status: 502 })
        await checkFailure(`${endpoint} malformed JSON ${JSON.stringify(payload)}`, endpoint, unavailable, sentinel, null, 502)
      }
      reply = () => { throw new Error(sentinel) }
      await checkFailure(`${endpoint} fetch throws`, endpoint, unavailable, sentinel, null, null)
    }

    for (const [endpoint, limit, expected] of [['send', 5, { ...limited, retryAfter: 137 }], ['verify', 10, localVerify]] as const) {
      for (const ttl of [137, -1]) {
        retryAfter = ttl
        counts.set(`rl:otp_${endpoint}:${phone}`, limit)
        await checkFailure(`${endpoint} local limit ttl ${ttl}`, endpoint, { ...expected, retryAfter: ttl > 0 ? ttl : 600 }, 'PROVIDER_PRIVATE_no_call', null, null, true)
      }
    }

    reply = () => Response.json({ status: 'pending' }, { status: 201 })
    const send = await request('send')
    assert.equal(send.status, 200)
    assert.deepEqual(await send.json(), { success: true }, 'live send success has no mockCode')
    assert.equal(provider.mockOtpCode(phone), null)
    passed++
    reply = () => Response.json({ status: 'approved' })
    const verify = await request('verify')
    assert.equal(verify.status, 200)
    assert.deepEqual(await verify.json(), {
      token: 'phone-audit-token', user: {
        id: user._id, email: '', phone, username: user.username, tier: user.tier,
        guest: false, can_forge: false, preferences: user.preferences, token_balance: user.token_balance,
      },
    }, 'approved success with explicit real-account guest flag')
    assert.equal(jwtCalls, 1)
    assert.equal(dbCalls, 2)
    passed++

    storedUser = null
    counts.clear()
    const first = await request('verify')
    assert.equal(first.status, 200)
    const firstBody = await first.json()
    assert.equal(firstBody.new_account, true, 'first phone sign-in: new_account true')
    assert.deepEqual(Object.keys(firstBody).sort(), ['new_account', 'token', 'user'])
    assert.equal(firstBody.token, 'phone-audit-token')
    assert.deepEqual(firstBody.user, {
      id: user._id, email: '', phone, username: storedUser!.username, tier: 'free',
      guest: false, can_forge: false, preferences: storedUser!.preferences, token_balance: 15000,
    })
    const second = await request('verify')
    assert.equal(second.status, 200)
    const secondBody = await second.json()
    assert.equal(Object.hasOwn(secondBody, 'new_account'), false, 'second phone sign-in: new_account omitted')
    assert.deepEqual(secondBody, { token: firstBody.token, user: firstBody.user }, 'returning phone sign-in: other fields unchanged')
    assert.equal(inserts, 1)
    assert.equal(jwtCalls, 3)
    assert.equal(dbCalls, 6)
    passed++
    console.log('PASS first phone sign-in returns new_account: true; second omits it')

    const winner: AuditUser = { ...user, username: 'phone_race_winner', providers: ['password'], token_balance: 7321 }
    function race(error: unknown, row: AuditUser | null) {
      storedUser = null
      finds = inserts = updates = 0
      counts.clear()
      writtenUpdates.length = 0
      updateError = null
      insertFailure = { error, winner: row ? { ...row } : null }
    }
    const verifyDirect = () => authController.verifyOtp({ body: { phone, code: enteredCode }, jwt })
    race({ code: 11000 }, winner)
    const raced = await request('verify')
    assert.equal(raced.status, 200, 'phone race: succeeds')
    const racedBody = await raced.json()
    assert.equal(Object.hasOwn(racedBody, 'new_account'), false, 'phone race: new_account omitted')
    assert.deepEqual(racedBody, { token: 'phone-audit-token', user: {
      id: winner._id, email: '', phone, username: winner.username, tier: winner.tier,
      guest: false, can_forge: false, preferences: winner.preferences, token_balance: winner.token_balance,
    } }, 'phone race: winner returned')
    const [racedUpdate] = writtenUpdates
    assert.deepEqual(racedUpdate, { $set: {
      phone, providers: ['password', 'phone'], updated_at: racedUpdate?.$set.updated_at,
    } }, 'phone race: exact returning-user update')
    assert.ok(racedUpdate?.$set.updated_at instanceof Date, 'phone race: updated_at refreshed')
    assert.deepEqual([finds, inserts, updates], [2, 1, 1], 'phone race: one re-read, no second insert')
    passed++
    console.log('PASS phone duplicate-key race returns winner, omits new_account and applies returning-user updates')

    race({ code: 11000 }, { ...winner, account_status: 'banned' })
    await assert.rejects(verifyDirect, (error: unknown) => error instanceof HttpError && error.statusCode === 403 && error.message === 'This account is banned', 'phone banned race: must reject')
    assert.deepEqual([finds, inserts, updates], [2, 1, 0], 'phone banned race: no update')
    passed++
    console.log('PASS phone duplicate-key race still refuses a banned winner')

    race({ code: 11000 }, winner)
    const updateFailure = { code: 11000, source: 'update' }
    updateError = updateFailure
    await assert.rejects(verifyDirect, (caught: unknown) => caught === updateFailure, 'phone update error: original error propagates')
    assert.deepEqual([finds, inserts, updates], [2, 1, 1], 'phone race: update error not retried')
    passed++
    console.log('PASS phone race preserves returning-user update errors')

    const unrelated = { code: 11000 }
    race(unrelated, null)
    await assert.rejects(verifyDirect, (caught: unknown) => caught === unrelated, 'phone unrelated conflict: original error propagates')
    assert.deepEqual([finds, inserts, updates], [2, 1, 0], 'phone unrelated conflict: one re-read')
    passed++
    console.log('PASS phone unrelated duplicate-key conflict rethrows the original error')

    for (const error of [{ code: 91 }, { code: '11000' }, new Error('insert failed'), null, 'insert failed']) {
      race(error, winner)
      await assert.rejects(verifyDirect, (caught: unknown) => caught === error, 'phone non-11000 insert: original error propagates')
      assert.deepEqual([finds, inserts, updates], [1, 1, 0], 'phone non-11000 insert: no re-read')
    }
    passed++
    console.log('PASS phone non-11000 insert errors propagate unchanged without a re-read')

    const proc = Bun.spawn([process.execPath, '--no-env-file', 'run', import.meta.path, '--mock'], {
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ])
    assert.equal(exit, 0, `mock subprocess: ${stdout}${stderr}`)
    assert.ok(stdout.includes('mock mode: 123456 accepted'))
    passed++
    console.log(`phone-verify-errors audit: ${passed}/${passed} passed (real handlers, fake fetch/Redis/Mongo; mock subprocess; no network)`)
  }
} finally {
  globalThis.fetch = originalFetch
  console.warn = originalWarn
}
