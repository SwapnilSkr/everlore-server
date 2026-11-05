/**
 * Pure audit: the in-app bell (group-chat.md, "In-app notifications").
 *
 * The real service, routes and both purge paths run against in-memory
 * collections and a recording Redis. No Mongo/Redis clients, network transport,
 * timers or paid models are started.
 *
 * Covered: the exact words with no chat text; another player's GET and read see
 * or change nothing; paging and the unread count; the 100-row cap; both purge
 * paths; the frame reaching only its owner; read on open; a record failure
 * never failing the send; and updatePreferences refusing an unknown key. Every
 * check is shown to bite by a reversible source mutation (see the task report).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mock } from 'bun:test'
import { Elysia } from 'elysia'
import { MongoServerError, ObjectId } from 'mongodb'

type Row = Record<string, unknown>

// ── in-memory Mongo ────────────────────────────────────────────────────────
const tables = new Map<string, Row[]>()
const rows = (name: string) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name)! }
/** Accessor names (`playerNotifications`) and collection names share one table. */
const tableName = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

const get = (row: Row, path: string): unknown => {
  let value: unknown = row
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object') return undefined
    value = (value as Row)[key]
  }
  return value
}
function put(row: Row, path: string, value: unknown) {
  const keys = path.split('.'); let current = row
  for (const key of keys.slice(0, -1)) { current[key] ??= {}; current = current[key] as Row }
  current[keys.at(-1)!] = value
}
const eq = (a: unknown, b: unknown) => a instanceof Date && b instanceof Date ? a.getTime() === b.getTime()
  : a instanceof ObjectId && b instanceof ObjectId ? a.equals(b) : a === b
const orderValue = (value: unknown) => value instanceof ObjectId ? value.toHexString() : value as number

function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$and') return (expected as Row[]).every(clause => matches(row, clause))
    if (key === '$or') return (expected as Row[]).some(clause => matches(row, clause))
    const value = get(row, key)
    if (expected && typeof expected === 'object' && !(expected instanceof ObjectId) && !(expected instanceof Date) && !Array.isArray(expected)) {
      return Object.entries(expected).every(([op, other]) => {
        if (op === '$exists') return (value !== undefined) === other
        if (op === '$in') return (other as unknown[]).some(entry => Array.isArray(value) ? value.some(item => eq(item, entry)) : eq(value, entry))
        if (op === '$lt') return (orderValue(value) as string) < (orderValue(other) as string)
        if (op === '$gt') return (orderValue(value) as string) > (orderValue(other) as string)
        if (op === '$ne') return !eq(value, other)
        throw new Error(`Unsupported audit operator ${op}`)
      })
    }
    return Array.isArray(value) ? value.some(item => eq(item, expected)) : eq(value, expected)
  })
}

const clone = <T>(input: T): T => {
  if (!input || typeof input !== 'object' || input instanceof Date || input instanceof ObjectId) return input
  if (Array.isArray(input)) return input.map(clone) as T
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, clone(value)])) as T
}

/** Only the bell's own insert can be made to fail, for the "never fails the send" check. */
let notificationInsertError: Error | undefined

function collection(name: string) {
  return {
    find(filter: Row = {}, options?: { projection?: Record<string, number> }) {
      let values = rows(name).filter(row => matches(row, filter))
      const cursor = {
        sort(order: Record<string, number>) {
          values.sort((a, b) => {
            for (const [key, dir] of Object.entries(order)) {
              const left = orderValue(get(a, key)), right = orderValue(get(b, key))
              if (left !== right) return (left < right ? -1 : 1) * dir
            }
            return 0
          })
          return cursor
        },
        limit(count: number) { values = values.slice(0, count); return cursor },
        project(fields: Record<string, number>) {
          values = values.map(value => Object.fromEntries(Object.entries(fields)
            .filter(([, include]) => include && get(value, Object.keys(fields)[0]) !== undefined)
            .map(([key]) => [key, clone(get(value, key))])))
          return cursor
        },

        async toArray() {
          if (!options?.projection) return clone(values)
          return values.map(value => Object.fromEntries(Object.entries(options.projection!)
            .filter(([, include]) => include).map(([key]) => [key, clone(get(value, key))])))
        },
      }
      return cursor
    },
    async findOne(filter: Row) { return (await this.find(filter).toArray())[0] ?? null },
    async countDocuments(filter: Row) { return rows(name).filter(row => matches(row, filter)).length },
    async insertOne(row: Row) {
      if (name === 'player_notifications' && notificationInsertError) throw notificationInsertError
      if (rows(name).some(existing => eq(existing._id, row._id))) {
        throw new MongoServerError({ code: 11000, message: 'Simulated duplicate _id' })
      }
      rows(name).push(clone(row))
      return { insertedId: row._id }
    },
    async updateOne(filter: Row, update: Row) {
      const row = rows(name).find(row => matches(row, filter))
      if (!row) return { matchedCount: 0, modifiedCount: 0 }
      for (const [key, value] of Object.entries((update.$set || {}) as Row)) put(row, key, clone(value))
      return { matchedCount: 1, modifiedCount: 1 }
    },
    async updateMany(filter: Row, update: Row) {
      let modifiedCount = 0
      for (const row of rows(name).filter(row => matches(row, filter))) {
        for (const [key, value] of Object.entries((update.$set || {}) as Row)) put(row, key, clone(value))
        modifiedCount++
      }
      return { modifiedCount }
    },
    async deleteMany(filter: Row) {
      const list = rows(name), kept = list.filter(row => !matches(row, filter))
      const deletedCount = list.length - kept.length
      list.splice(0, list.length, ...kept)
      return { deletedCount }
    },
  }
}

const published: Array<{ channel: string; frame: Row }> = []
const redis = {
  async publish(channel: string, text: string) { published.push({ channel, frame: JSON.parse(text) }); return 1 },
  async get() { return null },
  async set() { return 'OK' },
  async del() { return 1 },
}
const unavailable = (): never => { throw new Error('Unexpected external dependency in notifications audit') }
globalThis.fetch = Object.assign(async () => unavailable(), { preconnect: unavailable })

const warnLogs: Array<{ name: string; data: Row }> = []
const mocks: Array<[string, () => unknown]> = [
  ['../src/config/env', () => ({ env: { CDN_BASE_URL: 'https://fixture.invalid', GROUP_NOTIFICATIONS_ENABLED: false,
    FCM_SERVICE_ACCOUNT_JSON: '', JWT_SECRET: 'audit-only' } })],
  ['../src/config/mongo', () => ({
    mongoColl: new Proxy({}, { get: (_target, key) => () => collection(tableName(String(key))) }),
    coll: (name: string) => collection(name),
  })],
  ['../src/config/redis', () => ({ getRedisClient: () => redis, getRedisSubscriber: () => redis, getQueueRedisClient: unavailable })],
  ['../src/utils/logger', () => ({ log: {
    info: () => {}, error: () => {},
    warn: (name: string, data: Row = {}) => { warnLogs.push({ name, data }) },
  } })],
  // Portrait placement has its own audit; here only its URL matters.
  ['../src/services/media/portraits', () => ({
    portraitUrl: (assetKey: string) => `https://fixture.invalid/${assetKey}`,
    resolvePortraitHolder: async () => ({ kind: 'world_cast', appearance: 'a face', appearanceVersion: 1,
      portrait: { asset_key: 'cast/face.png', source: 'generated', appearance_version: 1, painted_at: new Date() } }),
  })],
  ['../src/services/media/attribution', () => ({ ATTRIBUTION_RULE_VERSION: 'audit',
    mediaRevision: (prose: string, input = '') => createHash('sha256').update(JSON.stringify([prose, input])).digest('hex'),
    attributeEvent: unavailable, resolveAttributedSpeaker: unavailable })],
  ['../src/services/character-codex.service', () => ({ characterCodexService: { seedProtagonist: async () => {} },
    identityKey: (text: string) => text.trim().toLowerCase(), newFoldState: () => ({ byName: new Map() }) })],
  ['../src/services/template-cast.service', () => ({ materializeTemplateCast: async () => 0 })],
  ['../src/services/opening-place.service', () => ({ extractOpeningPlace: async () => undefined })],
  ['../src/services/kinship-graph.service', () => ({ kinshipGraphService: { seedPremiseKinship: async () => {} } })],
  ['../src/services/vector-store', () => ({ vectorStore: { deleteScope: async () => {}, deleteIds: async () => {} } })],
  ['../src/queues', () => ({ removeQueuedJobsForInstance: async () => {}, getMediaQueue: unavailable,
    getMemoryCurationQueue: unavailable, getGenerationQueue: unavailable, getSceneSummaryQueue: unavailable })],
  ['../src/services/storage.service', () => ({ storageService: { deleteStrict: async () => {}, delete: async () => {},
    upload: async () => ({ key: '', url: '' }), keyFromUrl: () => undefined } })],
  ['../src/services/telemetry/ingest.service', () => ({ telemetryService: { purgeUser: async () => {} } })],
  ['../src/services/time.service', () => ({ timeService: {} })],
  ['../src/services/llm-trace.service', () => ({ traceStore: () => ({ calls: collection('llm_calls'), bodies: collection('llm_call_bodies') }) })],
  ['../src/constants/default-cover', () => ({ isDefaultCoverUrl: () => false })],
  ['../src/ai', () => ({ AI_MODELS: {}, callLLMWithFallback: unavailable, generateImage: unavailable })],
  ['../src/config/openai', () => ({ getOpenRouter: unavailable, getOpenAI: unavailable })],
  ['../src/providers/rag.provider', () => ({ queryRag: async () => ({ memoryTexts: [], openThreads: [] }), querySummaries: async () => [] })],
  ['../src/services/post-process-outbox.service', () => ({ stagePostProcess: async () => {}, dispatchPostProcessOutbox: async () => 0 })],
]
for (const [path, factory] of mocks) mock.module(path, factory)

let routeUser: { id: string; tier: string } | null = null
mock.module('../src/middleware/auth', () => ({
  authPlugin: new Elysia().derive({ as: 'scoped' }, () => ({ user: routeUser })),
  verifyWsToken: unavailable,
}))

const { recordNotification, recordDirectMessage, recordSelfieReady, recordFilmReady,
  markThreadRead, notificationWords, NOTIFICATIONS_MAX_PER_PLAYER } = await import('../src/services/notifications.service')
const { deletionService } = await import('../src/services/deletion.service')
const { purgeAccountReferences } = await import('../src/services/account-references')
const { authService, PREFERENCE_UPDATE_KEYS } = await import('../src/services/auth.service')
const { UpdatePreferencesBody } = await import('../src/schemas/user.schema')
const { notificationRoutes } = await import('../src/routes/notifications.routes')

// ── harness ────────────────────────────────────────────────────────────────
let passed = 0, failed = 0
async function check(label: string, fn: () => unknown) {
  try { await fn(); passed++; console.log(`PASS ${label}`) }
  catch (error) { failed++; console.log(`FAIL ${label}: ${(error as Error).message}`) }
}
const objectId = (n: number) => new ObjectId(n.toString(16).padStart(24, '0'))
const player = (n: number) => objectId(0x100 + n).toHexString()
const hex = (id: ObjectId) => id.toHexString()
const asRowId = (value: unknown) => hex(value as ObjectId)

function seedInstance(id: ObjectId, playerId: string) {
  rows('world_instances').push({ _id: id, player_id: new ObjectId(playerId), template_id: objectId(900) })
}
function seedCard(id: ObjectId, instanceId: ObjectId, name: string) {
  rows('characters').push({ _id: id, instance_id: instanceId, canonical_name: name })
}
function reset() { tables.clear(); published.length = 0; warnLogs.length = 0; notificationInsertError = undefined }

const app = new Elysia().onError(({ error, set }) => {
  set.status = 'statusCode' in error ? Number(error.statusCode) : 500
  return { error: error.message }
}).use(notificationRoutes)
const http = async (path: string, body?: unknown) => {
  const response = await app.handle(new Request(`http://localhost${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
  return { status: response.status, body: await response.json().catch(() => null) as Row | null }
}
const asPlayer = (playerId: string | null) => { routeUser = playerId ? { id: playerId, tier: 'creator' } : null }

const STORED_KEYS = ['_id', 'player_id', 'type', 'instance_id', 'character_id', 'title', 'body', 'image_url', 'created_at']
const ITEM_KEYS = ['id', 'type', 'instance_id', 'character_id', 'title', 'body', 'image_url', 'created_at', 'read_at']
const REQUIRED_ITEM_KEYS = ['id', 'type', 'instance_id', 'title', 'body', 'created_at']

// ── (1) the exact words, and no chat text ──────────────────────────────────
await check('a direct message row carries the contract words and no chat text', async () => {
  reset()
  const playerId = player(1), instanceId = objectId(10), characterId = objectId(20)
  seedInstance(instanceId, playerId); seedCard(characterId, instanceId, 'Bea')
  await recordDirectMessage({ playerId, instanceId: hex(instanceId), characterId: hex(characterId), name: 'Bea' })
  const [row] = rows('player_notifications')
  assert.equal(row.type, 'group_direct')
  assert.equal(row.title, 'Bea'); assert.equal(row.body, 'Bea sent you a message')
  assert.equal(asRowId(row.player_id), playerId)
  assert.equal(asRowId(row.instance_id), hex(instanceId))
  assert.equal(row.character_id, hex(characterId))
  assert.equal(row.image_url, 'https://fixture.invalid/cast/face.png')
  assert.ok(row.created_at instanceof Date)
  assert.ok(!('read_at' in row), 'a new row is unread')
  assert.deepEqual(Object.keys(row).sort(), STORED_KEYS.sort())
  assert.deepEqual(notificationWords('group_direct', 'Bea'), { title: 'Bea', body: 'Bea sent you a message' })
})
await check('a selfie row says a picture arrived, and only an untapped one is news', async () => {
  reset()
  const playerId = player(2), instanceId = objectId(11), characterId = objectId(21)
  seedInstance(instanceId, playerId); seedCard(characterId, instanceId, 'Wren')
  const pending = (id: ObjectId, extra: Row = {}) => rows('media_assets').push({ _id: id, kind: 'picture', group_selfie: true,
    player_id: new ObjectId(playerId), instance_id: instanceId, character_id: characterId,
    url: 'https://fixture.invalid/selfie.png', ...extra })
  pending(objectId(30), { tapped: true })
  await recordSelfieReady(hex(objectId(30)))
  assert.equal(rows('player_notifications').length, 0, 'a tapped selfie is the player already watching for it')
  pending(objectId(31))
  await recordSelfieReady(hex(objectId(31)))
  const [row] = rows('player_notifications')
  assert.equal(row.title, 'Wren'); assert.equal(row.body, 'Wren sent you a picture')
  assert.equal(row.type, 'group_selfie')
  // The bell never shows the picture itself: only a face or a cover may ride here.
  assert.equal(row.image_url, 'https://fixture.invalid/cast/face.png')
  // The notified_at stamp keeps a repair pass from repeating a row.
  rows('media_assets').find(asset => (asset._id as ObjectId).equals(objectId(31)))!.notified_at = new Date()
  await recordSelfieReady(hex(objectId(31)))
  assert.equal(rows('player_notifications').length, 1)
})
await check('a film row uses the film cover and its own words', async () => {
  reset()
  const playerId = player(3), instanceId = objectId(12)
  rows('media_assets').push({ _id: objectId(40), kind: 'video', player_id: new ObjectId(playerId), instance_id: instanceId,
    poster_url: 'https://fixture.invalid/film-cover.jpg' })
  await recordFilmReady(hex(objectId(40)))
  const [row] = rows('player_notifications')
  assert.equal(row.type, 'film_ready'); assert.equal(row.title, 'Your film is ready'); assert.equal(row.body, 'Your film is ready')
  assert.equal(row.image_url, 'https://fixture.invalid/film-cover.jpg')
  assert.ok(!('character_id' in row), 'optional keys are omitted, never null')
  assert.deepEqual(notificationWords('film_ready'), { title: 'Your film is ready', body: 'Your film is ready' })
})
await check('no row ever carries chat text: the service cannot read prose', () => {
  const source = readFileSync('src/services/notifications.service.ts', 'utf8')
  for (const forbidden of ['ai_response', 'player_input', 'spoken_lines', 'data.lines', 'lines', 'memory', 'topics']) {
    assert.ok(!source.includes(forbidden), `notifications.service.ts must not read ${forbidden}`)
  }
  assert.ok(!/\b(world|place)\s*:\s*['"]/i.test(source), 'no world or place may be named in code')
})

// ── (2) another player sees and changes nothing ────────────────────────────
await check("another player's GET and read see or change nothing", async () => {
  reset()
  const owner = player(4), stranger = player(5), instanceId = objectId(13)
  await recordDirectMessage({ playerId: owner, instanceId: hex(instanceId), characterId: hex(objectId(22)), name: 'Ines' })
  const rowId = asRowId(rows('player_notifications')[0]._id)
  asPlayer(stranger)
  const listed = await http('/notifications')
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body!.items, []); assert.equal(listed.body!.unread, 0)
  const marked = await http('/notifications/read', { ids: [rowId] })
  assert.equal(marked.status, 200); assert.equal(marked.body!.unread, 0)
  assert.ok(!('read_at' in rows('player_notifications')[0]), "a stranger's read touches nothing")
  await http('/notifications/read', { all: true })
  assert.ok(!('read_at' in rows('player_notifications')[0]), 'a stranger cannot mark everything either')
  asPlayer(null)
  assert.equal((await http('/notifications')).status, 401)
  assert.equal((await http('/notifications/read', { ids: [rowId] })).status, 401)
})

// ── (3) paging and the unread count ────────────────────────────────────────
await check('paging is 30 at a time, newest first, with the whole unread count', async () => {
  reset()
  const playerId = player(6), instanceId = hex(objectId(14))
  for (let i = 1; i <= 35; i++) await recordNotification({ playerId, type: 'film_ready', instanceId })
  asPlayer(playerId)
  const first = await http('/notifications')
  assert.equal(first.status, 200); assert.equal(first.body!.items.length, 30); assert.equal(first.body!.unread, 35)
  const firstItems = first.body!.items as Array<Row>
  const firstIds = firstItems.map(item => item.id as string)
  assert.deepEqual(firstIds, [...firstIds].sort().reverse(), 'newest first')
  const second = await http(`/notifications?before=${firstIds.at(-1)}`)
  const secondItems = second.body!.items as Array<Row>
  assert.equal(secondItems.length, 5); assert.equal(second.body!.unread, 35)
  assert(!secondItems.some(item => firstIds.includes(item.id as string)), 'pages never overlap')
  const third = await http(`/notifications?before=${secondItems.at(-1)!.id}`)
  assert.deepEqual(third.body!.items, [])
  // The unread count covers every page, and marking rows read only lowers it.
  await http('/notifications/read', { ids: firstIds.slice(0, 2) })
  assert.equal((await http('/notifications')).body!.unread, 33)
  const item = (await http('/notifications')).body!.items[0] as Row
  assert.ok(Object.keys(item).every(key => ITEM_KEYS.includes(key)), `an item carries no other key: ${Object.keys(item).join()}`)
  for (const key of REQUIRED_ITEM_KEYS) assert.ok(key in item, `every item carries ${key}`)
  assert(!('player_id' in item), "the owner's id is never echoed in an item")
})
await check('bad cursors and bodies are a calm 400, never a crash', async () => {
  reset()
  asPlayer(player(7))
  for (const before of ['nope', '123', ' ', '0'.repeat(23)]) {
    const response = await http(`/notifications?before=${encodeURIComponent(before)}`)
    assert.equal(response.status, 400, `before=${before}`)
  }
  for (const body of ['[]', '"x"', 'null', '{}', '{"all":false}', '{"ids":"x"}', '{"ids":["nope"]}', '{"extra":true}',
    '{"all":true,"ids":[]}', JSON.stringify({ ids: Array.from({ length: 101 }, (_, i) => objectId(1 + i).toHexString()) })]) {
    const response = await http('/notifications/read', body)
    assert.equal(response.status, 400, `body=${body.slice(0, 40)}`)
  }
  assert.equal((await http('/notifications/read', { ids: Array.from({ length: 100 }, (_, i) => objectId(1 + i).toHexString()) })).status, 200,
    '100 ids is the cap, not over it')
  assert.equal((await http('/notifications/read', { ids: [] })).status, 200)
})

// ── (4) the 100 cap ────────────────────────────────────────────────────────
await check('at most 100 rows per player: the oldest go first, and only that player', async () => {
  reset()
  const playerId = player(8), other = player(9), instanceId = hex(objectId(15))
  const ids: string[] = []
  for (let i = 1; i <= 105; i++) {
    await recordNotification({ playerId, type: 'film_ready', instanceId })
    ids.push(asRowId(rows('player_notifications').at(-1)!._id))
  }
  await recordNotification({ playerId: other, type: 'film_ready', instanceId })
  const kept = rows('player_notifications').filter(row => asRowId(row.player_id) === playerId).map(row => asRowId(row._id))
  assert.equal(kept.length, NOTIFICATIONS_MAX_PER_PLAYER)
  assert.deepEqual(kept.sort(), ids.slice(5).sort(), 'the five oldest went, every other row stayed')
  assert.equal(rows('player_notifications').filter(row => asRowId(row.player_id) === other).length, 1)
})

// ── (5) both purge paths ───────────────────────────────────────────────────
await check('deleting a save removes its rows and leaves the others', async () => {
  reset()
  const playerId = player(10), instanceA = objectId(16), instanceB = objectId(17)
  for (const instance of [instanceA, instanceB]) await recordNotification({ playerId, type: 'film_ready', instanceId: hex(instance) })
  await deletionService.purgeInstancePayload(instanceA, hex(instanceA))
  const left = rows('player_notifications')
  assert.equal(left.length, 1)
  assert.equal(asRowId(left[0].instance_id), hex(instanceB))
})
await check('deleting the account removes its rows and leaves another player untouched', async () => {
  reset()
  const playerId = player(11), other = player(12), instanceId = hex(objectId(18))
  await recordNotification({ playerId, type: 'film_ready', instanceId })
  await recordNotification({ playerId: other, type: 'film_ready', instanceId })
  await purgeAccountReferences(new ObjectId(playerId), false)
  const left = rows('player_notifications')
  assert.equal(left.length, 1)
  assert.equal(asRowId(left[0].player_id), other)
})
await check('both purge paths name the collection in production code', () => {
  const save = readFileSync('src/services/deletion.service.ts', 'utf8')
  const account = readFileSync('src/services/account-references.ts', 'utf8')
  assert.ok(save.includes('playerNotifications().deleteMany({ instance_id: instanceId })'), 'the save purge names the collection')
  assert.ok(account.includes("'player_notifications'"), 'the account purge names the collection')
})

// ── (6) the frame goes only to the owner ───────────────────────────────────
await check('the live frame reaches only its owner, through the one send path', async () => {
  reset()
  const owner = player(13), other = player(14), instanceId = hex(objectId(19))
  await recordDirectMessage({ playerId: owner, instanceId, characterId: hex(objectId(23)), name: 'Nell' })
  await recordDirectMessage({ playerId: other, instanceId, characterId: hex(objectId(24)), name: 'Rook' })
  assert.equal(published.length, 2)
  assert.deepEqual(published.map(entry => entry.channel), [`user:${owner}:events`, `user:${other}:events`])
  for (const [index, ownerId] of [owner, other].entries()) {
    const frame = published[index].frame
    assert.equal(frame.type, 'notification')
    assert.equal(frame.unread, 1)
    assert.equal((frame.item as Row).id, asRowId(rows('player_notifications')[index]._id))
    assert.equal(asRowId(rows('player_notifications')[index].player_id), ownerId)
    assert.ok(!('player_id' in (frame.item as Row)))
  }
  assert.ok(!published.some(entry => entry.frame.item && (entry.frame.item as Row).title === 'Rook' && entry.channel === `user:${owner}:events`))
})

// ── (7) read on open ───────────────────────────────────────────────────────
await check('opening a direct thread reads that thread only, and twice is harmless', async () => {
  reset()
  const playerId = player(15), instanceId = objectId(20), bea = hex(objectId(25)), wren = hex(objectId(26))
  for (const characterId of [bea, wren]) {
    await recordNotification({ playerId, type: 'group_direct', instanceId: hex(instanceId), characterId, name: 'Someone' })
  }
  await markThreadRead({ playerId, instanceId: hex(instanceId), characterId: bea })
  const [beaRow, wrenRow] = rows('player_notifications')
  assert.ok(beaRow.read_at instanceof Date); assert.ok(!('read_at' in wrenRow), 'another thread stays unread')
  const stamp = (beaRow.read_at as Date).getTime()
  await markThreadRead({ playerId, instanceId: hex(instanceId), characterId: bea })
  assert.equal((beaRow.read_at as Date).getTime(), stamp, 'reading again changes nothing')
  await markThreadRead({ playerId: player(16), instanceId: hex(instanceId), characterId: wren })
  assert.ok(!('read_at' in wrenRow), "another player's open touches nothing")
})
await check('the open call marks its thread read, in the existing route, with push off too', () => {
  const source = readFileSync('src/services/group-chat/notifications.ts', 'utf8')
  const open = source.slice(source.indexOf('export async function openPendingDirect'))
  assert.ok(open.includes('await markThreadRead('), 'openPendingDirect clears the thread rows')
  assert.ok(open.indexOf('markThreadRead(') < open.indexOf("if (!env.GROUP_NOTIFICATIONS_ENABLED) return"),
    'read on open happens even when push is off')
})

// ── (8) a record failure never fails the send ──────────────────────────────
await check('a record failure never fails the message, picture or film', async () => {
  reset()
  const playerId = player(17), instanceId = objectId(21), characterId = objectId(27)
  seedInstance(instanceId, playerId); seedCard(characterId, instanceId, 'Ada')
  rows('media_assets').push({ _id: objectId(50), kind: 'video', player_id: new ObjectId(playerId), instance_id: instanceId })
  rows('media_assets').push({ _id: objectId(51), kind: 'picture', group_selfie: true, player_id: new ObjectId(playerId),
    instance_id: instanceId, character_id: characterId, url: 'https://fixture.invalid/selfie.png' })
  notificationInsertError = new Error('fixture bell write failed')
  await recordDirectMessage({ playerId, instanceId: hex(instanceId), characterId: hex(characterId), name: 'Ada' })
  await recordSelfieReady(hex(objectId(51)))
  await recordFilmReady(hex(objectId(50)))
  assert.equal(rows('player_notifications').length, 0)
  assert.equal(warnLogs.filter(entry => entry.name === 'notification.record_failed').length, 3)
  assert.equal(published.length, 0)
  // Nothing was thrown, so the caller (message, selfie, film) carries on.
})
await check('the three event paths call the one helper where they already tell the app', () => {
  const direct = readFileSync('src/services/group-chat/notifications.ts', 'utf8')
  const selfie = readFileSync('src/services/media/selfie.ts', 'utf8')
  const film = readFileSync('src/services/media/visual.ts', 'utf8')
  assert.ok(direct.indexOf('await recordDirectMessage(') > direct.indexOf('results.some(result => result.status'),
    'the row is written only after a push that landed')
  assert.ok(selfie.includes('await recordSelfieReady(String(asset._id))'), 'a ready selfie records')
  assert.ok(film.includes("if (asset.kind === 'video') await recordFilmReady("), 'a finished film records')
})

// ── (9) updatePreferences refuses unknown keys ─────────────────────────────
await check('updatePreferences takes only the keys the app sends and the server reads', async () => {
  reset()
  const playerId = player(18)
  rows('users').push({ _id: new ObjectId(playerId), username: 'audit', preferences: {}, token_balance: 0,
    created_at: new Date(), updated_at: new Date() })
  await assert.rejects(() => authService.updatePreferences(playerId, { theme: 'light' }),
    (error: { statusCode?: number }) => error.statusCode === 400)
  await assert.rejects(() => authService.updatePreferences(playerId, { player_name: 'Ada', preferred_model: 'x' }),
    (error: { statusCode?: number }) => error.statusCode === 400)
  assert.equal(Object.keys(rows('users')[0].preferences as Row).length, 0, 'a refused body writes nothing')
  await authService.updatePreferences(playerId, { group_notifications: false, player_name: 'Ada' })
  assert.deepEqual(rows('users')[0].preferences, { group_notifications: false, player_name: 'Ada' })
  assert(PREFERENCE_UPDATE_KEYS.includes('group_notifications'))
})
await check('the allowed preference keys are the ones the app and the server actually use', () => {
  assert.deepEqual([...PREFERENCE_UPDATE_KEYS].sort(), [
    'age_confirmed', 'gender', 'group_notifications', 'guide_opt_out', 'guide_progress', 'interests', 'nsfw_enabled', 'player_name',
  ])
  assert.deepEqual([...PREFERENCE_UPDATE_KEYS].sort(), Object.keys(UpdatePreferencesBody.properties).sort(),
    'the route schema and the allowlist are the same set')
  const readers = ['src/services/group-chat/notifications.ts', 'src/services/instance.service.ts', 'src/services/generation.service.ts',
    'src/services/template.service.ts', 'src/services/admin-onboarding.ts', 'src/services/guest.service.ts']
    .map(file => readFileSync(file, 'utf8')).join('\n')
  for (const key of ['group_notifications', 'nsfw_enabled', 'player_name', 'interests', 'gender']) {
    assert.ok(readers.includes(`preferences?.${key}`) || readers.includes(`preferences.${key}`) || readers.includes(`'preferences.${key}'`),
      `${key} is read by the server`)
  }
})

// ── the exact JSON one row carries, for the app ────────────────────────────
await check('one item, printed for the app contract', async () => {
  reset()
  const playerId = player(19), instanceId = objectId(22), characterId = objectId(28)
  seedInstance(instanceId, playerId); seedCard(characterId, instanceId, 'Bea')
  await recordDirectMessage({ playerId, instanceId: hex(instanceId), characterId: hex(characterId), name: 'Bea' })
  asPlayer(playerId)
  const listed = await http('/notifications')
  console.log(`ITEM ${JSON.stringify(listed.body)}`)
  assert.equal(listed.body!.unread, 1)
  const [row] = listed.body!.items as Array<Row>
  assert.ok(Object.keys(row).every(key => ITEM_KEYS.includes(key)), 'an item carries no key beyond the contract')
  assert.equal(Object.keys(row).filter(key => !STORED_KEYS.includes(key)).join(), 'id')
  assert.ok(!('read_at' in row))
})

console.log(`\nnotifications audit: ${failed === 0 ? 'ALL GREEN' : 'FAILURES'} (${passed} passed, ${failed} failed)`)
process.exit(failed === 0 ? 0 : 1)
