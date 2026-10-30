/** Real routes, auth, discovery and template services against a disposable mongod. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { mock } from 'bun:test'
import { MongoClient, ObjectId } from 'mongodb'
import { SignJWT } from 'jose'
import type { WorldTemplateDoc } from '../src/models/world-template.model'

const root = await mkdtemp(join(tmpdir(), 'everlore-starter-audit-'))
const probe = createServer()
await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
const address = probe.address()
assert(address && typeof address !== 'string')
const port = address.port
await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
const logfile = await open(join(root, 'mongod.log'), 'w')
// No configured URI is used; this process owns both the server and its data dir.
const mongod = Bun.spawn(['mongod', '--bind_ip', '127.0.0.1', '--port', String(port), '--dbpath', root, '--nounixsocket'], {
  stdin: 'ignore', stdout: logfile.fd, stderr: logfile.fd,
})
const client = new MongoClient(`mongodb://127.0.0.1:${port}/starter_audit`, {
  serverSelectionTimeoutMS: 15_000,
})
try {
  await client.connect()
  const db = client.db()
  const worlds = db.collection<WorldTemplateDoc>('world_templates')
  const users = db.collection('users')
  const unavailable = (): never => { throw new Error('External dependency reached in starter audit') }
  const jwtSecret = crypto.randomUUID()
  mock.module('../src/config/env', () => ({ env: new Proxy({ JWT_SECRET: jwtSecret, CDN_BASE_URL: 'https://fixture.invalid' }, {
    get(target, key) { if (key === 'JWT_SECRET' || key === 'CDN_BASE_URL') return target[key]; return unavailable() },
  }) }))
  mock.module('../src/config/mongo', () => ({ mongoColl: { users: () => users, worldTemplates: () => worlds } }))
  mock.module('../src/services/vector-store', () => ({ vectorStore: { replaceLore: unavailable } }))
  mock.module('../src/ai', () => ({ embed: unavailable }))
  mock.module('../src/utils/protagonist', () => ({ deriveProtagonist: unavailable }))
  mock.module('../worker/lib/template-cast-extractor', () => ({ extractTemplateCast: async () => [] }))
  mock.module('../src/services/storage.service', () => ({ storageService: { promote: unavailable, keyFromUrl: unavailable, delete: unavailable } }))
  mock.module('../src/services/deletion.service', () => ({ deletionService: {} }))
  mock.module('../src/services/image.service', () => ({ imageService: {} }))
  mock.module('../src/services/autofill.service', () => ({ autofillService: {} }))
  mock.module('../src/services/billing.service', () => ({ billingService: {} }))
  mock.module('../src/middleware/rate-limit', () => ({ rateLimit: async () => ({ allowed: true }) }))
  mock.module('../src/utils/can-forge', () => ({ canForge: () => true }))
  mock.module('../src/services/last-active.service', () => ({ recordLastActive: () => {} }))
  let guestLeases = 0, guestAdmissions = 0
  mock.module('../src/config/redis', () => ({ getRedisClient: () => ({
    eval: async () => { guestLeases++; guestAdmissions++; return 1 },
    zrem: async () => { guestLeases--; return 1 },
  }) }))
  mock.module('../src/services/auth.service', () => ({ authService: {
    getLiveAccess: async (id: string) => {
      const user = await users.findOne({ _id: new ObjectId(id) })
      return user ? { tier: user.tier, guest: user.guest, account_status: user.account_status ?? 'active' } : null
    },
  } }))
  const { Elysia } = await import('elysia')
  const { templateRoutes } = await import('../src/routes/template.routes')
  const { templateService } = await import('../src/services/template.service')
  const { HttpError } = await import('../src/utils/http-error')
  const { CreateTemplateBody, UpdateTemplateBody } = await import('../src/schemas/template.schema')
  const app = new Elysia().onError(({ error, set }) => {
    if (error instanceof HttpError) { set.status = error.statusCode; return { error: error.message } }
  }).use(templateRoutes)
  const player = new ObjectId(), guest = new ObjectId(), creator = new ObjectId()
  const sign = (id: ObjectId) => new SignJWT({ id: id.toHexString(), tier: 'creator' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('2m').sign(new TextEncoder().encode(jwtSecret))
  const token = await sign(player), guestToken = await sign(guest)
  const date = (day: number) => new Date(Date.UTC(2026, 0, day))
  function world(id: number, patch: Partial<WorldTemplateDoc> = {}): WorldTemplateDoc {
    return {
      _id: new ObjectId(id.toString(16).padStart(24, '0')), creator_id: creator,
      title: `Fixture ${id}`, slug: `fixture-${id}`, description: 'An authored fixture.',
      kind: 'world', genre: 'epic', starter: true, is_published: true, visibility: 'public', review_status: 'approved',
      is_sentient: false, is_nsfw_capable: true, version: 1, narrative_style: 'epic_fantasy',
      seed_prompt: 'Private fixture instructions.', global_lore: 'A public fixture setting.',
      base_stats_template: { resolve: { min: 0, max: 10, default: 5, description: 'Resolve' } },
      flag_definitions: {}, scene_tags: [], model_preferences: {}, max_context_memories: 25, max_lore_results: 10,
      created_at: date(1), updated_at: date(1), ...patch,
    }
  }
  async function reset(interests: string[] = []) {
    await worlds.deleteMany({}); await users.deleteMany({})
    await users.insertMany([
      { _id: player, tier: 'creator', preferences: { interests } },
      { _id: guest, tier: 'free', guest: true, preferences: { interests } },
    ])
  }
  async function request(path = '/templates/starter', bearer: string | null = token, method = 'GET', body?: object) {
    const response = await app.handle(new Request(`http://localhost${path}`, {
      method, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }))
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  async function pick(expected: WorldTemplateDoc | null, bearer = token) {
    const result = await request('/templates/starter', bearer)
    assert.equal(result.status, 200)
    assert.deepEqual(Object.keys(result.body), ['template'])
    const value = result.body.template as Record<string, unknown> | null
    if (expected === null) assert.equal(value, null)
    assert.equal(value?._id ?? null, expected?._id.toHexString() ?? null)
    return value
  }
  let passed = 0
  const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7)
  async function check(name: string, run: () => Promise<void>) {
    if (only && only !== name) return
    await reset(); await run(); passed++; console.log(`PASS ${name}`)
  }
  await check('exact-voice', async () => {
    await reset(['flirty'])
    const exact = world(1, { narrative_style: 'flirty', genre: 'romance' })
    await worlds.insertMany([world(2, { narrative_style: 'dark_romance', created_at: date(2) }), world(3, { created_at: date(3) }), exact])
    await pick(exact)
  })
  await check('family-fallback', async () => {
    await reset(['flirty'])
    const family = world(1, { narrative_style: 'dark_romance' })
    await worlds.insertMany([world(2, { created_at: date(2) }), family])
    await pick(family)
  })
  await check('no-interests-newest', async () => {
    const newest = world(2, { created_at: date(3) })
    await worlds.insertMany([world(1, { created_at: date(2) }), newest])
    for (let i = 0; i < 3; i++) await pick(newest)
  })
  await check('id-tie-break', async () => {
    const first = world(1)
    await worlds.insertMany([world(2), first])
    await pick(first)
  })
  await check('non-starter', async () => {
    const ordinary = world(2, { created_at: date(2) }); delete ordinary.starter
    const starter = world(1)
    await worlds.insertMany([ordinary, starter]); await pick(starter)
  })
  for (const [name, patch] of [
    ['unpublished', { is_published: false }], ['hidden', { moderation_status: 'hidden' }],
    ['private', { visibility: 'private' }], ['unapproved', { review_status: 'pending' }],
    ['blocked-template', {}], ['blocked-creator', { creator_id: new ObjectId() }],
  ] as const) await check(name, async () => {
    const excluded = world(2, { created_at: date(2), ...patch }), eligible = world(1)
    if (name === 'blocked-template') await users.updateOne({ _id: player }, { $set: { blocked_template_ids: [excluded._id] } })
    if (name === 'blocked-creator') await users.updateOne({ _id: player }, { $set: { blocked_user_ids: [excluded.creator_id] } })
    await worlds.insertMany([excluded, eligible]); await pick(eligible)
    await worlds.deleteOne({ _id: eligible._id }); await pick(null)
    // The For You list must have the same discovery set.
    const listed = await request('/templates?limit=50')
    assert.equal(listed.status, 200); assert.deepEqual(listed.body.templates, [])
  })
  await check('null-when-none', async () => {
    await pick(null)
    const ordinary = world(1); delete ordinary.starter
    await worlds.insertOne(ordinary); await pick(null)
  })
  await check('authentication', async () => {
    assert.equal((await request('/templates/starter', null)).status, 401)
    assert.equal((await request('/templates/starter', 'invalid-token')).status, 401)
  })
  await check('guest-token', async () => {
    await reset(['flirty'])
    const exact = world(1, { narrative_style: 'flirty' })
    await worlds.insertMany([world(2, { created_at: date(2) }), exact])
    const before = guestLeases, admissions = guestAdmissions
    await pick(exact, guestToken)
    // Response cleanup runs after the response has been handed off.
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(guestLeases, before)
    assert.equal(guestAdmissions, admissions + 1)
  })
  await check('public-list-shape', async () => {
    const fixture = world(1)
    await worlds.insertOne(fixture)
    const selected = await pick(fixture)
    const list = await request('/templates')
    assert.equal(list.status, 200)
    assert.deepEqual(selected, (list.body.templates as unknown[])[0])
    for (const key of ['starter', 'seed_prompt', 'model_preferences', 'flag_definitions']) assert.equal(Object.hasOwn(selected!, key), false)
  })
  const body = {
    title: 'Player Fixture', description: 'A player authored fixture.', kind: 'world', is_sentient: false, is_nsfw_capable: false,
    seed_prompt: 'A quiet setting for a fixture.', global_lore: '',
    base_stats_template: { resolve: { min: 0, max: 10, default: 5, description: 'Resolve' } },
    starter: true,
  }
  await check('public-body', async () => {
    assert.equal(Object.hasOwn(CreateTemplateBody.properties, 'starter'), false)
    assert.equal(Object.hasOwn(UpdateTemplateBody.properties, 'starter'), false)
    const created = await request('/templates', token, 'POST', body)
    assert.equal(created.status, 200)
    const id = String(created.body._id)
    assert.equal(Object.hasOwn((await worlds.findOne({ _id: new ObjectId(id) }))!, 'starter'), false)
    const updated = await request(`/templates/${id}`, token, 'PUT', { starter: true })
    assert.equal(updated.status, 200)
    assert.equal(Object.hasOwn((await worlds.findOne({ _id: new ObjectId(id) }))!, 'starter'), false)
    // Defense also holds for direct service callers that bypass HTTP stripping.
    const direct = await templateService.create(player.toHexString(), { ...body, title: 'Direct Fixture' })
    await templateService.update(direct._id.toHexString(), player.toHexString(), { starter: true })
    assert.equal(Object.hasOwn((await worlds.findOne({ _id: direct._id }))!, 'starter'), false)
    await worlds.updateOne({ _id: direct._id }, { $set: { starter: true } })
    for (const starter of [false, null]) {
      await templateService.update(direct._id.toHexString(), player.toHexString(), { starter })
      assert.equal((await worlds.findOne({ _id: direct._id }))!.starter, true)
    }
  })
  assert(passed > 0, `Unknown check: ${only}`)
  console.log(`starter audit: ${passed}/${passed} passed (disposable local mongod; real auth/routes/discovery; no environment file or paid calls)`)
} finally {
  await client.close()
  mongod.kill('SIGTERM'); await mongod.exited
  await logfile.close()
  await rm(root, { recursive: true, force: true })
}
