/**
 * Starter choices audit: the four-card pick a new player chooses from.
 *
 * Pure: an in-memory Mongo stands in for the database, no environment file is
 * loaded and nothing opens a socket or calls a model. The real route, auth
 * plugin, discovery gate and service run.
 *
 * Checks the contract in everlore-docs/phases/onboarding.md §4:
 *   - four results come from four different shelves when four shelves exist;
 *   - with two shelves only, results still reach `count`;
 *   - the order is stable per player and exclude list, and differs per player;
 *   - `exclude` and already-saved templates never appear;
 *   - non-starters, groups, hidden and blocked worlds never appear;
 *   - `count` and `exclude` validation is a 400, and 401 without a user;
 *   - `/templates/starter` still answers exactly as before.
 */
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'
import { SignJWT } from 'jose'

type Row = Record<string, unknown>

// ── An in-memory Mongo ───────────────────────────────────────────────────────
const users: Row[] = []
const worlds: Row[] = []
const instances: Row[] = []

function equal(a: unknown, b: unknown): boolean {
  if (a instanceof ObjectId && b instanceof ObjectId) return a.equals(b)
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return isDeepStrictEqual(a, b)
}

function matches(row: Row, query: Row): boolean {
  return Object.entries(query).every(([key, condition]) => {
    if (key === '$and') return (condition as Row[]).every((part) => matches(row, part))
    if (key === '$or') return (condition as Row[]).some((part) => matches(row, part))
    const value = row[key]
    if (condition === null) return value === null || value === undefined
    if (condition && typeof condition === 'object' && !Array.isArray(condition) &&
      !(condition instanceof ObjectId) && !(condition instanceof Date)) {
      const expression = condition as Row
      if ('$exists' in expression) return (value !== undefined) === expression.$exists
      if ('$ne' in expression) return !equal(value, expression.$ne)
      if ('$in' in expression) return (expression.$in as unknown[]).some((item) => equal(value, item))
      if ('$nin' in expression) return !(expression.$nin as unknown[]).some((item) => equal(value, item))
      if ('$lt' in expression) {
        const bound = expression.$lt
        if (value instanceof Date && bound instanceof Date) return value.getTime() < bound.getTime()
        return Number(value) < Number(bound)
      }
    }
    return equal(value, condition)
  })
}

function cursor(rows: Row[]) {
  return {
    sort: () => cursor(rows),
    skip: () => cursor(rows),
    limit: () => cursor(rows),
    project: () => cursor(rows),
    toArray: async () => [...rows],
  }
}

function collection(rows: Row[]) {
  return {
    find: (query: Row = {}) => cursor(rows.filter((row) => matches(row, query))),
    findOne: async (query: Row) => rows.find((row) => matches(row, query)) ?? null,
    countDocuments: async (query: Row = {}) => rows.filter((row) => matches(row, query)).length,
    insertOne: async (doc: Row) => { rows.push(doc); return { insertedId: doc._id } },
    insertMany: async (docs: Row[]) => { rows.push(...docs); return { insertedCount: docs.length } },
    updateOne: async (query: Row, update: { $set?: Row }) => {
      const row = rows.find((entry) => matches(entry, query))
      if (!row) return { matchedCount: 0 }
      Object.assign(row, update.$set)
      return { matchedCount: 1 }
    },
  }
}

mock.module('../src/config/mongo', () => ({
  mongoColl: {
    users: () => collection(users),
    worldTemplates: () => collection(worlds),
    worldInstances: () => collection(instances),
  },
}))
let guestLeases = 0
const redisClient = {
  eval: async () => 1,
  zrem: async () => { guestLeases++; return 1 },
}
mock.module('../src/config/redis', () => ({
  getRedisClient: () => redisClient,
  getQueueRedisClient: () => redisClient,
  getRedisSubscriber: () => redisClient,
  connectRedis: async () => {},
  getRedisProcess: () => undefined,
  onRedisProcessReady: () => () => {},
  cacheRedisProcess: () => {},
}))

const { Elysia, ValidationError } = await import('elysia')
const { templateRoutes } = await import('../src/routes/template.routes')
const { HttpError } = await import('../src/utils/http-error')
const { VALIDATION_MESSAGE } = await import('../src/utils/validation-response')
const { env } = await import('../src/config/env')

const app = new Elysia()
  .onError(({ error, code, set }) => {
    if (error instanceof HttpError) {
      set.status = error.statusCode
      return { error: error.message, ...(error.details || {}) }
    }
    if (error instanceof ValidationError) {
      set.status = error.status
      return { error: VALIDATION_MESSAGE }
    }
    if (code === 'VALIDATION') {
      set.status = 422
      return { error: VALIDATION_MESSAGE }
    }
  })
  .use(templateRoutes)

// ── Fixtures ─────────────────────────────────────────────────────────────────
const creator = new ObjectId()
const day = (dayOfMonth: number) => new Date(Date.UTC(2026, 9, dayOfMonth))
let idCounter = 0
function id(): ObjectId {
  idCounter++
  return new ObjectId(idCounter.toString(16).padStart(24, '0'))
}

function world(overrides: Row): Row {
  return {
    _id: id(),
    creator_id: creator,
    title: 'Fixture',
    slug: `fixture-${idCounter}`,
    description: 'An authored fixture.',
    image_url: 'https://fixture.invalid/cover.webp',
    kind: 'world',
    starter: true,
    is_published: true,
    visibility: 'public',
    review_status: 'approved',
    is_sentient: false,
    is_nsfw_capable: false,
    version: 1,
    narrative_style: 'epic_fantasy',
    genre: 'epic',
    seed_prompt: 'Private fixture instructions.',
    global_lore: 'A public fixture setting.',
    base_stats_template: {},
    flag_definitions: {},
    scene_tags: [],
    model_preferences: {},
    max_context_memories: 25,
    max_lore_results: 10,
    created_at: day(1),
    updated_at: day(1),
    ...overrides,
  }
}

const player = new ObjectId()
const guest = new ObjectId()
const otherPlayer = new ObjectId()

function seedPlayer(target: ObjectId, overrides: Row = {}) {
  users.push({ _id: target, tier: 'creator', preferences: { interests: [] }, ...overrides })
}

const sign = (target: ObjectId) => new SignJWT({ id: target.toHexString(), tier: 'creator' })
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('5m')
  .sign(new TextEncoder().encode(env.JWT_SECRET))

seedPlayer(player)
seedPlayer(guest, { tier: 'free', guest: true })
seedPlayer(otherPlayer)

const playerToken = await sign(player)
const guestToken = await sign(guest)
const otherToken = await sign(otherPlayer)

async function get(path: string, bearer: string | null = playerToken) {
  const response = await app.handle(new Request(`http://localhost${path}`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  }))
  // A broken route may answer with a non-JSON body; report the status plainly
  // rather than dying in the parser.
  const body = await response.json().catch(() => ({ error: '(non-JSON body)' })) as Row
  return { status: response.status, body }
}

async function choices(query = '', bearer: string | null = playerToken) {
  const result = await get(`/templates/starter-choices${query}`, bearer)
  assert.equal(result.status, 200, `GET /starter-choices${query} -> ${result.status}`)
  assert.deepEqual(Object.keys(result.body), ['templates'])
  return result.body.templates as Row[]
}

const ids = (rows: Row[]) => rows.map((row) => String(row._id))
const shelvesOf = (rows: Row[]) => rows.map((row) => row.genre ?? '(none)')

function reset(worldsToAdd: Row[] = [], savedTemplateIds: ObjectId[] = []) {
  worlds.length = 0
  instances.length = 0
  worlds.push(...worldsToAdd)
  for (const templateId of savedTemplateIds) instances.push({ _id: new ObjectId(), player_id: player, template_id: templateId })
}

let passed = 0
let failed = 0
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7)
async function check(name: string, run: () => Promise<void> | void) {
  if (only && only !== name) return
  try {
    await run()
    console.log(`  PASS ${name}`)
    passed++
  } catch (error) {
    console.error(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
    failed++
  }
}

// ── 1. Four shelves, four cards ──────────────────────────────────────────────
await check('four results come from four different shelves when four shelves have candidates', async () => {
  reset([
    world({ genre: 'romance', narrative_style: 'flirty' }),
    world({ genre: 'romance', narrative_style: 'dark_romance' }),
    world({ genre: 'epic', narrative_style: 'epic_fantasy' }),
    world({ genre: 'epic', narrative_style: 'shonen' }),
    world({ genre: 'dark', narrative_style: 'grimdark' }),
    world({ genre: 'horror', narrative_style: 'horror' }),
    world({ genre: 'cozy', narrative_style: 'cozy_comfort' }),
  ])
  const cards = await choices('?count=4')
  assert.equal(cards.length, 4)
  assert.equal(new Set(shelvesOf(cards)).size, 4, `shelves: ${shelvesOf(cards).join(',')}`)
})

await check('a template with no genre is its own shelf, counted once', async () => {
  const noGenre = world({})
  delete noGenre.genre
  const second = world({})
  delete second.genre
  reset([
    world({ genre: 'romance', narrative_style: 'flirty' }),
    world({ genre: 'epic', narrative_style: 'epic_fantasy' }),
    world({ genre: 'dark', narrative_style: 'grimdark' }),
    noGenre,
    second,
  ])
  const cards = await choices('?count=4')
  assert.equal(cards.length, 4)
  assert.equal(new Set(shelvesOf(cards)).size, 4, `shelves: ${shelvesOf(cards).join(',')}`)
  // Only one absent-genre card: the other is a leftover, not a second shelf.
  assert.equal(shelvesOf(cards).filter((shelf) => shelf === '(none)').length, 1)
})

// ── 2. Two shelves still fill to count ───────────────────────────────────────
await check('with two shelves only, results still reach count (fill after one-per-shelf)', async () => {
  reset([
    world({ genre: 'romance', narrative_style: 'flirty' }),
    world({ genre: 'romance', narrative_style: 'dark_romance' }),
    world({ genre: 'romance', narrative_style: 'flirty' }),
    world({ genre: 'epic', narrative_style: 'epic_fantasy' }),
    world({ genre: 'epic', narrative_style: 'shonen' }),
    world({ genre: 'epic', narrative_style: 'epic_fantasy' }),
  ])
  const cards = await choices('?count=4')
  assert.equal(cards.length, 4)
  // The first two are one per shelf; the rest fill from what remains.
  const shelves = shelvesOf(cards)
  assert.equal(new Set(shelves.slice(0, 2)).size, 2, `first two shelves: ${shelves.slice(0, 2).join(',')}`)
  assert.equal(new Set(shelves).size, 2)
})

await check('fewer candidates than count returns what there is, and none is an empty list', async () => {
  reset([world({ genre: 'romance' }), world({ genre: 'epic' })])
  assert.equal((await choices('?count=8')).length, 2)
  reset([])
  assert.deepEqual(await choices(''), [])
})

// ── 3. Deterministic per player, different across players ────────────────────
function twelve(): Row[] {
  const rows: Row[] = []
  const shelves = [
    ['romance', 'flirty'], ['romance', 'dark_romance'],
    ['epic', 'epic_fantasy'], ['epic', 'shonen'],
    ['dark', 'grimdark'], ['dark', 'gothic'],
    ['horror', 'horror'], ['horror', 'cosmic_horror'],
    ['cozy', 'cozy_comfort'], ['cozy', 'slice_of_life'],
    ['modern', 'modern_drama'], ['modern', 'noir'],
  ] as const
  for (const [genre, voice] of shelves) rows.push(world({ genre, narrative_style: voice }))
  return rows
}

await check('same player and exclude give identical order; exclude order does not matter', async () => {
  reset(twelve())
  const first = await choices('?count=8')
  const again = await choices('?count=8')
  assert.deepEqual(ids(first), ids(again))

  const all = ids(worlds)
  const a = await choices(`?count=8&exclude=${all[0]},${all[1]}`)
  const b = await choices(`?count=8&exclude=${all[1]},${all[0]}`)
  assert.deepEqual(ids(a), ids(b), 'the exclude list is a set, not an order')
})

await check('two different players get a different order for a fixture with enough candidates', async () => {
  reset(twelve())
  const mine = await choices('?count=8')
  const theirs = await choices('?count=8', otherToken)
  assert.notDeepEqual(ids(mine), ids(theirs))
})

// ── 4. Exclude and saved templates never appear ──────────────────────────────
await check('exclude and already-saved templates never appear', async () => {
  const rows = twelve()
  const savedIds = [rows[0]._id as ObjectId, rows[1]._id as ObjectId]
  const excluded = [rows[2]._id as ObjectId, rows[3]._id as ObjectId]
  reset(rows, savedIds)
  const saved = new Set(savedIds.map(String))
  const excludedSet = new Set(excluded.map(String))
  const cards = await choices(`?count=8&exclude=${excluded.map((id) => id.toHexString()).join(',')}`)
  for (const card of cards) {
    assert.equal(saved.has(String(card._id)), false, `saved ${card._id} appeared`)
    assert.equal(excludedSet.has(String(card._id)), false, `excluded ${card._id} appeared`)
  }
  // Twelve candidates, two saved and two excluded leave eight, and count=8 asks for all of them.
  assert.equal(cards.length, 8)
})

await check('a blocked template stays blocked even when a different template is excluded', async () => {
  const blocked = world({ genre: 'romance' })
  const shown = world({ genre: 'epic' })
  const third = world({ genre: 'dark' })
  reset([blocked, shown, third])
  const other = users.find((user) => user._id instanceof ObjectId && (user._id as ObjectId).equals(otherPlayer))!
  other.blocked_template_ids = [blocked._id as ObjectId]
  try {
    // Exclude a template that is not the blocked one: the merge must keep both
    // the block's `$nin` and the exclude's `$nin`, or the block is resurrected.
    const cards = await choices(`?exclude=${(shown._id as ObjectId).toHexString()}`, otherToken)
    const returned = ids(cards)
    assert.equal(returned.includes(String(blocked._id)), false, 'a block was clobbered by the exclude')
    assert.equal(returned.includes(String(shown._id)), false, 'the excluded template appeared')
    assert.deepEqual(returned, [String(third._id)])
  } finally {
    delete other.blocked_template_ids
  }
})

// ── 5. Discovery gate ────────────────────────────────────────────────────────
await check('non-starters, groups, hidden, pending and blocked worlds never appear', async () => {
  const nonStarter = world({ genre: 'romance' })
  delete nonStarter.starter
  const group = world({ genre: 'cozy', kind: 'group' })
  const hidden = world({ genre: 'horror', moderation_status: 'hidden' })
  const pending = world({ genre: 'dark', review_status: 'pending' })
  const blockedTemplate = world({ genre: 'modern' })
  const blockedCreator = world({ genre: 'epic', creator_id: new ObjectId() })
  const eligible = world({ genre: 'epic' })
  reset([nonStarter, group, hidden, pending, blockedTemplate, blockedCreator, eligible])
  const row = users.find((user) => user._id instanceof ObjectId && (user._id as ObjectId).equals(player))!
  row.blocked_template_ids = [blockedTemplate._id as ObjectId]
  row.blocked_user_ids = [blockedCreator.creator_id as ObjectId]
  try {
    const cards = await choices('?count=8')
    assert.deepEqual(ids(cards), [String(eligible._id)])
  } finally {
    delete row.blocked_template_ids
    delete row.blocked_user_ids
  }
})

// ── 6. Validation and auth ───────────────────────────────────────────────────
await check('count and exclude validation are 400s, and no user is a 401', async () => {
  reset(twelve())
  for (const query of ['?count=0', '?count=9', '?count=abc', '?count=1.5', '?count=-1', '?count=', '?exclude=not-an-id', '?exclude=123']) {
    const result = await get(`/templates/starter-choices${query}`)
    assert.equal(result.status, 400, `GET /starter-choices${query} -> ${result.status}`)
    assert.equal(typeof result.body.error, 'string', 'a plain message')
  }
  // Absent, 1 and the maximum are all accepted.
  for (const count of ['1', '8']) {
    const result = await get(`/templates/starter-choices?count=${count}`)
    assert.equal(result.status, 200, `count=${count}`)
    assert.equal((result.body.templates as Row[]).length, Number(count))
  }
  // 401 before any query is parsed, exactly like /starter.
  for (const query of ['', '?count=4', '?count=999']) {
    const result = await get(`/templates/starter-choices${query}`, null)
    assert.equal(result.status, 401, `unauthenticated${query}`)
  }
  assert.equal((await get('/templates/starter', null)).status, 401)
})

await check('a guest token is accepted like /starter', async () => {
  reset(twelve())
  const before = guestLeases
  const cards = await choices('?count=4', guestToken)
  assert.equal(cards.length, 4)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(guestLeases, before + 1, 'the guest lease was taken and released')
})

// ── 7. /starter is untouched ─────────────────────────────────────────────────
await check('/templates/starter still returns what it returned before', async () => {
  // The newest eligible starter wins with no interests, exactly as before.
  const older = world({ genre: 'romance', created_at: day(2) })
  const newest = world({ genre: 'epic', created_at: day(5) })
  reset([older, newest])
  const pick = await get('/templates/starter')
  assert.equal(pick.status, 200)
  assert.deepEqual(Object.keys(pick.body), ['template'])
  assert.equal(String((pick.body.template as Row)._id), String(newest._id))
  assert.equal(Object.hasOwn(pick.body.template as Row, 'starter'), false, 'the projection still hides starter')

  // Exact-voice ranking still leads when interests are set.
  reset([world({ genre: 'romance', narrative_style: 'dark_romance', created_at: day(5) }), world({ genre: 'epic', narrative_style: 'flirty', created_at: day(2) })])
  users.find((user) => user._id instanceof ObjectId && (user._id as ObjectId).equals(player))!.preferences = { interests: ['flirty'] }
  const ranked = await get('/templates/starter')
  assert.equal(String((ranked.body.template as Row)._id), String(worlds[1]._id))
  users.find((user) => user._id instanceof ObjectId && (user._id as ObjectId).equals(player))!.preferences = { interests: [] }

  // The new route did not steal /starter's path: it still answers with one template.
  const viaChoicesPath = await get('/templates/starter-choices?count=1')
  assert.equal(viaChoicesPath.status, 200)
  assert.equal(Array.isArray(viaChoicesPath.body.templates), true)
})

// ── 8. The public projection ─────────────────────────────────────────────────
await check('each card is a public template, never an authoring one', async () => {
  reset(twelve())
  const cards = await choices('?count=4')
  for (const card of cards) {
    for (const key of ['starter', 'seed_prompt', 'model_preferences', 'flag_definitions']) {
      assert.equal(Object.hasOwn(card, key), false, `card leaked ${key}`)
    }
    for (const key of ['_id', 'title', 'genre', 'image_url', 'description']) {
      assert(Object.hasOwn(card, key), `card is missing ${key}`)
    }
  }
  // Empty is an empty list, never a 404 or a null.
  reset([])
  assert.deepEqual(await choices(''), [])
})

assert(passed > 0, `Unknown check: ${only}`)
console.log(`starter-choices audit: ${passed}/${passed + failed} passed (in-memory Mongo; real route, auth, discovery and service; no environment file or paid calls)`)
process.exit(failed === 0 ? 0 : 1)
