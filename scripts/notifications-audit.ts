/**
 * Pure audit: the in-app bell (group-chat.md, "In-app notifications").
 *
 * The real service, routes and both purge paths run against in-memory
 * collections and a recording Redis. No Mongo/Redis clients, network transport,
 * timers or paid models are started.
 *
 * Covered: the exact words with no chat text; another player's GET and read see
 * or change nothing; paging and the unread count; the 100-row cap; both purge
 * paths; the frame reaching only its owner; read on open; read by film; a
 * record failure never failing the send; updatePreferences refusing an unknown
 * key; the story row: written only when no socket watches the save, one unread
 * per save, a replaced row taking a fresh id so it heads the list, tied to its
 * turn so a rewind removes it, pushed only with the switch
 * on, and marked read when the save is opened; its picture (the group's first
 * speaker, or the world's cover); a finished film's push; a pressed Continue
 * counting as a player turn; and the socket's lifecycle frame, where a
 * backgrounded app stops watching and coming back takes the save again. Every
 * check is shown to bite by a reversible source mutation (see the task report).
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
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
/** A face only when its character has one, like the real resolver. */
let portraitMissing = false

/** Mongo's two mutations the service uses: set a value, or leave the key out. */
function applyUpdate(row: Row, update: Row) {
  for (const [key, value] of Object.entries((update.$set || {}) as Row)) put(row, key, clone(value))
  for (const key of Object.keys((update.$unset || {}) as Row)) {
    const parts = key.split('.')
    const parent = parts.length === 1 ? row : get(row, parts.slice(0, -1).join('.')) as Row | undefined
    if (parent && typeof parent === 'object') delete parent[parts.at(-1)!]
  }
}

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
      applyUpdate(row, update)
      return { matchedCount: 1, modifiedCount: 1 }
    },
    async updateMany(filter: Row, update: Row) {
      let modifiedCount = 0
      for (const row of rows(name).filter(row => matches(row, filter))) {
        applyUpdate(row, update)
        modifiedCount++
      }
      return { modifiedCount }
    },
    async deleteOne(filter: Row) {
      const list = rows(name), index = list.findIndex(row => matches(row, filter))
      if (index < 0) return { deletedCount: 0 }
      list.splice(index, 1)
      return { deletedCount: 1 }
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
const stored = new Map<string, string>()
const redis = {
  async publish(channel: string, text: string) { published.push({ channel, frame: JSON.parse(text) }); return 1 },
  async get(key: string) { return stored.get(key) ?? null },
  async set(key: string, value: string, ..._args: unknown[]) { stored.set(key, value); return 'OK' },
  async del(key: string) { return stored.delete(key) ? 1 : 0 },
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
      ...(portraitMissing ? {} : { portrait: { asset_key: 'cast/face.png', source: 'generated', appearance_version: 1, painted_at: new Date() } }) }),
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
    getMemoryCurationQueue: unavailable, getGenerationQueue: unavailable, getSceneSummaryQueue: unavailable,
    QUEUE_RETENTION: { generation: {}, media: {}, maintenance: {} } })],
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

// The push sender is a recorder; the payload builders stay the real ones, so
// what is asserted below really is what the phone would receive.
const realPush = await import('../src/services/push/fcm')
const pushes: Array<{ device: Row; payload: Row }> = []
const fakeSender = {
  configured: () => true,
  async send(device: Row, payload: Row) { pushes.push({ device, payload }); return true },
}
mock.module('../src/services/push/fcm', () => ({ ...realPush, fcmSender: fakeSender, createFcmSender: () => fakeSender }))

let routeUser: { id: string; tier: string } | null = null
mock.module('../src/middleware/auth', () => ({
  authPlugin: new Elysia().derive({ as: 'scoped' }, () => ({ user: routeUser })),
  verifyWsToken: unavailable,
}))

const { recordNotification, recordDirectMessage, recordSelfieReady, recordFilmReady, recordStoryReply,
  attachDirectRowEvent, markThreadRead, markSaveStoryRepliesRead, purgeNotificationsForEvents,
  markWatching, clearWatching, isWatching, markPlayerOnline, clearPlayerOnline, isPlayerOnline,
  notificationWords, isStoryTurn, NOTIFICATIONS_MAX_PER_PLAYER } = await import('../src/services/notifications.service')
const { deletionService } = await import('../src/services/deletion.service')
const { purgeAccountReferences } = await import('../src/services/account-references')
const { authService, PREFERENCE_UPDATE_KEYS } = await import('../src/services/auth.service')
const { UpdatePreferencesBody } = await import('../src/schemas/user.schema')
const { notificationRoutes } = await import('../src/routes/notifications.routes')
// The socket's own frame handling: presence is decided there, not in the bell.
const { playWsService } = await import('../src/services/play-ws.service')

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
const timeOf = (value: unknown) => value instanceof Date ? value.getTime() : undefined

const WORLD_TITLE = 'A Quiet World'
function seedInstance(id: ObjectId, playerId: string, title = WORLD_TITLE, cover?: string) {
  const templateId = objectId(900)
  rows('world_instances').push({ _id: id, player_id: new ObjectId(playerId), template_id: templateId })
  if (!rows('world_templates').some(row => asRowId(row._id) === hex(templateId))) {
    rows('world_templates').push({ _id: templateId, title, ...(cover ? { image_url: cover } : {}) })
  }
}
function seedCard(id: ObjectId, instanceId: ObjectId, name: string) {
  rows('characters').push({ _id: id, instance_id: instanceId, canonical_name: name })
}
function seedDevice(playerId: string, token = 'device-token') {
  rows('push_devices').push({ player_id: new ObjectId(playerId), token, platform: 'android', updated_at: new Date() })
}
/** The push is deliberately not awaited by the writer; give it a moment. The
 *  trailing pause also lets a push that should NOT happen arrive, if it would. */
async function settle(until: () => boolean = () => true) {
  for (let attempt = 0; attempt < 50 && !until(); attempt++) await new Promise(resolve => setTimeout(resolve, 2))
  await new Promise(resolve => setTimeout(resolve, 20))
}
function reset() {
  tables.clear(); published.length = 0; warnLogs.length = 0; notificationInsertError = undefined
  stored.clear(); pushes.length = 0; portraitMissing = false
}

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

const STORED_KEYS = ['_id', 'player_id', 'type', 'instance_id', 'character_id', 'event_id', 'media_id', 'thread',
  'title', 'body', 'image_url', 'created_at', 'read_at']
const ITEM_KEYS = ['id', 'type', 'instance_id', 'character_id', 'thread', 'media_id', 'title', 'body', 'image_url',
  'created_at', 'read_at']
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
  assert.equal(row.thread, 'direct', 'a scheduled direct message opens that thread')
  assert.ok(Object.keys(row).every(key => STORED_KEYS.includes(key)), `no key beyond the stored contract: ${Object.keys(row).join()}`)
  assert.deepEqual(notificationWords('group_direct', { name: 'Bea' }), { title: 'Bea', body: 'Bea sent you a message' })
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
  assert.equal(row.thread, 'room', 'a picture in the room opens the room')
  // The bell never shows the picture itself: only a face or a cover may ride here.
  assert.equal(row.image_url, 'https://fixture.invalid/cast/face.png')
  // A picture sent in a direct thread opens that thread, not the room.
  pending(objectId(32), { direct_with: hex(characterId) })
  await recordSelfieReady(hex(objectId(32)))
  assert.equal(rows('player_notifications')[1].thread, 'direct')
  // The notified_at stamp keeps a repair pass from repeating a row.
  rows('media_assets').find(asset => (asset._id as ObjectId).equals(objectId(31)))!.notified_at = new Date()
  await recordSelfieReady(hex(objectId(31)))
  assert.equal(rows('player_notifications').length, 2, 'the stamp keeps a repair pass from adding a third')
})
await check('a film row leads with the world title, carries its film, and never a film without a title', async () => {
  reset()
  const playerId = player(3), instanceId = objectId(12), eventId = objectId(41)
  seedInstance(instanceId, playerId)
  rows('media_assets').push({ _id: objectId(40), kind: 'video', player_id: new ObjectId(playerId), instance_id: instanceId,
    event_id: eventId, poster_url: 'https://fixture.invalid/film-cover.jpg' })
  await recordFilmReady(hex(objectId(40)))
  const [row] = rows('player_notifications')
  assert.equal(row.type, 'film_ready')
  assert.equal(row.title, WORLD_TITLE, "the world's title is the heading")
  assert.equal(row.body, 'Your film is ready')
  assert.equal(row.media_id, hex(objectId(40)), 'a tap needs the film itself')
  assert.equal(asRowId(row.event_id), hex(eventId), 'the film is tied to its turn, hidden from the wire')
  assert.equal(row.image_url, 'https://fixture.invalid/film-cover.jpg')
  assert.ok(!('character_id' in row), 'optional keys are omitted, never null')
  assert.ok(!('thread' in row), 'a film is not a thread')
  assert.deepEqual(notificationWords('film_ready', { title: WORLD_TITLE }), { title: WORLD_TITLE, body: 'Your film is ready' })
  // A film whose save no longer has a title is not turned into words nobody authored.
  reset()
  rows('media_assets').push({ _id: objectId(42), kind: 'video', player_id: new ObjectId(playerId), instance_id: instanceId })
  await recordFilmReady(hex(objectId(42)))
  assert.equal(rows('player_notifications').length, 0)
})
await check('a finished film is pushed with the film\'s id, and only with messages on', async () => {
  reset()
  const playerId = player(31), instanceId = objectId(101)
  seedInstance(instanceId, playerId); seedDevice(playerId)
  rows('users').push({ _id: new ObjectId(playerId), preferences: {} })
  rows('media_assets').push({ _id: objectId(102), kind: 'video', player_id: new ObjectId(playerId), instance_id: instanceId })
  await recordFilmReady(hex(objectId(102)))
  await settle(() => pushes.length > 0)
  assert.equal(pushes.length, 1, 'the switch is on')
  assert.deepEqual(pushes[0].payload, {
    notification: { title: WORLD_TITLE, body: 'Your film is ready' },
    data: { type: 'film_ready', instanceId: hex(instanceId), mediaId: hex(objectId(102)) },
  })
  // Nothing else rides along: the row's own words and the film a tap opens.
  assert.deepEqual(Object.keys(pushes[0].payload.data as Row).sort(), ['instanceId', 'mediaId', 'type'])
  assert.deepEqual(Object.keys(pushes[0].payload.notification as Row).sort(), ['body', 'title'])
  // The switch off: no push, but the bell still fills.
  reset()
  seedInstance(instanceId, playerId); seedDevice(playerId)
  rows('users').push({ _id: new ObjectId(playerId), preferences: { group_notifications: false } })
  rows('media_assets').push({ _id: objectId(103), kind: 'video', player_id: new ObjectId(playerId), instance_id: instanceId })
  await recordFilmReady(hex(objectId(103)))
  await settle()
  assert.equal(pushes.length, 0, 'the switch is off')
  assert.equal(rows('player_notifications').length, 1, 'the bell is not the push')
  // A guest and a banned player are not reached, exactly as for a reply.
  for (const account of [{ guest: true }, { account_status: 'banned' }]) {
    reset()
    seedInstance(instanceId, playerId); seedDevice(playerId)
    rows('users').push({ _id: new ObjectId(playerId), preferences: {}, ...account })
    rows('media_assets').push({ _id: objectId(104), kind: 'video', player_id: new ObjectId(playerId), instance_id: instanceId })
    await recordFilmReady(hex(objectId(104)))
    await settle()
    assert.equal(pushes.length, 0, JSON.stringify(account))
  }
})
await check('a story reply is only news when no socket of the player is on that save', async () => {
  reset()
  const playerId = player(20), instanceId = objectId(60)
  seedInstance(instanceId, playerId)
  await markWatching(playerId, hex(instanceId))
  assert.equal(await isWatching(playerId, hex(instanceId)), true)
  await recordStoryReply({ playerId, instanceId: hex(instanceId), eventId: hex(objectId(61)) })
  assert.equal(rows('player_notifications').length, 0, 'the player is watching the reply arrive')
  await clearWatching(playerId, hex(instanceId))
  await recordStoryReply({ playerId, instanceId: hex(instanceId), eventId: hex(objectId(61)) })
  const [row] = rows('player_notifications')
  assert.equal(row.type, 'story_reply')
  assert.equal(row.title, WORLD_TITLE, "the world's title is the heading")
  assert.equal(row.body, 'Your story has moved on')
  assert.equal(asRowId(row.event_id), hex(objectId(61)), 'tied to the turn, hidden from the wire')
  assert.ok(!('thread' in row), 'a normal-world reply has no thread to open')
  assert.ok(!('image_url' in row), 'no picture is invented for it')
})
await check('one unread story row per save: a newer reply takes the older one\'s place', async () => {
  reset()
  const playerId = player(21), instanceId = objectId(62)
  seedInstance(instanceId, playerId)
  await recordStoryReply({ playerId, instanceId: hex(instanceId), thread: 'room', characterId: hex(objectId(63)), name: 'Bea', eventId: hex(objectId(64)) })
  const [first] = rows('player_notifications')
  const firstAt = (first.created_at as Date).getTime(), firstId = asRowId(first._id)
  assert.equal(first.body, 'Bea replied')
  await new Promise(resolve => setTimeout(resolve, 2))
  await recordStoryReply({ playerId, instanceId: hex(instanceId), thread: 'direct', characterId: hex(objectId(65)), name: 'Wren', eventId: hex(objectId(66)) })
  const all = rows('player_notifications')
  assert.equal(all.length, 1, 'replaced, not stacked')
  assert.notEqual(asRowId(all[0]._id), firstId, 'a fresh id, not a row rewritten in place')
  assert.ok(asRowId(all[0]._id) > firstId, 'the new id sorts above the one it replaced')
  assert.equal(all[0].body, 'Wren replied')
  assert.equal(all[0].thread, 'direct')
  assert.equal(all[0].character_id, hex(objectId(65)))
  assert.equal(asRowId(all[0].event_id), hex(objectId(66)))
  assert.ok((all[0].created_at as Date).getTime() > firstAt)
  await markSaveStoryRepliesRead({ playerId, instanceId: hex(instanceId) })
  assert.ok(all[0].read_at instanceof Date)
  await recordStoryReply({ playerId, instanceId: hex(instanceId), thread: 'room', characterId: hex(objectId(63)), name: 'Bea', eventId: hex(objectId(67)) })
  assert.equal(rows('player_notifications').length, 2, 'a reply after reading starts a fresh unread row')
  assert.equal(rows('player_notifications').filter(row => !('read_at' in row)).length, 1)
  // A group row without a speaker has no honest sentence, so it is not written.
  reset()
  seedInstance(instanceId, playerId)
  await recordStoryReply({ playerId, instanceId: hex(instanceId), thread: 'room' })
  assert.equal(rows('player_notifications').length, 0)
})
await check('a story row leads with the group speaker\'s face, or the world\'s cover', async () => {
  reset()
  const playerId = player(32), instanceId = objectId(105), characterId = objectId(106), otherId = objectId(107)
  seedInstance(instanceId, playerId); seedCard(characterId, instanceId, 'Bea')
  await recordStoryReply({ playerId, instanceId: hex(instanceId), thread: 'room', characterId: hex(characterId), name: 'Bea' })
  assert.equal(rows('player_notifications')[0].image_url, 'https://fixture.invalid/cast/face.png',
    'a group reply shows the first speaker')
  // A normal world has no speaker: its own cover stands in, the one the library shows.
  reset()
  seedInstance(instanceId, playerId, WORLD_TITLE, 'https://fixture.invalid/cover.jpg')
  await recordStoryReply({ playerId, instanceId: hex(instanceId) })
  assert.equal(rows('player_notifications')[0].image_url, 'https://fixture.invalid/cover.jpg')
  // Neither a face nor a cover: the key is left out, never a default nobody authored.
  reset()
  seedInstance(instanceId, playerId); seedCard(characterId, instanceId, 'Wren')
  portraitMissing = true
  await recordStoryReply({ playerId, instanceId: hex(instanceId), thread: 'room', characterId: hex(characterId), name: 'Wren' })
  portraitMissing = false
  assert.ok(!('image_url' in rows('player_notifications')[0]), 'no face, no picture')
  // A replaced row does not keep the face of the reply it replaced.
  reset()
  seedInstance(instanceId, playerId)
  seedCard(characterId, instanceId, 'Bea'); seedCard(otherId, instanceId, 'Wren')
  await recordStoryReply({ playerId, instanceId: hex(instanceId), thread: 'room', characterId: hex(characterId), name: 'Bea' })
  assert.ok('image_url' in rows('player_notifications')[0])
  portraitMissing = true
  await recordStoryReply({ playerId, instanceId: hex(instanceId), thread: 'room', characterId: hex(otherId), name: 'Wren' })
  portraitMissing = false
  assert.equal(rows('player_notifications').length, 1)
  assert.ok(!('image_url' in rows('player_notifications')[0]), 'the old face goes with the old words')
})
await check('a replaced story row heads the list, newer than every row written since', async () => {
  reset()
  const playerId = player(34), instanceId = objectId(120)
  seedInstance(instanceId, playerId)
  await recordStoryReply({ playerId, instanceId: hex(instanceId), eventId: hex(objectId(121)) })
  const staleId = asRowId(rows('player_notifications')[0]._id)
  // Rows that landed after it, as they do while the player is elsewhere: they
  // sit above the old id, which is exactly what hides a row rewritten in place.
  for (let i = 0; i < 3; i++) {
    await recordNotification({ playerId, type: 'group_direct', instanceId: hex(instanceId), name: 'Bea' })
  }
  asPlayer(playerId)
  const before = (await http('/notifications')).body!.items as Row[]
  assert.equal(before.length, 4)
  assert.equal(before[0].type, 'group_direct', 'before the replace, the story row sits below them')
  assert.ok(before.some(item => item.id === staleId), 'and it is there to be replaced')
  await recordStoryReply({ playerId, instanceId: hex(instanceId), eventId: hex(objectId(122)) })
  const listed = await http('/notifications')
  const items = listed.body!.items as Row[]
  assert.equal(items.length, 4, 'replaced, not stacked')
  assert.equal(items[0].type, 'story_reply', 'the fresh reply heads the list')
  const storyId = items[0].id as string
  assert.notEqual(storyId, staleId, 'a row rewritten in place would keep its old id')
  assert.ok(items.slice(1).every(item => (item.id as string) < storyId), 'its id is newer than every other row')
  assert.ok(!items.some(item => item.id === staleId), 'the row it replaced left the list')
  assert.equal(listed.body!.unread, 4, 'three messages and the reply, counted once')
  assert.equal(rows('player_notifications').filter(row => row.type === 'story_reply' && !('read_at' in row)).length, 1,
    'still exactly one unread story row per save')
  // Paging from the row below it never brings the replaced row back.
  const older = (await http(`/notifications?before=${items[1].id as string}`)).body!.items as Row[]
  assert.equal(older.length, 2)
  assert.ok(older.every(item => (item.id as string) < (items[1].id as string)))
})
await check('a story reply is pushed only with messages switched on, and carries no reply text', async () => {
  reset()
  const playerId = player(22), instanceId = objectId(68)
  seedInstance(instanceId, playerId); seedDevice(playerId)
  rows('users').push({ _id: new ObjectId(playerId), preferences: {} })
  await recordStoryReply({ playerId, instanceId: hex(instanceId) })
  await settle(() => pushes.length > 0)
  assert.equal(pushes.length, 1)
  assert.deepEqual(pushes[0].payload, {
    notification: { title: WORLD_TITLE, body: 'Your story has moved on' },
    data: { type: 'story_reply', instanceId: hex(instanceId) },
  })
  // The switch off: no push, but the bell still fills.
  reset()
  seedInstance(instanceId, playerId); seedDevice(playerId)
  rows('users').push({ _id: new ObjectId(playerId), preferences: { group_notifications: false } })
  await recordStoryReply({ playerId, instanceId: hex(instanceId) })
  await settle()
  assert.equal(pushes.length, 0, 'the switch is off')
  assert.equal(rows('player_notifications').length, 1, 'the bell is not the push')
  // A group reply names its speaker and the thread a tap opens.
  reset()
  seedInstance(instanceId, playerId); seedDevice(playerId)
  rows('users').push({ _id: new ObjectId(playerId), preferences: {} })
  await recordStoryReply({ playerId, instanceId: hex(instanceId), thread: 'direct', characterId: hex(objectId(69)), name: 'Bea' })
  await settle(() => pushes.length > 0)
  assert.deepEqual(pushes[0].payload.data, { type: 'story_reply', instanceId: hex(instanceId), thread: 'direct' })
  assert.equal(pushes[0].payload.notification.body, 'Bea replied')
  // A guest and a banned player are not reached.
  for (const account of [{ guest: true }, { account_status: 'banned' }]) {
    reset()
    seedInstance(instanceId, playerId); seedDevice(playerId)
    rows('users').push({ _id: new ObjectId(playerId), preferences: {}, ...account })
    await recordStoryReply({ playerId, instanceId: hex(instanceId) })
    await settle()
    assert.equal(pushes.length, 0)
  }
  // A save with no device is not pushed to either.
  reset()
  seedInstance(instanceId, playerId)
  rows('users').push({ _id: new ObjectId(playerId), preferences: {} })
  await recordStoryReply({ playerId, instanceId: hex(instanceId) })
  await settle()
  assert.equal(pushes.length, 0)
})
await check('the live frame reaches a player with the app open, and nobody without one', async () => {
  reset()
  const playerId = player(23), instanceId = objectId(70)
  seedInstance(instanceId, playerId)
  await recordStoryReply({ playerId, instanceId: hex(instanceId) })
  assert.equal(published.length, 0, 'a frame nobody could receive is not sent')
  reset()
  seedInstance(instanceId, playerId)
  await markPlayerOnline(playerId)
  await recordStoryReply({ playerId, instanceId: hex(instanceId) })
  assert.equal(published.length, 1)
  assert.equal(published[0].channel, `user:${playerId}:events`)
  assert.equal(published[0].frame.type, 'notification')
  assert.equal((published[0].frame.item as Row).type, 'story_reply')
  assert.equal(published[0].frame.unread, 1)
  assert.ok(!('event_id' in (published[0].frame.item as Row)), 'the internal event id never leaves the server')
  // A replace sends the fresh row and the same count, not a second unread.
  const firstFrameId = (published[0].frame.item as Row).id as string
  await new Promise(resolve => setTimeout(resolve, 2))
  await recordStoryReply({ playerId, instanceId: hex(instanceId) })
  assert.equal(published.length, 2)
  assert.equal(published[1].frame.unread, 1, 'one unread before the replace, one after')
  assert.notEqual((published[1].frame.item as Row).id, firstFrameId, 'the frame carries the fresh id')
  assert.equal(rows('player_notifications').length, 1, 'and the save still holds one row')
  await clearPlayerOnline(playerId)
  assert.equal(await isPlayerOnline(playerId), false)
})
await check('opening a film marks that film\'s row, and only its owner\'s', async () => {
  reset()
  const owner = player(24), stranger = player(25), instanceId = objectId(71)
  seedInstance(instanceId, owner)
  for (const media of [objectId(72), objectId(73)]) {
    rows('media_assets').push({ _id: media, kind: 'video', player_id: new ObjectId(owner), instance_id: instanceId })
    await recordFilmReady(hex(media))
  }
  asPlayer(owner)
  const marked = await http('/notifications/read', { media_id: hex(objectId(72)) })
  assert.equal(marked.status, 200); assert.equal(marked.body!.unread, 1)
  const [one, two] = rows('player_notifications')
  assert.ok(one.read_at instanceof Date); assert.ok(!('read_at' in two), 'the other film stays unread')
  asPlayer(stranger)
  assert.equal((await http('/notifications/read', { media_id: hex(objectId(73)) })).status, 200)
  assert.ok(!('read_at' in rows('player_notifications')[1]), "a stranger's film changes nothing")
  asPlayer(owner)
  for (const body of [{ media_id: hex(objectId(72)), ids: [] }, { media_id: hex(objectId(72)), all: true },
    { media_id: 'nope' }, { media_id: 42 }, { media_id: null }]) {
    assert.equal((await http('/notifications/read', body)).status, 400, JSON.stringify(body))
  }
  // Reading it twice is harmless and never resurrects it.
  await http('/notifications/read', { media_id: hex(objectId(72)) })
  assert.equal((timeOf(rows('player_notifications')[0].read_at)), (timeOf(one.read_at)))
})
await check('opening a save reads only that save\'s story rows', async () => {
  reset()
  const playerId = player(27), a = objectId(78), b = objectId(79)
  seedInstance(a, playerId); seedInstance(b, playerId)
  await recordStoryReply({ playerId, instanceId: hex(a) })
  await recordStoryReply({ playerId, instanceId: hex(b) })
  await recordNotification({ playerId, type: 'group_direct', instanceId: hex(a), characterId: hex(objectId(80)), name: 'Bea' })
  await markSaveStoryRepliesRead({ playerId, instanceId: hex(a) })
  const storyA = rows('player_notifications').find(row => row.type === 'story_reply' && asRowId(row.instance_id) === hex(a))!
  const storyB = rows('player_notifications').find(row => row.type === 'story_reply' && asRowId(row.instance_id) === hex(b))!
  const direct = rows('player_notifications').find(row => row.type === 'group_direct')!
  assert.ok(storyA.read_at instanceof Date)
  assert.ok(!('read_at' in storyB), 'another save stays unread')
  assert.ok(!('read_at' in direct), 'a thread row is the thread open call\'s business')
})
await check('a scheduled direct message is tied to the turn it became', async () => {
  reset()
  const playerId = player(28), instanceId = objectId(95), characterId = hex(objectId(96)), eventId = objectId(97)
  seedInstance(instanceId, playerId)
  await recordDirectMessage({ playerId, instanceId: hex(instanceId), characterId, name: 'Bea' })
  const [row] = rows('player_notifications')
  assert.ok(!('event_id' in row), 'the turn did not exist when the message was scheduled')
  await attachDirectRowEvent({ playerId, instanceId: hex(instanceId), characterId, eventId: hex(eventId) })
  assert.equal(row.event_id instanceof ObjectId ? asRowId(row.event_id) : undefined, hex(eventId))
  // A rewind over that turn now removes the row with it.
  await purgeNotificationsForEvents(instanceId, [eventId])
  assert.equal(rows('player_notifications').length, 0)
  // A row the player has already read is history and is not re-pointed.
  await recordDirectMessage({ playerId, instanceId: hex(instanceId), characterId, name: 'Bea' })
  await markThreadRead({ playerId, instanceId: hex(instanceId), characterId })
  await attachDirectRowEvent({ playerId, instanceId: hex(instanceId), characterId, eventId: hex(objectId(98)) })
  assert.ok(!('event_id' in rows('player_notifications')[0]))
})
await check('a rewind removes the rows tied to the turns it removed, and only those', async () => {
  reset()
  const playerId = player(26), instanceId = objectId(74), doomed = [objectId(75), objectId(76)], kept = objectId(77)
  seedInstance(instanceId, playerId)
  for (const eventId of [...doomed, kept]) {
    await recordNotification({ playerId, type: 'group_selfie', instanceId: hex(instanceId), name: 'Bea', eventId: hex(eventId) })
  }
  await purgeNotificationsForEvents(instanceId, doomed)
  const left = rows('player_notifications')
  assert.equal(left.length, 1)
  assert.equal(asRowId(left[0].event_id), hex(kept))
  // A row that names no turn cannot be swept by a rewind of turns.
  reset()
  seedInstance(instanceId, playerId)
  await recordNotification({ playerId, type: 'group_selfie', instanceId: hex(instanceId), name: 'Bea' })
  await purgeNotificationsForEvents(instanceId, doomed)
  assert.equal(rows('player_notifications').length, 1)
})
await check('the rewind deletes the tied rows next to the media purge', () => {
  const source = readFileSync('src/services/memory.service.ts', 'utf8')
  const purge = source.indexOf('await purgeMedia({ instance_id: iid, event_id: { $in: doomedIds } })')
  assert.ok(purge > 0, 'the media purge is still there')
  const bell = source.indexOf('await purgeNotificationsForEvents(iid, doomedIds)', purge)
  assert.ok(bell > purge, 'the bell purge runs right after the media purge')
})
await check('opening a save marks its story rows read in the load path', () => {
  const source = readFileSync('src/services/play-ws.service.ts', 'utf8')
  const load = source.slice(source.indexOf("case 'load_instance'"))
  assert.ok(load.includes('await markSaveStoryRepliesRead({ playerId: user.id, instanceId })'),
    'the one play load marks the save read')
  const open = source.slice(source.indexOf('async function watchSave'))
  assert.ok(open.includes('await markWatching(userId, instanceId)'), 'loading a save is watching it')
  assert.ok(source.includes('await clearWatching(user.id, instanceId)'), 'closing the last socket stops watching it')
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
  for (let i = 1; i <= 35; i++) await recordNotification({ playerId, type: 'group_direct', instanceId, name: 'Bea' })
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
    await recordNotification({ playerId, type: 'group_direct', instanceId, name: 'Bea' })
    ids.push(asRowId(rows('player_notifications').at(-1)!._id))
  }
  await recordNotification({ playerId: other, type: 'group_direct', instanceId, name: 'Bea' })
  const kept = rows('player_notifications').filter(row => asRowId(row.player_id) === playerId).map(row => asRowId(row._id))
  assert.equal(kept.length, NOTIFICATIONS_MAX_PER_PLAYER)
  assert.deepEqual(kept.sort(), ids.slice(5).sort(), 'the five oldest went, every other row stayed')
  assert.equal(rows('player_notifications').filter(row => asRowId(row.player_id) === other).length, 1)
})

// ── (5) both purge paths ───────────────────────────────────────────────────
await check('deleting a save removes its rows and leaves the others', async () => {
  reset()
  const playerId = player(10), instanceA = objectId(16), instanceB = objectId(17)
  for (const instance of [instanceA, instanceB]) await recordNotification({ playerId, type: 'group_direct', instanceId: hex(instance), name: 'Bea' })
  await deletionService.purgeInstancePayload(instanceA, hex(instanceA))
  const left = rows('player_notifications')
  assert.equal(left.length, 1)
  assert.equal(asRowId(left[0].instance_id), hex(instanceB))
})
await check('deleting the account removes its rows and leaves another player untouched', async () => {
  reset()
  const playerId = player(11), other = player(12), instanceId = hex(objectId(18))
  await recordNotification({ playerId, type: 'group_direct', instanceId, name: 'Bea' })
  await recordNotification({ playerId: other, type: 'group_direct', instanceId, name: 'Bea' })
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
  rows('users').push({ _id: new ObjectId(playerId), preferences: {} })
  await recordDirectMessage({ playerId, instanceId: hex(instanceId), characterId: hex(characterId), name: 'Ada' })
  await recordSelfieReady(hex(objectId(51)))
  await recordFilmReady(hex(objectId(50)))
  await recordStoryReply({ playerId, instanceId: hex(instanceId) })
  assert.equal(rows('player_notifications').length, 0)
  assert.equal(warnLogs.filter(entry => entry.name === 'notification.record_failed').length, 4)
  assert.equal(published.length, 0)
  // Nothing was thrown, so the caller (message, selfie, film, reply) carries on.
})
await check('every event path calls a bell helper where it already tells the app', () => {
  const direct = readFileSync('src/services/group-chat/notifications.ts', 'utf8')
  const selfie = readFileSync('src/services/media/selfie.ts', 'utf8')
  const film = readFileSync('src/services/media/visual.ts', 'utf8')
  const story = readFileSync('worker/index.ts', 'utf8')
  const group = readFileSync('worker/processors/group-turn.processor.ts', 'utf8')
  assert.ok(direct.indexOf('await recordDirectMessage(') > direct.indexOf('results.some(result => result.status'),
    'the row is written only after a push that landed')
  assert.ok(selfie.includes('await recordSelfieReady(String(asset._id))'), 'a ready selfie records')
  assert.ok(film.includes("if (asset.kind === 'video') await recordFilmReady("), 'a finished film records')
  assert.ok(story.indexOf('await recordStoryReply(') > story.indexOf('const result = await generationProcessor(job)'),
    'a finished normal-world turn records after its completion goes out')
  assert.ok(!readFileSync('worker/processors/generation.processor.ts', 'utf8').includes('recordStoryReply'),
    'the normal-world processor stays untouched: the worker records what it finished')
  assert.ok(group.indexOf('await recordStoryReply(') > group.indexOf('await finishGenerationTurn('),
    'a finished group turn records after its completion goes out')
  assert.ok(group.includes("origin === 'unprompted' && directWith"), 'an unprompted message ties its row, never a story row')
})

await check('a continue the player pressed records a row, and a replay or a group turn does not', () => {
  assert.equal(isStoryTurn({ isContinuation: true }), true, "a pressed Continue is the player's turn")
  assert.equal(isStoryTurn({}), true, 'a typed line and a confirmed action are story turns')
  assert.equal(isStoryTurn({ mode: 'replay' }), false, 'a replay rewrites a turn already told')
  assert.equal(isStoryTurn({ session: { kind: 'group' } }), false, 'a group save writes its own row')
  const worker = readFileSync('worker/index.ts', 'utf8')
  assert.ok(worker.indexOf('await recordStoryReply(') > worker.indexOf('const result = await generationProcessor(job)'),
    'the row is written after the turn finishes')
  assert.ok(worker.includes('isStoryTurn(job.data)'), 'the completion hook asks the one predicate')
  assert.ok(!/!job\.data\?\.isContinuation/.test(worker), 'a continuation is not filtered out')
  // Nothing but the socket's `continue` action enqueues a continuation, so every
  // continuation is a press: there is no automatic one to tell apart.
  const sources = ['src', 'worker'].flatMap(dir =>
    readdirSync(dir, { recursive: true, encoding: 'utf8' }).map(file => `${dir}/${file}`))
    .filter(file => file.endsWith('.ts'))
  const producers = sources.filter(file => /isContinuation:\s*true/.test(readFileSync(file, 'utf8'))).sort()
  assert.deepEqual(producers, ['src/services/play-ws.service.ts'], 'only the Continue action dispatches one')
  const socket = readFileSync('src/services/play-ws.service.ts', 'utf8')
  const continuation = socket.slice(socket.indexOf("case 'continue'"), socket.indexOf("case 'world_action'"))
  assert.ok(continuation.includes('isContinuation: true'), 'the Continue action marks its job')
})
await check('a backgrounded app is not watching: the reply becomes a row, and coming back stops it', async () => {
  reset()
  const playerId = player(33), instanceId = objectId(108)
  seedInstance(instanceId, playerId)
  rows('users').push({ _id: new ObjectId(playerId), account_status: 'active', tier: 'creator' })
  const sent: Row[] = []
  const send = (text: string) => sent.push(JSON.parse(text) as Row)
  const socket = {
    data: { _user: { id: playerId, tier: 'creator' } },
    raw: { send }, send, close: () => {},
  }
  // The socket is on a save, as it is after a load: any frame naming it claims it.
  await playWsService.handleMessage(socket, { action: 'ping', instance_id: hex(instanceId) })
  assert.equal(await isWatching(playerId, hex(instanceId)), true, 'a socket on a save is watching it')
  assert.equal(await isPlayerOnline(playerId), true, 'a socket frame keeps the player online')
  assert.equal(sent.length, 1, 'the ping is answered')
  sent.length = 0
  const presence = (foreground: unknown) => playWsService.handleMessage(socket, { type: 'presence', foreground })
  await presence(false)
  assert.equal(await isWatching(playerId, hex(instanceId)), false, 'the app is open but not looking')
  assert.equal(await isPlayerOnline(playerId), true, 'a lifecycle frame leaves presence alone')
  await recordStoryReply({ playerId, instanceId: hex(instanceId), eventId: hex(objectId(109)) })
  assert.equal(rows('player_notifications').length, 1, 'a reply that lands in the background is news')
  await presence(true)
  assert.equal(await isWatching(playerId, hex(instanceId)), true, 'coming back takes the save again')
  await recordStoryReply({ playerId, instanceId: hex(instanceId), eventId: hex(objectId(110)) })
  assert.equal(rows('player_notifications').length, 1, 'watched again, nothing new is written')
  // An unknown shape is ignored, never an error, and changes nothing.
  await presence(undefined)
  await presence('yes')
  await playWsService.handleMessage(socket, { type: 'presence' })
  assert.equal(await isWatching(playerId, hex(instanceId)), true, 'an unknown shape changes nothing')
  assert.equal(sent.length, 0, 'a lifecycle frame is never answered with an error')
  // Opening a save is looking at it, whatever the app said before, and a
  // backgrounded socket stops renewing the claim on every other frame.
  const ws = readFileSync('src/services/play-ws.service.ts', 'utf8')
  assert.ok(ws.includes("if (action === 'load_instance') getWsData(ws).foreground = true"),
    'a load brings the socket back to the front')
  assert.ok(ws.includes("else if (watched && getWsData(ws).foreground !== false) await markWatching(user.id, watched)"),
    'a backgrounded socket does not renew its claim')
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
  assert.ok(!('event_id' in row), 'the internal event id never leaves the server')
  assert.ok(!('player_id' in row), "the owner's id is never echoed")
})

// ── one item of every type, as the app receives it ─────────────────────────
await check('every type on the wire, printed for the app contract', async () => {
  reset()
  const playerId = player(30), instanceId = objectId(90), characterId = objectId(91)
  seedInstance(instanceId, playerId); seedCard(characterId, instanceId, 'Bea')
  rows('media_assets').push({ _id: objectId(92), kind: 'video', player_id: new ObjectId(playerId), instance_id: instanceId })
  await recordDirectMessage({ playerId, instanceId: hex(instanceId), characterId: hex(characterId), name: 'Bea' })
  rows('media_assets').push({ _id: objectId(93), kind: 'picture', group_selfie: true, player_id: new ObjectId(playerId),
    instance_id: instanceId, character_id: characterId, url: 'https://fixture.invalid/selfie.png', direct_with: hex(characterId) })
  await recordSelfieReady(hex(objectId(93)))
  await recordFilmReady(hex(objectId(92)))
  await recordStoryReply({ playerId, instanceId: hex(instanceId), thread: 'direct', characterId: hex(characterId),
    name: 'Bea', eventId: hex(objectId(94)) })
  asPlayer(playerId)
  const listed = await http('/notifications')
  const items = listed.body!.items as Array<Row>
  console.log(`ITEMS ${JSON.stringify(items)}`)
  assert.deepEqual(items.map(item => item.type).sort(), ['film_ready', 'group_direct', 'group_selfie', 'story_reply'])
  for (const item of items) {
    assert.ok(!('event_id' in item), 'no item names an event')
    assert.ok(Object.keys(item).every(key => ITEM_KEYS.includes(key)))
  }
})

console.log(`\nnotifications audit: ${failed === 0 ? 'ALL GREEN' : 'FAILURES'} (${passed} passed, ${failed} failed)`)
process.exit(failed === 0 ? 0 : 1)
