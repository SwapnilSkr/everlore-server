/** FR-5 integration audit. Own loopback Mongo + Redis, synthetic credentials,
 * mocked external transports. Never loads an env file or uses a remote DB. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'
import { MongoClient, MongoServerError, ObjectId, Collection, type Document } from 'mongodb'
import { Elysia } from 'elysia'

const standalone = process.argv.includes('--standalone')
const root = new URL('..', import.meta.url).pathname
const scratch = mkdtempSync(join(tmpdir(), 'everlore-guest-audit-'))
const freePort = () => { const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); const port = server.port; server.stop(true); return port }
const mongoPort = freePort(), redisPort = freePort()
const mongoUri = `mongodb://127.0.0.1:${mongoPort}/guest_audit?directConnection=true`
Object.assign(process.env, {
  JWT_SECRET: 'guest-audit-synthetic-session-key-32chars', MONGODB_URI: mongoUri,
  REDIS_URL: `redis://127.0.0.1:${redisPort}`, OPENAI_API_KEY: 'audit-unused',
  OPENROUTER_API_KEY: 'audit-unused', PINECONE_API_KEY: 'audit-unused',
  NODE_ENV: 'test', BILLING_ENFORCE: 'false', MEDIA_ENABLED: 'true',
})
mkdirSync(join(scratch, 'db'))
const mongod = Bun.spawn(['mongod', '--bind_ip', '127.0.0.1', '--port', String(mongoPort), '--dbpath', join(scratch, 'db'),
  '--logpath', join(scratch, 'mongo.log'), ...(standalone ? [] : ['--replSet', 'audit'])], { stdout: 'ignore', stderr: 'pipe' })
const redisProcess = Bun.spawn(['redis-server', '--bind', '127.0.0.1', '--port', String(redisPort), '--save', '', '--appendonly', 'no', '--dir', scratch], { stdout: 'ignore', stderr: 'pipe' })
const adminClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 300 })
let cleanupConnections: (() => Promise<unknown>) | undefined
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(work: () => Promise<unknown>) {
  for (let i = 0; ; i++) { try { return await work() } catch (error) { if (i >= 100) throw error; await wait(100) } }
}
let passed = 0
async function check(name: string, work: () => Promise<void> | void) { await work(); passed++; console.log(`PASS ${name}`) }

const vectorDeletes: unknown[] = [], objectDeletes: string[] = [], cacheDeletes: string[] = []
// Queue effects are isolated; no worker is started and no external API runs.
type FakeJob = { data: Record<string, unknown>; state: string; updateData(data: unknown): Promise<void> }
const jobs: FakeJob[] = []
let rejectEnqueue = false
const queue = {
  async add(_name: string, data: Record<string, unknown>) {
    if (rejectEnqueue) throw new Error('audit enqueue failure')
    jobs.push({ data, state: 'waiting', async updateData(value) { this.data = value as Record<string, unknown> } })
    return { id: String(jobs.length) }
  },
  async getJobs(states: string[]) {
    assert.ok(!states.some(state => ['completed', 'failed'].includes(state)), 'merge scanned terminal job history')
    return jobs.filter(job => states.includes(job.state))
  },
}
const retention = { removeOnComplete: {}, removeOnFail: {} }
mock.module(join(root, 'src/queues/index.ts'), () => ({
  getGenerationQueue: () => queue, getMediaQueue: () => queue, getMemoryCurationQueue: () => queue,
  getSceneSummaryQueue: () => queue, getMaintenanceQueue: () => queue,
  QUEUE_RETENTION: { generation: retention, media: retention, maintenance: retention, memoryCuration: retention, sceneSummary: retention },
  removeQueuedJobsForInstance: async () => {},
}))
mock.module(join(root, 'src/services/vector-store.ts'), () => ({ vectorStore: {
  async deleteScope(scope: unknown) { vectorDeletes.push(scope) },
} }))
mock.module(join(root, 'src/services/storage.service.ts'), () => ({ storageService: {
  keyFromUrl: () => null,
  async upload() { throw new Error('audit forbids upload') }, urlForKey: (key: string) => key,
  async delete(key: string) { objectDeletes.push(key) }, async deleteStrict(key: string) { objectDeletes.push(key) },
} }))
mock.module(join(root, 'src/providers/firebase-auth.provider.ts'), () => ({
  async verifyFirebaseIdToken(token: string) {
    if (!token.startsWith('google:')) throw new Error('audit invalid credential')
    const email = token.slice(7)
    return { email, googleSubject: email, firebaseUid: email, name: 'Audit' }
  },
}))
mock.module(join(root, 'src/providers/auth.provider.ts'), () => ({
  async verifyPhoneOtp(_phone: string, code: string) { return code === '123456' },
  async sendPhoneOtp() {}, mockOtpCode: () => null,
  phoneVerifyError: () => new Error('audit invalid phone code'),
}))

let replayModel = ''
const replayBoundary = new Error('audit stopped at replay model boundary')
mock.module(join(root, 'src/providers/rag.provider.ts'), () => ({
  async queryRag() { return { loreTexts: [], memoryTexts: [], openThreads: [], retrievedMemoryMongoIds: [], retrievedEntityIds: [] } },
}))

try {
  await until(() => adminClient.connect())
  if (!standalone) {
    await adminClient.db('admin').command({ replSetInitiate: { _id: 'audit', members: [{ _id: 0, host: `127.0.0.1:${mongoPort}` }] } })
    await until(async () => { const hello = await adminClient.db('admin').command({ hello: 1 }); assert.equal(hello.isWritablePrimary, true) })
  }
  const mongo = await import('../src/config/mongo')
  const db = await mongo.connectMongo()
  assert.equal(new URL(mongoUri).hostname, '127.0.0.1')
  const redis = await import('../src/config/redis')
  await redis.connectRedis()
  const redisClient = redis.getRedisClient()
  cleanupConnections = async () => { await Promise.all([redisClient.quit(), redis.getRedisSubscriber().quit(), redis.getQueueRedisClient().quit()]); await db.client.close() }
  const originalDel = redisClient.del.bind(redisClient)
  redisClient.del = (async (...keys: string[]) => { cacheDeletes.push(...keys); return originalDel(...keys) }) as typeof redisClient.del
  const aiClient = await import('../src/ai/client')
  mock.module(join(root, 'src/ai/client.ts'), () => ({ ...aiClient,
    async callLLMWithFallback(params: { model: string }) { replayModel = params.model; throw replayBoundary },
  }))
  const { authService } = await import('../src/services/auth.service')
  const { authRoutes } = await import('../src/routes/auth.routes')
  const { chronicleRoutes } = await import('../src/routes/chronicle.routes')
  const { mediaRoutes } = await import('../src/routes/media.routes')
  const { guestService } = await import('../src/services/guest.service')
  const policy = await import('../src/services/guest-policy')
  const { HttpError } = await import('../src/utils/http-error')
  const { generationService } = await import('../src/services/generation.service')
  const { instanceService } = await import('../src/services/instance.service')
  const { billingService } = await import('../src/services/billing.service')
  const { templateController } = await import('../src/controllers/template.controller')
  const { requestVoice } = await import('../src/services/media/service')
  const visual = await import('../src/services/media/visual')
  const { expireGuests } = await import('../src/services/guest-expiry.service')
  const { toClientError } = await import('../src/utils/ws-error')
  const { playWsService } = await import('../src/services/play-ws.service')
  const { beginGuestRequest, endGuestRequest, closeGuestRequests, reopenGuestRequests } = await import('../src/services/guest-requests')
  const app = new Elysia().onError(({ error, set }) => {
    if (error instanceof HttpError) { set.status = error.statusCode; return { error: error.message, ...error.details } }
  }).use(authRoutes).use(chronicleRoutes).use(mediaRoutes)
  async function post(path: string, body: unknown, token?: string) {
    const response = await app.handle(new Request(`http://localhost/auth/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
    }))
    return { status: response.status, body: await response.json() as Record<string, any> } // Wire JSON under test is intentionally dynamic.
  }
  const users = db.collection('users')
  const id = () => new ObjectId()
  const newGuest = () => guestService.create(crypto.randomUUID())
  const required = (error: unknown) => error instanceof HttpError && error.statusCode === 403 && error.details?.code === 'sign_in_required'
  let guestToken = '', guestId = ''
  await check('POST /auth/guest: defaults, no null identity keys, install binding, session reuse, validation', async () => {
    const install = crypto.randomUUID()
    const first = await post('guest', { install_id: install })
    assert.equal(first.status, 200); assert.equal(first.body.user.guest, true)
    assert.equal(Object.hasOwn(first.body.user, 'age_confirmed_at'), false)
    guestToken = first.body.token; guestId = first.body.user.id
    const doc = await users.findOne({ _id: new ObjectId(guestId) })
    for (const key of ['email', 'phone', 'google_sub', 'age_confirmed_at']) assert.equal(Object.hasOwn(doc!, key), false)
    assert.ok(doc!.guest_started_at instanceof Date, 'guest start timestamp missing')
    assert.equal(doc!.guest_started_at.getTime(), doc!.created_at.getTime(), 'guest start differs from creation')
    assert.equal(Object.hasOwn(doc!, 'signed_up_at'), false, 'unsigned guest has sign-up timestamp')
    assert.equal(doc!.install_id, install); assert.equal(doc!.preferences.nsfw_enabled, false)
    await wait(1050) // Cross an issued-at second: session reuse must return the original token.
    const again = await post('guest', { install_id: install }, guestToken)
    assert.equal(again.status, 200); assert.equal(again.body.user.id, guestId); assert.equal(again.body.token, guestToken)
    const reused = await guestService.create(install, guestId)
    assert.equal(reused.guest_started_at?.getTime(), doc!.guest_started_at.getTime(), 'reuse moved guest start')
    assert.equal((await post('guest', { install_id: install })).status, 409)
    assert.equal((await post('guest', { install_id: 'invalid' })).status, 422)
    await newGuest() // real sparse indexes admit a second guest
  })
  await check('direct Google, phone and password accounts record sign-up exactly at creation', async () => {
    const accounts = [
      (await authService.signInWithGoogle('google:funnel-direct@example.test')).userDoc,
      (await authService.signInWithPhoneOtp('+15555550999', '123456')).userDoc,
      await authService.registerWithPassword({ email: 'funnel-password@example.test', username: 'funnel-password', password: 'audit-only-password' }),
    ]
    for (const account of accounts) {
      assert.equal(account.signed_up_at?.getTime(), account.created_at.getTime(), 'direct sign-up timestamp differs from creation')
      assert.equal(Object.hasOwn(account, 'guest_started_at'), false, 'direct account has a guest start')
    }
  })
  await check('rate limits bite separately for install and IP', async () => {
    const { guestClientAddress } = await import('../src/utils/guest-client-address')
    assert.equal(guestClientAddress('198.51.100.10', '203.0.113.1'), '198.51.100.10')
    assert.equal(guestClientAddress('127.0.0.1', 'spoofed, 203.0.113.20'), '203.0.113.20')
    assert.equal(guestClientAddress('127.0.0.1', 'invalid'), '127.0.0.1')
    const { authController } = await import('../src/controllers/auth.controller')
    const jwt = { sign: async () => 'test' }
    const install = crypto.randomUUID()
    for (let i = 0; i < 10; i++) {
      try { await authController.guest({ body: { install_id: install }, jwt, address: `install-test-${i}` }) } catch (error) { assert.equal((error as HttpError).statusCode, 409) }
    }
    await assert.rejects(authController.guest({ body: { install_id: install }, jwt, address: 'new-address' }), (error: unknown) => error instanceof HttpError && error.statusCode === 429)
    for (let i = 0; i < 20; i++) await authController.guest({ body: { install_id: crypto.randomUUID() }, jwt, address: 'ip-test' })
    await assert.rejects(authController.guest({ body: { install_id: crypto.randomUUID() }, jwt, address: 'ip-test' }), (error: unknown) => error instanceof HttpError && error.statusCode === 429)
  })
  async function preferences(token: string, body: unknown) {
    const response = await app.handle(new Request('http://localhost/auth/preferences', {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
    return { status: response.status, body: await response.json() as Document }
  }
  async function me(token: string) {
    const response = await app.handle(new Request('http://localhost/auth/me', { headers: { authorization: `Bearer ${token}` } }))
    assert.equal(response.status, 200)
    return await response.json() as Document
  }
  let guestAge = ''
  await check('age gate: signed-in and guest HTTP 400 without confirmation; off always works; same-request confirmation sets an ISO timestamp once', async () => {
    const signedIn = await post('google', { id_token: 'google:age-gate@example.test' })
    for (const token of [signedIn.body.token, guestToken]) {
      const before = await me(token)
      assert.equal(Object.hasOwn(before, 'age_confirmed_at'), false, 'unset age must be omitted from JSON')
      assert.equal((await preferences(token, { nsfw_enabled: false, age_confirmed: false })).status, 200)
      for (const body of [{ nsfw_enabled: true }, { nsfw_enabled: true, age_confirmed: false }]) {
        const rejected = await preferences(token, body)
        assert.equal(rejected.status, 400, 'age gate must refuse on without confirmation')
        assert.deepEqual(rejected.body, { error: "Please confirm you're 18 or older to allow mature themes.", code: 'age_confirmation_required' })
      }
      assert.equal(Object.hasOwn(await users.findOne({ _id: new ObjectId(before.id) }), 'age_confirmed_at'), false)
      assert.equal((await preferences(token, { age_confirmed: 'true' })).status, 422)
      assert.equal((await preferences(token, { nsfw_enabled: true, age_confirmed: true })).status, 200)
      const confirmed = await me(token)
      assert.equal(confirmed.preferences.nsfw_enabled, true, 'guest mature must follow its own setting')
      const saved = await users.findOne({ _id: new ObjectId(before.id) })
      assert.ok(saved!.age_confirmed_at instanceof Date)
      assert.equal(confirmed.age_confirmed_at, saved!.age_confirmed_at.toISOString(), 'age timestamp must serialize as ISO')
      assert.equal(Object.hasOwn(saved!.preferences, 'age_confirmed'), false)
      await wait(10)
      await Promise.all(Array.from({ length: 3 }, () => preferences(token, { age_confirmed: true })))
      assert.equal((await me(token)).age_confirmed_at, confirmed.age_confirmed_at, 'second confirmation moved timestamp')
      assert.equal((await preferences(token, { nsfw_enabled: false })).status, 200)
      assert.equal((await me(token)).preferences.nsfw_enabled, false)
      assert.equal((await preferences(token, { nsfw_enabled: true, age_confirmed: false })).status, 200)
      assert.equal((await me(token)).age_confirmed_at, confirmed.age_confirmed_at)
      if (token === guestToken) guestAge = confirmed.age_confirmed_at
    }
    // Confirmation can be recorded separately without opting into mature themes.
    const separate = await newGuest()
    await authService.updatePreferences(String(separate._id), { age_confirmed: true })
    assert.equal((await authService.getUserById(String(separate._id))).preferences.nsfw_enabled, false)
    assert.ok((await authService.getUserById(String(separate._id))).age_confirmed_at instanceof Date)
    await authService.updatePreferences(guestId, { interests: ['fantasy'], player_name: 'Guest name' })
  })
  await check('concurrent first confirmations never replace an already-written age timestamp', async () => {
    const source = await newGuest()
    const first = new Date('2026-01-01T00:00:00.000Z')
    const originalGet = authService.getUserById
    authService.getUserById = async userId => {
      const stale = await originalGet.call(authService, userId)
      if (userId === String(source._id)) await users.updateOne({ _id: source._id }, { $set: { age_confirmed_at: first } })
      return stale
    }
    try { await authService.updatePreferences(String(source._id), { age_confirmed: true, nsfw_enabled: true }) }
    finally { authService.getUserById = originalGet }
    assert.equal((await users.findOne({ _id: source._id }))!.age_confirmed_at.getTime(), first.getTime(), 'concurrent confirmation moved timestamp')
  })
  await check('legacy mature opt-in stays on without a timestamp; unrelated updates do not migrate it', async () => {
    const source = (await authService.signInWithGoogle('google:legacy-age@example.test')).userDoc
    await users.updateOne({ _id: source._id }, { $set: { 'preferences.nsfw_enabled': true } })
    await authService.updatePreferences(String(source._id), { theme: 'dark' })
    const saved = await authService.getUserById(String(source._id))
    assert.equal(authService.serializeUser(saved).preferences.nsfw_enabled, true)
    assert.equal(Object.hasOwn(saved, 'age_confirmed_at'), false)
    await authService.updatePreferences(String(source._id), { nsfw_enabled: false })
    await assert.rejects(authService.updatePreferences(String(source._id), { nsfw_enabled: true }),
      (error: unknown) => error instanceof HttpError && error.statusCode === 400)
  })
  await check('guest can start a listed adult-capable world with mature themes off or on', async () => {
    const templateId = id()
    await db.collection('world_templates').insertOne({ _id: templateId, creator_id: id(), slug: String(templateId),
      is_nsfw_capable: true, is_published: true, version: 1 })
    for (const enabled of [false, true]) {
      await authService.updatePreferences(guestId, { nsfw_enabled: enabled })
      await assert.doesNotReject(async () => {
        const result = await instanceService.create(guestId, String(templateId), 'free')
        assert.equal(result.template.is_nsfw_capable, true)
        assert.equal(String(result.instance.player_id), guestId)
      }, 'guest must be able to start catalog worlds')
    }
  })
  await check('all media service requests, creation, publishing, preview and autofill refuse guests', async () => {
    const other = String(id())
    for (const request of [() => requestVoice(guestId, other, other, 'l1'), () => visual.requestPicture(guestId, other, other),
      () => visual.requestVideo(guestId, other, other, 'l1'), () => visual.requestTurnVideo(guestId, other, other),
      () => visual.requestPortrait(guestId, other, other), () => visual.requestPersonaPortrait(guestId, other)]) await assert.rejects(request(), required)
    const user = authService.toJwtPayload(await authService.getUserById(guestId))
    await assert.rejects(templateController.create({ user, body: {} as never }), required)
    await assert.rejects(templateController.publish({ user, params: { id: other } }), required)
    await assert.rejects(templateController.generateImage({ user, body: { prompt: 'audit' }, headers: {} }), required)
    await assert.rejects(templateController.autofill({ user, body: { target: 'world' }, headers: {} }), required)
    const response = await app.handle(new Request(`http://localhost/instances/${other}/events/${other}/picture`, {
      method: 'POST', headers: { authorization: `Bearer ${guestToken}` },
    }))
    assert.equal(response.status, 403)
    assert.equal((await response.json() as Document).code, 'sign_in_required')
  })
  const originalLoad = instanceService.loadSession
  instanceService.loadSession = async () => ({ is_nsfw_capable: true })
  await check('five-turn admission is atomic across saves, independent of Ink promo; sixth socket frame is SIGN_IN_REQUIRED', async () => {
    const limitedSession = await post('guest', { install_id: crypto.randomUUID() })
    const guest = await authService.getUserById(limitedSession.body.user.id), pid = String(guest._id), iid = id()
    await db.collection('world_instances').insertOne({ _id: iid, player_id: guest._id, template_id: id() })
    await authService.updatePreferences(pid, { nsfw_enabled: true, age_confirmed: true })
    for (const unlimited of [true, false]) {
      await db.collection('billing_config').updateOne({ _id: 'singleton' } as Document, { $set: { promo: { unlimited, daily_turn_cap: 500 } } }, { upsert: true })
      assert.equal((await billingService.reserve(pid, 'story_turn', crypto.randomUUID())).cost, 0)
    }
    await assert.rejects(generationService.dispatch({ instanceId: String(id()), playerId: pid, userMessage: 'Hello' }))
    rejectEnqueue = true
    await assert.rejects(generationService.dispatch({ instanceId: String(iid), playerId: pid, userMessage: 'Hello' }))
    assert.equal((await users.findOne({ _id: guest._id }))!.guest_turns, 0)
    rejectEnqueue = false
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => generationService.dispatch({ instanceId: String(iid), playerId: pid, userMessage: 'Hello' })))
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 5)
    assert.equal(outcomes.filter(result => result.status === 'rejected' && required(result.reason)).length, 3)
    for (const job of jobs) if (job.data.playerId === pid) assert.equal(job.data.userNsfwEnabled, true, 'primary dispatch forced guest mature off')
    await assert.rejects(billingService.reserve(pid, 'story_turn', crypto.randomUUID()), required)
    await assert.rejects(generationService.dispatchReplay({ instanceId: String(iid), playerId: pid, eventId: String(id()) }))
    const frames: Record<string, unknown>[] = []
    const ws = { data: { jwt: { verify: async () => ({}) }, _user: authService.toJwtPayload(guest) }, send: (raw: string) => frames.push(JSON.parse(raw)), close() {} }
    await playWsService.handleMessage(ws, { action: 'chat', instance_id: String(iid), payload: { message: 'Sixth' } })
    assert.equal(frames.at(-1)?.type, 'error'); assert.equal(frames.at(-1)?.code, 'SIGN_IN_REQUIRED')
    assert.equal(toClientError(policy.signInRequired()).code, 'SIGN_IN_REQUIRED')
    const eventId = id()
    await db.collection('events').insertOne({ _id: eventId, instance_id: iid, player_id: guest._id, sequence: 1 })
    const response = await app.handle(new Request(`http://localhost/chronicle/replay/${eventId}`, {
      method: 'POST', headers: { authorization: `Bearer ${limitedSession.body.token}` },
    }))
    assert.equal(response.status, 403)
    assert.equal((await response.json() as Document).code, 'sign_in_required')
  })
  instanceService.loadSession = originalLoad
  await check('replay routes guests by their mature setting, using the adult or gentle model', async () => {
    const { memoryService } = await import('../src/services/memory.service')
    const source = await newGuest(), templateId = id(), instanceId = id(), eventId = id()
    await db.collection('world_templates').insertOne({ _id: templateId, creator_id: id(), slug: String(templateId),
      is_nsfw_capable: true, seed_prompt: 'Audit story.', model_preferences: { narration_nsfw: 'audit-adult', narration_sfw: 'audit-gentle' } })
    await db.collection('world_instances').insertOne({ _id: instanceId, player_id: source._id, template_id: templateId,
      mode: 'ardent', world_state: {}, active_flags: {} })
    await db.collection('events').insertOne({ _id: eventId, instance_id: instanceId, player_id: source._id, sequence: 1,
      data: { player_input: 'Hello', ai_response: 'An earlier reply.', model_used: 'audit' } })
    for (const enabled of [false, true]) {
      await authService.updatePreferences(String(source._id), { nsfw_enabled: enabled, age_confirmed: true })
      replayModel = ''
      await assert.rejects(memoryService.replayEvent(String(eventId), String(source._id)), error => error === replayBoundary)
      assert.equal(replayModel, enabled ? 'audit-adult' : 'audit-gentle', 'replay forced guest mature off')
    }
  })
  await check('Google claim uses same id and retains name, persona, interests and telemetry; stale guest token is ignored as a real account', async () => {
    const iid = id()
    await db.collection('personas').insertOne({ _id: id(), player_id: new ObjectId(guestId), name: 'Saved persona' })
    await db.collection('world_instances').insertOne({ _id: iid, player_id: new ObjectId(guestId), template_id: id() })
    await db.collection('app_events').insertOne({ event_id: crypto.randomUUID(), user_id: new ObjectId(guestId), name: 'guest_started' })
    const beforeClaim = await users.findOne({ _id: new ObjectId(guestId) })
    const claimed = await post('google', { id_token: 'google:claim@example.test', guest_token: guestToken }, guestToken)
    assert.equal(claimed.status, 200); assert.equal(claimed.body.user.id, guestId); assert.equal(claimed.body.new_account, true)
    assert.equal(claimed.body.user.guest, false); assert.equal(claimed.body.user.preferences.player_name, 'Guest name')
    assert.deepEqual(claimed.body.user.preferences.interests, ['fantasy'])
    assert.equal(claimed.body.user.preferences.nsfw_enabled, true, 'claim lost guest mature choice')
    assert.equal(claimed.body.user.age_confirmed_at, guestAge, 'claim lost age confirmation')
    const afterClaim = await users.findOne({ _id: new ObjectId(guestId) })
    assert.equal(afterClaim!.guest_started_at?.getTime(), beforeClaim!.guest_started_at.getTime(), 'claim lost guest start')
    assert.ok(afterClaim!.signed_up_at instanceof Date, 'claim sign-up timestamp missing')
    assert.ok(afterClaim!.signed_up_at >= beforeClaim!.created_at, 'claim sign-up predates guest')
    await authService.signInWithGoogle('google:claim@example.test', guestId)
    assert.equal((await users.findOne({ _id: new ObjectId(guestId) }))!.signed_up_at.getTime(), afterClaim!.signed_up_at.getTime(), 'sign-in moved sign-up timestamp')
    assert.equal(await db.collection('personas').countDocuments({ player_id: new ObjectId(guestId) }), 1)
    assert.equal(await db.collection('app_events').countDocuments({ user_id: new ObjectId(guestId) }), 1)
    const separate = await post('google', { id_token: 'google:different@example.test', guest_token: guestToken })
    assert.notEqual(separate.body.user.id, guestId); assert.ok(await users.findOne({ _id: new ObjectId(guestId) }))
  })

  // Independent fixture inventory: adding a production move without a fixture,
  // or removing one, cannot silently reduce what "everything moved" means.
  const playerCollections = ['world_instances', 'events', 'memories', 'characters', 'entities', 'personas', 'generation_logs', 'extractor_raw',
    'projection_anomalies', 'signal_ledger', 'relation_candidates', 'post_process_outbox', 'projection_checkpoints', 'media_assets', 'media_rejections',
    'billing_entitlements', 'store_purchases', 'llm_calls', 'ink_ledger', 'media_usage']
  const telemetryCollections = ['app_events', 'app_sessions', 'app_errors']
  async function seedInventory(source: ObjectId, target: ObjectId) {
    const iid = id(), templateId = id()
    const preserved: Array<{ collection: string; doc: Document }> = []
    for (const name of playerCollections) {
      for (const [player_id, label] of [[source, 'source'], [target, 'target']] as const) {
        const doc: Document = { _id: id(), player_id, label, instance_id: iid }
        if (name === 'world_instances') { doc._id = player_id.equals(source) ? iid : id(); doc.template_id = templateId }
        if (name === 'events') { doc.sequence = label === 'source' ? 1 : 2; doc.type = 'action' }
        if (name === 'entities') { doc.type = 'character'; doc.canonical_name = label; doc.name_normalized = label }
        if (name === 'memories') { doc.pinecone_id = String(doc._id); doc.text = label }
        if (name === 'media_assets') { doc.cache_key = String(doc._id); doc.asset_key = `audit/${doc._id}` }
        if (name === 'media_usage') { doc.day = '2026-10-31'; doc.kind = 'portrait'; doc.slot = 1 }
        if (name === 'ink_ledger') { doc.idempotency_key = 'reserve:story_turn:collision'; doc.delta = label === 'source' ? -1 : 17; doc.reference = 'reserve:story_turn:original'; doc.reason = 'reserve' }
        if (name === 'store_purchases') { doc.provider = 'google_play'; doc.purchase_token = String(doc._id) }
        if (name === 'post_process_outbox') { doc.event_id = id(); doc.kind = 'audit'; doc.payload = { playerId: String(player_id) } }
        if (name === 'relation_candidates') { doc.source_event_id = id(); doc.character_entity_id = id(); doc.relation = 'audit' }
        if (name === 'projection_checkpoints') { doc.sequence = label === 'source' ? 1 : 2; doc.kind = 'world_projection' }
        if (name === 'characters') { doc.canonical_name = label; doc.name_normalized = label }
        await db.collection(name).insertOne(doc)
        if (label === 'target') preserved.push({ collection: name, doc })
      }
    }
    for (const name of telemetryCollections) {
      const doc: Document = { _id: id(), user_id: source }
      if (name === 'app_events') doc.event_id = crypto.randomUUID()
      if (name === 'app_errors') doc.error_id = crypto.randomUUID()
      await db.collection(name).insertOne(doc)
    }
    await db.collection('world_templates').insertOne({ _id: templateId, creator_id: source, slug: String(templateId) })
    await db.collection('projection_checkpoint_chunks').insertOne({ checkpoint_id: id(), instance_id: iid, kind: 'characters', index: 0, docs: [{ player_id: source, text: 'snapshot' }, { player_id: target }] })
    for (const name of ['entity_edges', 'scene_summaries', 'chapter_summaries', 'arc_summaries', 'story_calendars', 'timeline_branches', 'location_stats', 'place_candidates', 'llm_call_bodies']) {
      await db.collection(name).insertOne({ _id: id(), instance_id: iid })
    }
    await db.collection('content_reports').insertOne({ reporter_id: source, target_type: 'user', target_id: source, target_creator_id: source })
    await db.collection('app_installs').insertOne({ _id: crypto.randomUUID() as never, user_ids: [source, target] })
    await db.collection('dead_letter_jobs').insertOne({ data: { playerId: String(source), nested: { user_id: String(source) } } })
    jobs.length = 0
    jobs.push({ data: { playerId: String(source), instanceId: String(iid) }, state: 'completed', async updateData(value) { this.data = value as Record<string, unknown> } })
    await redisClient.set(`session:${iid}`, 'cached source session')
    return { iid, templateId, preserved }
  }
  async function assertNoReferences(source: ObjectId) {
    function contains(value: unknown): boolean {
      if (value instanceof ObjectId) return value.equals(source)
      if (typeof value === 'string') return value === String(source)
      if (Array.isArray(value)) return value.some(contains)
      if (value && typeof value === 'object') return Object.values(value).some(contains)
      return false
    }
    for (const collection of await db.listCollections().toArray()) {
      // Merge provenance deliberately retains the deleted guest's id.
      if (collection.name === 'guest_merges') continue
      for (const doc of await db.collection(collection.name).find({}).toArray()) assert.equal(contains(doc), false, `${collection.name} retains deleted guest`)
    }
    // Terminal Redis history deliberately retains the original job payload.
    for (const job of jobs.filter(job => !['completed', 'failed'].includes(job.state))) assert.equal(contains(job.data), false, 'pending queue retains guest')
  }
  await check('phone claim preserves identity, data and id; bad proof and non-guest token cannot merge a real account', async () => {
    const created = await post('guest', { install_id: crypto.randomUUID() })
    const claimed = await post('otp/verify', { phone: '+15555550101', code: '123456', guest_token: created.body.token })
    assert.equal(claimed.status, 200); assert.equal(claimed.body.user.id, created.body.user.id)
    const invalid = await post('google', { id_token: 'google:invalid-token@example.test', guest_token: 'forged' })
    assert.equal(invalid.status, 200); assert.notEqual(invalid.body.user.id, guestId)
    await assert.rejects(authService.signInWithPhoneOtp('+15555550101', 'bad', guestId))
  })
  await check('merge moves every inventoried reference, preserves target rows, invalidates caches and is a no-op on retry', async () => {
    const source = await newGuest()
    const target = (await authService.signInWithGoogle('google:merge-target@example.test')).userDoc
    await authService.updatePreferences(String(source._id), { age_confirmed: true, nsfw_enabled: true })
    const sourceAge = (await users.findOne({ _id: source._id }))!.age_confirmed_at
    await users.updateOne({ _id: source._id }, { $set: { 'preferences.interests': ['source-interest'], blocked_user_ids: [new ObjectId(guestId)] } })
    await users.updateOne({ _id: target._id }, { $set: { 'preferences.player_name': 'Existing name', 'preferences.interests': ['existing-interest'], token_balance: 9001 } })
    const targetBefore = await users.findOne({ _id: target._id })
    const fixtures = await seedInventory(source._id, target._id)
    const reportedWorld = id()
    const existingReport = { _id: id(), reporter_id: target._id, target_type: 'world', target_id: reportedWorld, status: 'open', details: 'Existing report' }
    await db.collection('content_reports').insertOne(existingReport)
    const duplicateReport = { _id: id(), reporter_id: source._id, target_type: 'world', target_id: reportedWorld, status: 'open', details: 'Guest report' }
    await db.collection('content_reports').insertOne(duplicateReport)
    fixtures.preserved.push({ collection: 'content_reports', doc: existingReport })
    await users.updateOne({ _id: new ObjectId(guestId) }, { $addToSet: { blocked_user_ids: source._id } })
    const result = await authService.signInWithGoogle('google:merge-target@example.test', String(source._id))
    assert.equal(String(result.userDoc._id), String(target._id)); assert.equal(result.newAccount, true)
    assert.equal(result.userDoc.age_confirmed_at?.getTime(), sourceAge.getTime(), 'merge lost guest age confirmation')
    assert.equal(result.userDoc.preferences.nsfw_enabled, false, 'merge overwrote target mature choice')
    assert.equal(result.userDoc.preferences.player_name, 'Existing name'); assert.deepEqual(result.userDoc.preferences.interests, ['existing-interest'])
    assert.equal((await db.collection('content_reports').findOne({ _id: duplicateReport._id }))!.status, 'dismissed')
    assert.equal(result.userDoc.token_balance, 9001); assert.equal(result.userDoc.created_at.getTime(), targetBefore!.created_at.getTime())
    for (const { collection, doc } of fixtures.preserved) assert.deepEqual(await db.collection(collection).findOne({ _id: doc._id }), doc, `overwrote target ${collection}`)
    for (const name of playerCollections) assert.ok(await db.collection(name).findOne({ player_id: target._id, label: 'source' }), `did not move ${name}`)
    assert.equal(await redisClient.get(`session:${fixtures.iid}`), null)
    assert.equal(jobs[0].data.playerId, String(source._id), 'merge rewrote terminal history')
    await assertNoReferences(source._id)
    const merges = db.collection('guest_merges')
    const mergeRow = await merges.findOne({ _id: source._id })
    assert.ok(mergeRow, 'merge provenance missing')
    assert.deepEqual(Object.keys(mergeRow).sort(), ['_id', 'guest_id', 'target_id', 'guest_started_at', 'merged_at'].sort(), 'merge provenance shape')
    assert.ok(mergeRow.guest_id.equals(source._id) && mergeRow.target_id.equals(target._id), 'merge provenance identity')
    assert.equal(mergeRow.guest_started_at.getTime(), source.guest_started_at!.getTime(), 'merge lost guest start')
    assert.ok(mergeRow.merged_at instanceof Date, 'merge timestamp missing')
    const snapshot = JSON.stringify(await db.collection('ink_ledger').find({}).toArray())
    await guestService.merge(String(source._id), target)
    assert.equal(JSON.stringify(await db.collection('ink_ledger').find({}).toArray()), snapshot)
    assert.deepEqual(await merges.find({ guest_id: source._id }).toArray(), [mergeRow], 'merge retry duplicated or changed provenance')
  })
  await check('merge provenance precedes deletion in the same transaction, rolls back and survives retry once; target deletion purges it', async () => {
    const source = await newGuest()
    // Older guests have no start timestamp: preserve their creation day.
    await users.updateOne({ _id: source._id }, { $unset: { guest_started_at: '' } })
    const target = (await authService.signInWithGoogle('google:funnel-purge@example.test')).userDoc
    const merges = db.collection('guest_merges')
    const originalDelete = Collection.prototype.deleteOne
    let deletes = 0
    let abort = !standalone
    Collection.prototype.deleteOne = async function(filter, options) {
      if (this.collectionName === 'users' && (filter._id as ObjectId)?.equals(source._id)) {
        deletes++
        const row = await merges.findOne({ _id: source._id }, options)
        assert.ok(row, 'provenance must exist before guest deletion')
        assert.ok(row.guest_started_at instanceof Date, 'legacy merge lost creation day')
        assert.equal(row.guest_started_at.getTime(), source.created_at.getTime(), 'legacy merge lost creation day')
        if (!standalone) assert.ok(options?.session, 'merge provenance must use the account transaction')
        if (abort) throw new Error('audit rollback after provenance write')
        if (!standalone && deletes === 2) {
          const retry = new MongoServerError({ message: 'audit transient transaction retry', code: 112 })
          retry.addErrorLabel('TransientTransactionError')
          throw retry
        }
      }
      return originalDelete.call(this, filter, options)
    }
    try {
      if (!standalone) {
        await assert.rejects(guestService.merge(String(source._id), target), /audit rollback/)
        assert.equal(await merges.countDocuments({ guest_id: source._id }), 0, 'aborted transaction retained merge provenance')
        assert.ok(await users.findOne({ _id: source._id }), 'aborted merge deleted guest')
        abort = false
      }
      await guestService.merge(String(source._id), target)
    } finally { Collection.prototype.deleteOne = originalDelete }
    assert.equal(deletes, standalone ? 1 : 3, 'transaction callback was not retried')
    const rows = await merges.find({ guest_id: source._id }).toArray()
    assert.equal(rows.length, 1, 'transaction retry duplicated merge provenance')
    await guestService.merge(String(source._id), target)
    assert.deepEqual(await merges.find({ guest_id: source._id }).toArray(), rows, 'merge retry changed provenance')
    const unrelated = id()
    await merges.insertOne({ guest_id: target._id, target_id: unrelated, guest_started_at: new Date(), merged_at: new Date() })
    const keep = { _id: id(), guest_id: id(), target_id: unrelated, guest_started_at: new Date(), merged_at: new Date() }
    await merges.insertOne(keep)
    const { deletionService } = await import('../src/services/deletion.service')
    await deletionService.deleteAccount(String(target._id))
    assert.equal(await merges.countDocuments({ target_id: target._id }), 0, 'target deletion retained merge provenance')
    assert.equal(await merges.countDocuments({ guest_id: target._id }), 0, 'guest-id safety purge missing')
    assert.deepEqual(await merges.findOne({ _id: keep._id }), keep, 'purge removed unrelated merge provenance')
    const indexes = await merges.listIndexes().toArray()
    for (const field of ['target_id', 'guest_started_at']) assert.ok(indexes.some(row => row.key[field] === 1), `merge index missing: ${field}`)
  })
  await check('merge resumes an already recorded start without duplicating or rewriting it', async () => {
    const source = await newGuest()
    const target = (await authService.signInWithGoogle('google:funnel-resume@example.test')).userDoc
    const row = { _id: source._id, guest_id: source._id, target_id: target._id,
      guest_started_at: source.guest_started_at!, merged_at: new Date('2026-01-01T00:00:00Z') }
    const merges = db.collection('guest_merges')
    await merges.insertOne(row)
    await guestService.merge(String(source._id), target)
    assert.deepEqual(await merges.find({ guest_id: source._id }).toArray(), [row], 'resumed merge duplicated or rewrote start')
  })
  await check('merge keeps the existing confirmation and mature choice; unconfirmed merges omit age entirely', async () => {
    for (const targetConfirmed of [false, true]) {
      const source = await newGuest()
      const target = (await authService.signInWithGoogle(`google:age-target-${targetConfirmed}@example.test`)).userDoc
      if (targetConfirmed) {
        await authService.updatePreferences(String(source._id), { age_confirmed: true, nsfw_enabled: true })
        await users.updateOne({ _id: target._id }, { $set: { age_confirmed_at: new Date('2025-01-01T00:00:00.000Z'), 'preferences.nsfw_enabled': true } })
      }
      const merged = await guestService.merge(String(source._id), target)
      if (targetConfirmed) {
        assert.equal(merged.age_confirmed_at?.toISOString(), '2025-01-01T00:00:00.000Z', 'merge overwrote existing age confirmation')
        assert.equal(merged.preferences.nsfw_enabled, true)
      } else {
        assert.equal(Object.hasOwn(merged, 'age_confirmed_at'), false, 'unconfirmed merge wrote an age value')
      }
    }
  })
  await check('missing interests copied; transfer is fenced, retries drain work and destination cannot change', async () => {
    const source = await newGuest()
    const target = (await authService.signInWithPhoneOtp('+15555550102', '123456')).userDoc
    await users.updateOne({ _id: source._id }, { $set: { 'preferences.interests': ['fantasy'] } })
    const lease = await beginGuestRequest(String(source._id)); assert.ok(lease)
    await assert.rejects(guestService.merge(String(source._id), target), (error: unknown) => error instanceof HttpError && error.statusCode === 409)
    assert.equal(await authService.getLiveAccess(String(source._id)), null)
    assert.equal(await beginGuestRequest(String(source._id)), null)
    await assert.rejects(guestService.merge(String(source._id), await authService.getUserById(guestId)))
    await endGuestRequest(String(source._id), lease)
    const backgroundLease = await beginGuestRequest(String(source._id), true)
    assert.ok(backgroundLease, 'already queued guest work can drain while transfer is pending')
    assert.equal(await closeGuestRequests(String(source._id)), null, 'transfer cannot close over a writer')
    await endGuestRequest(String(source._id), backgroundLease)
    const transfer = await closeGuestRequests(String(source._id)); assert.ok(transfer)
    assert.equal(await beginGuestRequest(String(source._id), true), null, 'closed transfer excludes late detached work')
    await reopenGuestRequests(String(source._id), transfer)
    jobs.length = 0
    jobs.push({ data: { playerId: String(source._id) }, state: 'active', async updateData(value) { this.data = value as Record<string, unknown> } })
    await assert.rejects(guestService.merge(String(source._id), target))
    jobs[0].state = 'completed'
    const result = await guestService.merge(String(source._id), target)
    assert.deepEqual(result.preferences.interests, ['fantasy'])
    await assertNoReferences(source._id)
  })
  await check('detached background writers drain before merge; scheduled recovery finishes the transfer', async () => {
    const source = await newGuest(), target = await authService.getUserById(guestId)
    const { runBackgroundLLMTrace } = await import('../src/services/llm-trace.service')
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const pending = runBackgroundLLMTrace({ player_id: source._id }, async () => {
      entered(); await gate
      await db.collection('personas').insertOne({ player_id: source._id, name: 'Detached writer' })
    })
    await started
    try { await assert.rejects(guestService.merge(String(source._id), target), (error: unknown) => error instanceof HttpError && error.statusCode === 409) }
    finally { release(); await pending }
    const recovered = await expireGuests()
    assert.equal(recovered.resumed, 1)
    assert.ok(await db.collection('personas').findOne({ player_id: target._id, name: 'Detached writer' }))
    await assertNoReferences(source._id)
  })
  await check('interrupted merge keeps the source reachable and retries to zero references', async () => {
    const source = await newGuest()
    const target = (await authService.signInWithGoogle('google:crash-target@example.test')).userDoc
    await seedInventory(source._id, target._id)
    const original = Collection.prototype.updateMany
    let injected = false
    Collection.prototype.updateMany = function(filter, update, options) {
      if (!injected && this.collectionName === 'memories' && String((filter as Document).player_id) === String(source._id)) {
        injected = true
        return Promise.reject(new Error('audit interrupted merge'))
      }
      return original.call(this, filter, update, options)
    }
    try { await assert.rejects(guestService.merge(String(source._id), target), /audit interrupted merge/) }
    finally { Collection.prototype.updateMany = original }
    assert.ok(injected)
    assert.ok(await users.findOne({ _id: source._id, guest: true }))
    for (const name of playerCollections) assert.ok(await db.collection(name).findOne({ label: 'source', player_id: { $in: [source._id, target._id] } }), `${name} became unreachable`)
    await guestService.merge(String(source._id), target)
    await assertNoReferences(source._id)
  })
  await check('30-day expiry uses account deletion: graph, payloads, personas, vectors, objects, billing, analytics, reports and blocks', async () => {
    const source = await newGuest(), target = await authService.getUserById(guestId)
    const fixtures = await seedInventory(source._id, target._id)
    // The purge fixture does not need target rows; those belong to another save.
    for (const { collection, doc } of fixtures.preserved) await db.collection(collection).deleteOne({ _id: doc._id })
    await db.collection('personas').updateOne({ player_id: source._id }, { $set: { portrait: { asset_key: 'audit/persona-face' } } })
    await users.updateOne({ _id: source._id }, { $set: { created_at: new Date(Date.now() - 31 * 86_400_000) } })
    jobs.length = 0
    const fresh = await newGuest()
    await users.updateOne({ _id: target._id }, { $set: { created_at: new Date(Date.now() - 31 * 86_400_000) } })
    const result = await expireGuests()
    assert.equal(result.deleted, 1); assert.ok(await users.findOne({ _id: fresh._id }))
    assert.ok(await users.findOne({ _id: target._id }), 'old signed-in accounts never expire as guests')
    assert.equal(await users.findOne({ _id: source._id }), null)
    assert.ok(vectorDeletes.some(scope => JSON.stringify(scope) === JSON.stringify({ kind: 'mem', instanceId: String(fixtures.iid) })))
    assert.ok(vectorDeletes.some(scope => JSON.stringify(scope) === JSON.stringify({ kind: 'sum', instanceId: String(fixtures.iid) })))
    assert.ok(vectorDeletes.some(scope => JSON.stringify(scope) === JSON.stringify({ kind: 'lore', templateId: String(fixtures.templateId) })))
    assert.ok(objectDeletes.includes('audit/persona-face'))
    for (const name of ['entity_edges', 'scene_summaries', 'chapter_summaries', 'arc_summaries', 'story_calendars', 'timeline_branches', 'location_stats', 'place_candidates', 'llm_call_bodies', 'projection_checkpoint_chunks']) {
      assert.equal(await db.collection(name).countDocuments({ instance_id: fixtures.iid }), 0, `purge missed ${name}`)
    }
    await assertNoReferences(source._id)
  })
  await check('real account deletion retains all five billing/moderation collections and removes privacy references', async () => {
    const { deletionService } = await import('../src/services/deletion.service')
    const source = (await authService.signInWithGoogle('google:delete-real@example.test')).userDoc
    const target = await authService.getUserById(guestId)
    const fixtures = await seedInventory(source._id, target._id)
    for (const { collection, doc } of fixtures.preserved) await db.collection(collection).deleteOne({ _id: doc._id })
    const retained = ['billing_entitlements', 'store_purchases', 'ink_ledger', 'media_usage', 'content_reports']
    // Cover both save-scoped and standalone usage, plus reports by and about this player.
    await db.collection('media_usage').insertOne({ player_id: source._id, kind: 'voice', day: '2026-10-31', slot: 2 })
    await db.collection('content_reports').insertMany([
      { reporter_id: source._id, target_type: 'world', target_id: id() },
      { reporter_id: target._id, target_type: 'user', target_id: source._id },
      { reporter_id: target._id, target_type: 'world', target_id: id(), target_creator_id: source._id },
    ])
    await users.updateOne({ _id: target._id }, { $addToSet: { blocked_user_ids: source._id } })
    const traceId = id()
    await db.collection('llm_calls').insertOne({ _id: traceId, player_id: source._id })
    await db.collection('llm_call_bodies').insertOne({ _id: traceId, body: 'audit standalone trace' })
    await db.collection('personas').updateOne({ player_id: source._id }, { $set: { portrait: { asset_key: 'audit/real-persona-face' } } })
    const snapshots = await Promise.all(retained.map(name => db.collection(name).find({}).toArray()))
    await deletionService.deleteAccount(String(source._id))
    for (const [i, name] of retained.entries()) {
      assert.deepEqual(await db.collection(name).find({}).toArray(), snapshots[i], `real deletion changed retained ${name}`)
    }
    for (const name of playerCollections.filter(name => !retained.includes(name))) {
      assert.equal(await db.collection(name).countDocuments({ player_id: source._id }), 0, `real deletion missed ${name}`)
    }
    for (const name of telemetryCollections) assert.equal(await db.collection(name).countDocuments({ user_id: source._id }), 0)
    assert.equal(await db.collection('llm_call_bodies').countDocuments({ _id: traceId }), 0)
    assert.equal(await users.countDocuments({ blocked_user_ids: source._id }), 0)
    assert.equal(await db.collection('dead_letter_jobs').countDocuments({ 'data.nested.user_id': String(source._id) }), 0)
    assert.ok(objectDeletes.includes('audit/real-persona-face'))
    assert.equal(await users.findOne({ _id: source._id }), null)
  })
  await check('expiry logs only ids and continues after individual merge and purge failures, then retries them', async () => {
    const { deletionService } = await import('../src/services/deletion.service')
    const target = await authService.getUserById(guestId)
    const failedMerge = await newGuest(), goodMerge = await newGuest(), failedPurge = await newGuest(), goodPurge = await newGuest()
    await users.updateMany({ _id: { $in: [failedMerge._id, goodMerge._id] } }, { $set: { guest_merge_target: target._id } })
    await users.updateMany({ _id: { $in: [failedPurge._id, goodPurge._id] } }, { $set: { created_at: new Date(Date.now() - 31 * 86_400_000) } })
    const merge = guestService.merge, purge = deletionService.deleteAccount, warn = console.warn
    const warnings: unknown[][] = []
    guestService.merge = async (source, dest) => {
      if (source === String(failedMerge._id)) throw new Error('audit failure details must never be logged')
      return merge.call(guestService, source, dest)
    }
    deletionService.deleteAccount = async source => {
      if (source === String(failedPurge._id)) throw new Error('audit failure details must never be logged')
      return purge.call(deletionService, source)
    }
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    try {
      let result: Awaited<ReturnType<typeof expireGuests>> | undefined
      await assert.doesNotReject(async () => { result = await expireGuests() }, 'expiry aborted after an individual failure')
      assert.deepEqual(result, { resumed: 1, deleted: 1 }, 'expiry did not continue after individual failures')
    } finally { guestService.merge = merge; deletionService.deleteAccount = purge; console.warn = warn }
    assert.deepEqual(warnings, [
      ['Guest expiry merge failed', String(failedMerge._id), String(target._id)],
      ['Guest expiry purge failed', String(failedPurge._id)],
    ])
    for (const source of [goodMerge, goodPurge]) assert.equal(await users.findOne({ _id: source._id }), null)
    for (const source of [failedMerge, failedPurge]) assert.ok(await users.findOne({ _id: source._id }))
    assert.deepEqual(await expireGuests(), { resumed: 1, deleted: 1 })
  })
  await check('no null age timestamp or age-confirmation input is persisted', async () => {
    assert.equal(await users.countDocuments({ age_confirmed_at: { $type: 10 } }), 0, 'null age timestamp was written')
    assert.equal(await users.countDocuments({ 'preferences.age_confirmed': { $exists: true } }), 0)
  })
  await check('funnel fact keys are never null', async () => {
    for (const key of ['guest_started_at', 'signed_up_at']) assert.equal(await users.countDocuments({ [key]: { $type: 10 } }), 0, `null funnel fact: ${key}`)
    for (const key of ['guest_id', 'target_id', 'guest_started_at', 'merged_at']) assert.equal(await db.collection('guest_merges').countDocuments({ [key]: { $type: 10 } }), 0, `null merge fact: ${key}`)
  })
  console.log(`guest audit (${standalone ? 'standalone fallback' : 'replica-set transactions'}): ${passed} checks passed`)
} finally {
  try { await cleanupConnections?.(); await adminClient.close() } finally {
  mongod.kill('SIGTERM'); redisProcess.kill('SIGTERM')
  await Promise.all([mongod.exited, redisProcess.exited])
  rmSync(scratch, { recursive: true, force: true })
  }
}
if (!standalone && !process.argv.includes('--no-fallback')) {
  const fallback = Bun.spawn(['bun', '--no-env-file', 'run', import.meta.path, '--standalone'], { stdout: 'inherit', stderr: 'inherit' })
  assert.equal(await fallback.exited, 0, 'standalone fallback audit failed')
  const bites = Bun.spawn(['bun', '--no-env-file', 'run', join(root, 'scripts/guest-audit-bites.ts')], { stdout: 'inherit', stderr: 'inherit' })
  assert.equal(await bites.exited, 0, 'guest mutation checks failed')
}
