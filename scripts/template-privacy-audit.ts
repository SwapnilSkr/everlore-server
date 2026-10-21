import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'
import type { AuthUser } from '../src/middleware/auth'
import type { WorldTemplateDoc } from '../src/models/world-template.model'
import { canReadTemplateAuthoring, publicTemplate } from '../src/utils/template-public-projection'
import { HttpError } from '../src/utils/http-error'

// An independent contract: importing the implementation's keys would hide an
// accidental allow-list expansion from this audit.
const expectedPublicKeys = [
  '_id', 'slug', 'title', 'description', 'kind', 'image_url', 'global_lore',
  'base_stats_template', 'opening_line', 'narrative_style', 'scene_tags',
  'is_nsfw_capable', 'is_sentient', 'is_published', 'creator_id', 'version',
  'created_at', 'updated_at', 'visibility', 'review_status',
].sort()

const fixture = {
  _id: new ObjectId('000000000000000000000001'),
  creator_id: new ObjectId('000000000000000000000002'),
  slug: 'fixture-world', title: 'Fixture World', description: 'A public description.',
  kind: 'world', image_url: 'https://example.invalid/cover.webp',
  global_lore: 'A public world guide.',
  base_stats_template: { resolve: { default: 5, min: 0, max: 10, description: 'Resolve' } },
  opening_line: 'The story begins.', narrative_style: 'fantasy', scene_tags: ['arrival'],
  is_nsfw_capable: false, is_sentient: true, is_published: true, version: 1,
  created_at: new Date('2026-10-21T00:00:00Z'), updated_at: new Date('2026-10-21T00:00:00Z'),
  visibility: 'public', review_status: 'approved',
  seed_prompt: 'Private narrator instructions.', style_notes: 'Private style notes.',
  image_prompt: 'Private image prompt.',
  flag_definitions: { secret: { type: 'boolean', default: false, description: 'Private flag' } },
  seed_cast: [{ name: 'Fixture Companion', immutable_facts: ['A private fact.'] }],
  protagonist: { name: 'Fixture Lead', persona: 'Private persona.' },
  model_preferences: { narration_sfw: 'private-model' }, max_context_memories: 25, max_lore_results: 10,
  review_note: 'Private review note.', submitted_at: new Date('2026-10-20T00:00:00Z'),
  reviewed_at: new Date('2026-10-21T00:00:00Z'), reviewed_by: 'fixture-admin', ever_approved: true,
  moderation_status: 'active', moderation_reason: 'Private moderation reason.',
  moderated_at: new Date('2026-10-21T00:00:00Z'), moderated_by: 'fixture-admin',
  future_private_field: { secret: 'Private by default.' },
} satisfies WorldTemplateDoc & { future_private_field: unknown }

const owner: AuthUser = { id: fixture.creator_id.toHexString(), email: '', username: 'owner', tier: 'creator' }
const stranger: AuthUser = { ...owner, id: '000000000000000000000003', username: 'stranger' }
let stored: WorldTemplateDoc = fixture
let interests: string[] = []
const cursor = {
  sort: () => cursor, skip: () => cursor, limit: () => cursor,
  toArray: async () => [stored],
}
const unavailable = () => { throw new Error('Unexpected external dependency in privacy audit') }
function playFixture() {
  return {
    instance: {
      _id: new ObjectId('000000000000000000000004'), template_id: fixture._id,
      world_state: { secret: 1 }, seed_cast_snapshot: fixture.seed_cast,
      meta: { total_events: 1, is_archived: false },
    },
    template: { ...fixture },
  }
}
let created = playFixture()
let loaded = {
  ...playFixture(), template: { ...fixture } as WorldTemplateDoc | null,
  recentEvents: [{ sequence: 1, text: 'An existing event.' }],
  memories: [{ content: 'An existing memory.' }],
  characters: [{ name: 'Fixture Companion', immutable_facts: ['A runtime fact.'] }],
  operation: { kind: 'rewind' }, eventWindow: { limit: 30, total: 31, hasOlder: true },
}
let createArgs: unknown[] = []
let loadArgs: unknown[] = []
let liveTier = stranger.tier

// Import the real controller and service behind in-memory read boundaries.
// No environment module, database client, Redis, storage, or model is loaded.
mock.module('../src/config/mongo', () => ({ mongoColl: {
  worldTemplates: () => ({
    findOne: async () => stored, find: () => cursor, aggregate: () => cursor,
    countDocuments: async () => 1,
  }),
  users: () => ({ findOne: async () => ({ preferences: { interests } }) }),
} }))
mock.module('../src/services/vector-store', () => ({ vectorStore: { replaceLore: unavailable } }))
mock.module('../src/ai', () => ({ embed: unavailable }))
mock.module('../src/utils/protagonist', () => ({ deriveProtagonist: unavailable }))
mock.module('../src/constants/default-cover', () => ({ isDefaultCoverUrl: unavailable, resolveTemplateImageUrl: unavailable }))
mock.module('../src/services/storage.service', () => ({ storageService: {} }))
mock.module('../worker/lib/template-cast-extractor', () => ({ extractTemplateCast: unavailable }))
mock.module('../src/services/moderation.service', () => ({ moderationService: { discoveryFilter: async () => ({}) } }))
mock.module('../src/middleware/rate-limit', () => ({ rateLimit: unavailable }))
mock.module('../src/services/deletion.service', () => ({ deletionService: {} }))
mock.module('../src/services/image.service', () => ({ imageService: {} }))
mock.module('../src/services/autofill.service', () => ({ autofillService: {} }))
mock.module('../src/services/billing.service', () => ({ billingService: {} }))
mock.module('../src/utils/can-forge', () => ({ canForge: unavailable }))
// Only the outgoing boundaries are under test here. The engine services return
// retained fixture objects so any in-place redaction is observable after send.
mock.module('../src/services/instance.service', () => ({ instanceService: {
  create: async (...args: unknown[]) => { createArgs = args; return created },
} }))
mock.module('../src/services/generation.service', () => ({ generationService: {
  loadInstance: async (...args: unknown[]) => { loadArgs = args; return loaded },
} }))
mock.module('../src/middleware/auth', () => ({ verifyWsToken: unavailable }))
mock.module('../src/config/redis', () => ({ getRedisClient: () => ({}), getRedisSubscriber: unavailable }))
mock.module('../src/services/last-active.service', () => ({ recordLastActive: () => {} }))
mock.module('../src/services/auth.service', () => ({ authService: {
  getLiveAccess: async () => ({ account_status: 'active', tier: liveTier }),
} }))

const { templateController } = await import('../src/controllers/template.controller')
const { instanceController } = await import('../src/controllers/instance.controller')
const { playWsService } = await import('../src/services/play-ws.service')
const params = { id: fixture._id.toHexString() }
let passed = 0
let failed = 0
async function check(name: string, run: () => unknown | Promise<unknown>) {
  try {
    await run()
    console.log(`  PASS ${name}`)
    passed++
  } catch (error) {
    console.error(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
    failed++
  }
}
function assertPublic(value: object, serialized = false) {
  assert.deepEqual(Object.keys(value).sort(), expectedPublicKeys)
  const expected = serialized ? JSON.parse(JSON.stringify(fixture)) : fixture
  for (const key of expectedPublicKeys) {
    assert.deepEqual((value as Record<string, unknown>)[key], expected[key as keyof typeof fixture], key)
  }
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value))
const wire = (value: unknown) => JSON.parse(JSON.stringify(value))
const createBody = { template_id: fixture._id.toHexString(), persona_id: 'fixture-persona' }
async function loadFrame(user: AuthUser) {
  const frames: string[] = []
  liveTier = user.tier
  await playWsService.handleMessage({
    data: { _user: { ...user }, jwt: { verify: async () => unavailable() } },
    send: (frame) => { frames.push(frame) }, close: unavailable,
  }, { action: 'load_instance', instance_id: loaded.instance._id.toHexString() })
  assert.deepEqual(loadArgs, [loaded.instance._id.toHexString(), user.id])
  assert.equal(frames.length, 1)
  const frame = JSON.parse(frames[0])
  assert.equal(frame.type, 'instance_loaded')
  return frame
}

await check('(a) anonymous Explore item has exactly the public keys and values', async () => {
  const result = await templateController.listPublished({ query: {}, user: null })
  assertPublic(result.templates[0])
  assert.equal(result.total, 1)
  assert.equal(result.page, 1)
})
await check('(b) anonymous detail is public', async () => {
  assertPublic(await templateController.getById({ params, user: null }))
})
await check('(c) another authenticated user gets public detail', async () => {
  assertPublic(await templateController.getById({ params, user: stranger }))
})
await check('(d) owner detail preserves every full-document field', async () => {
  assert.deepEqual(await templateController.getById({ params, user: owner }), fixture)
})
await check('(e) verified admin is allowed full authoring access', () => {
  assert.equal(canReadTemplateAuthoring(fixture, null, true), true)
})
await check('(f) an unknown future field is absent publicly', () => {
  assert.equal(Object.hasOwn(publicTemplate(fixture), 'future_private_field'), false)
})
await check('(g) owner mine/list retains seed_prompt, seed_cast and every field', async () => {
  const result = await templateController.listMine({ user: owner, query: {} })
  assert.deepEqual(result.templates[0], fixture)
})
await check('(h) non-owner POST /instances projects only the response template without mutation', async () => {
  created = playFixture()
  const before = bytes(created)
  const result = await instanceController.create({ user: stranger, body: createBody })
  assert.deepEqual(bytes(created), before, 'service result must stay byte-identical')
  assertPublic(result.template)
  assert.notEqual(result, created)
  assert.equal(result.instance, created.instance)
  assert.deepEqual({ ...result, template: created.template }, created)
  assert.deepEqual(createArgs, [stranger.id, createBody.template_id, stranger.tier, createBody.persona_id])
})
await check('(i) non-owner instance_loaded projects only the response template without mutation', async () => {
  const before = bytes(loaded)
  const frame = await loadFrame(stranger)
  assert.deepEqual(bytes(loaded), before, 'engine state must stay byte-identical')
  assertPublic(frame.data.template, true)
  assert.deepEqual(frame, { type: 'instance_loaded', data: { ...wire(loaded), template: frame.data.template } })
})
await check('(j) owner POST /instances preserves the full template', async () => {
  created = playFixture()
  const before = bytes(created)
  const result = await instanceController.create({ user: owner, body: createBody })
  assert.deepEqual(bytes(created), before)
  assert.equal(result, created)
  assert.deepEqual(result.template, fixture)
})
await check('(j) owner instance_loaded preserves the full template', async () => {
  const before = bytes(loaded)
  const frame = await loadFrame(owner)
  assert.deepEqual(bytes(loaded), before)
  assert.deepEqual(frame, { type: 'instance_loaded', data: wire(loaded) })
  assert.deepEqual(frame.data.template, wire(fixture))
})
await check('a player admin tier gets public templates in both play responses', async () => {
  const user = { ...stranger, tier: 'admin' }
  assertPublic((await instanceController.create({ user, body: createBody })).template)
  assertPublic((await loadFrame(user)).data.template, true)
})
await check('instance_loaded preserves a missing template and every other field', async () => {
  const template = loaded.template
  loaded.template = null
  try {
    const before = bytes(loaded)
    assert.deepEqual(await loadFrame(stranger), { type: 'instance_loaded', data: wire(loaded) })
    assert.deepEqual(bytes(loaded), before)
  } finally {
    loaded.template = template
  }
})
await check('owner Explore stays public, including personalized ordering', async () => {
  interests = ['fantasy']
  try {
    assertPublic((await templateController.listPublished({ user: owner, query: {} })).templates[0])
  } finally {
    interests = []
  }
})
await check('projection preserves missing legacy fields without mutating its source', () => {
  const legacy = { _id: fixture._id, title: fixture.title, seed_prompt: fixture.seed_prompt }
  const before = { ...legacy }
  assert.deepEqual(publicTemplate(legacy), { _id: fixture._id, title: fixture.title })
  assert.deepEqual(legacy, before)
  assert.equal(publicTemplate(fixture).creator_id, fixture.creator_id)
  assert.deepEqual(stored, fixture)
})
await check('anonymous and other users never pass the authoring decision', () => {
  assert.equal(canReadTemplateAuthoring(fixture, null), false)
  assert.equal(canReadTemplateAuthoring(fixture, stranger), false)
  assert.equal(canReadTemplateAuthoring(fixture, owner), true)
  assert.equal(canReadTemplateAuthoring({ creator_id: owner.id as unknown as ObjectId }, owner), true)
  assert.equal(canReadTemplateAuthoring(fixture, { ...stranger, tier: 'admin' } as AuthUser), false)
})
await check('unpublished, private, pending and hidden worlds retain their access gate', async () => {
  for (const patch of [
    { is_published: false }, { visibility: 'private' as const },
    { review_status: 'pending' as const }, { moderation_status: 'hidden' as const },
  ]) {
    stored = { ...fixture, ...patch }
    try {
      for (const user of [null, stranger]) {
        await assert.rejects(templateController.getById({ params, user }),
          (error) => error instanceof HttpError && error.statusCode === 404)
      }
      assert.deepEqual(await templateController.getById({ params, user: owner }), stored)
    } finally {
      stored = fixture
    }
  }
})
await check('mine/list still rejects anonymous requests', async () => {
  await assert.rejects(templateController.listMine({ user: null, query: {} }),
    (error) => error instanceof HttpError && error.statusCode === 401)
})

console.log(`template-privacy audit: ${passed}/${passed + failed} passed`)
if (process.argv.includes('--sample')) {
  console.log(JSON.stringify((await templateController.listPublished({ user: null, query: {} })).templates[0], null, 2))
}
process.exit(failed === 0 ? 0 : 1)
