/**
 * A new save opens without waiting on model calls, and the app's background
 * frame is accepted.
 *
 * Two production defects, both checked here against the real code:
 *
 *   A. The app sends `{type:'presence', foreground:<bool>}` on every lifecycle
 *      change. The strict action-union rejected it at validation, so the
 *      presence branch never ran and the app showed a failed scene.
 *   B. A new save awaited two model calls whose answers depend only on the
 *      world's text: the calendar (2.7–4.3 s) and then the opening place
 *      (1.1–1.6 s), one after the other.
 *
 * In-memory Mongo stub, stubbed model call, no network, no real database:
 *
 *   bun --no-env-file run scripts/world-open-audit.ts
 *
 * Run with NODE_ENV unset (the env loader rejects a production shell without
 * live Twilio secrets; every offline audit shares that assumption).
 */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'

// ── In-memory Mongo ─────────────────────────────────────────────────────────
type Row = Record<string, any> // heterogeneous fixture documents and operators

const same = (a: unknown, b: unknown): boolean =>
  a instanceof ObjectId || b instanceof ObjectId ? String(a) === String(b) : a === b

/**
 * `structuredClone` turns an ObjectId into a plain `{ buffer }` object, which
 * would make every later `findOne({ _id })` miss. Fixtures keep the identity
 * types intact and copy everything else.
 */
function clone<T>(value: T): T {
  if (value instanceof ObjectId || value instanceof Date) return value
  if (Array.isArray(value)) return value.map((item) => clone(item)) as unknown as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T
  }
  return value
}

function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, want]) =>
    want && typeof want === 'object' && !(want instanceof ObjectId) && !Array.isArray(want)
      ? Object.entries(want).every(([op, val]) => (op === '$ne' ? !same(row[key], val) : same(row[key], val)))
      : same(row[key], want),
  )
}

class Fixture {
  rows: Row[] = []
  failReads = 0
  async findOne(filter: Row) {
    if (this.failReads > 0) { this.failReads--; throw new Error('fixture: derivation read failed') }
    const row = this.rows.find((candidate) => matches(candidate, filter))
    return row ? clone(row) : null
  }
  async countDocuments(filter: Row = {}) { return this.rows.filter((row) => matches(row, filter)).length }
  async updateMany() { return { matchedCount: 0, modifiedCount: 0 } }
  async insertOne(row: Row) { this.rows.push(clone(row)); return { insertedId: row._id } }
  async updateOne(filter: Row, update: Row, opts: Row = {}) {
    let row = this.rows.find((candidate) => matches(candidate, filter))
    if (!row && opts.upsert) {
      row = { _id: filter._id }
      for (const [path, value] of Object.entries(update.$setOnInsert ?? {})) row[path] = clone(value)
      this.rows.push(row)
      return { matchedCount: 0, upsertedCount: 1 }
    }
    if (!row) return { matchedCount: 0, upsertedCount: 0 }
    for (const [path, value] of Object.entries(update.$set ?? {})) row[path] = clone(value)
    if (update.$setOnInsert) for (const [path, value] of Object.entries(update.$setOnInsert)) if (!(path in row)) row[path] = clone(value)
    return { matchedCount: 1, upsertedCount: 0 }
  }
  find() {
    const cursor = {
      project: () => cursor,
      sort: () => cursor,
      limit: () => cursor,
      toArray: async () => this.rows.map((row) => clone(row)),
    }
    return cursor
  }
}

const store = new Map<string, Fixture>()
const fixture = (name: string) => {
  if (!store.has(name)) store.set(name, new Fixture())
  return store.get(name)!
}
const resetStore = () => store.clear()

const mongoColl = {
  worldTemplates: () => fixture('world_templates'),
  worldInstances: () => fixture('world_instances'),
  users: () => fixture('users'),
  events: () => fixture('events'),
  storyCalendars: () => fixture('story_calendars'),
  timelineBranches: () => fixture('timeline_branches'),
  worldDerivations: () => fixture('world_derivations'),
  characters: () => fixture('characters'),
  personas: () => fixture('personas'),
}
mock.module('../src/config/mongo', () => ({ mongoColl, connectMongo: async () => {}, getDb: () => { throw new Error('no db in audit') } }))

// ── Stubbed model ───────────────────────────────────────────────────────────
type Call = { purpose: string; started: number; finished: number }
const calls: Call[] = []
let delayMs = 200
/** purpose → response (JSON string). A function may throw. */
const scripts: Record<string, string | (() => string)> = {}

function scriptFor(purpose: string): string {
  const script = scripts[purpose]
  if (typeof script === 'function') return script()
  if (typeof script === 'string') return script
  throw new Error(`fixture: no script for ${purpose}`)
}

async function callLLM(params: { purpose?: string }): Promise<string> {
  const purpose = params.purpose ?? 'unlabeled'
  const record: Call = { purpose, started: performance.now(), finished: 0 }
  calls.push(record)
  await Bun.sleep(delayMs)
  const text = scriptFor(purpose)
  record.finished = performance.now()
  return text
}

mock.module('../src/ai', () => ({
  callLLM,
  AI_MODELS: { metadata: 'fixture-metadata', narrationSfw: 'fixture-narration', narrationNsfw: 'fixture-narration-nsfw' },
  narrationTemperature: () => 0,
}))
// Every log line the code under test writes; the presence path must write none.
const logged: Array<{ level: string; msg: string }> = []
const loggerMock = {
  log: {
    info(msg: string) { logged.push({ level: 'info', msg }) },
    warn(msg: string) { logged.push({ level: 'warn', msg }) },
    error(msg: string) { logged.push({ level: 'error', msg }) },
    debug(msg: string) { logged.push({ level: 'debug', msg }) },
  },
}
mock.module('../src/utils/logger', () => loggerMock)

// ── The WebSocket handler's own world, reduced to what a presence frame touches ──
const redisFixture = {
  del: async () => 0,
  get: async () => null,
  set: async () => 'OK',
  publish: async () => 0,
  subscribe: async () => undefined,
  unsubscribe: async () => undefined,
}
mock.module('../src/config/redis', () => ({
  getRedisClient: () => redisFixture,
  getRedisSubscriber: () => redisFixture,
  connectRedis: async () => undefined,
}))
mock.module('../src/services/last-active.service', () => ({ recordLastActive: () => {} }))
mock.module('../src/middleware/auth', () => ({ verifyWsToken: async () => null }))
let liveAccessCalls = 0
mock.module('../src/services/auth.service', () => ({
  authService: { getLiveAccess: async () => { liveAccessCalls++; return { tier: 'free', account_status: 'active' } } },
}))
mock.module('../src/middleware/rate-limit', () => ({ rateLimit: async () => ({ allowed: true }) }))
mock.module('../src/services/billing.service', () => ({ billingService: { reserve: async () => ({ reservation_id: 'r' }), release: async () => {} } }))
mock.module('../src/services/generation.service', () => ({ generationService: new Proxy({}, { get: () => async () => { throw new Error('a presence frame must not dispatch') } }) }))
const watchingCalls: string[] = []
mock.module('../src/services/notifications.service', () => ({
  markPlayerOnline: async () => { watchingCalls.push('online') },
  markWatching: async (_id: string, instanceId: string) => { watchingCalls.push(`watch:${instanceId}`) },
  clearWatching: async () => { watchingCalls.push('clear') },
  clearPlayerOnline: async () => {},
  markSaveStoryRepliesRead: async () => {},
}))
mock.module('../src/services/guest-policy', () => ({ requireIdentity: async () => undefined }))
mock.module('../src/services/group-chat/instance', () => ({ seedGroupOpening: async () => {} }))

// ── The code under test ─────────────────────────────────────────────────────
const { Value } = await import('@sinclair/typebox/value')
const { WsMessage } = await import('../src/schemas/ws-message.schema')
const { cachedDerivation, derivationKey } = await import('../src/services/world-derivations.service')
const { deriveCalendarFromPremise, calendarPremiseOf, timeService } = await import('../src/services/time.service')
const { extractOpeningPlace } = await import('../src/services/opening-place.service')
const { instanceService } = await import('../src/services/instance.service')
const { playWsService } = await import('../src/services/play-ws.service')

// ── Harness ─────────────────────────────────────────────────────────────────
let pass = 0
let fail = 0
async function check(label: string, run: () => unknown | Promise<unknown>) {
  try { await run(); pass++; console.log(`PASS ${label}`) }
  catch (error) { fail++; console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`) }
}
const callsOf = (purpose: string) => calls.filter((call) => call.purpose === purpose)

const MODERN = JSON.stringify({ setting: 'modern', name: 'Modern' })
const FANTASY = JSON.stringify({ setting: 'fantasy', name: 'Ashen Reckoning', eras: ['Grey Years'], months: [{ name: 'Ashfall', days: 30 }, { name: 'Emberwane', days: 30 }, { name: 'Hollowtide', days: 30 }, { name: 'Longnight', days: 30 }], weekdays: ['Ashday', 'Emberday', 'Hollowday'] })
const JUNK = JSON.stringify({ nonsense: true })
const PLACE = JSON.stringify({ place: 'Counting House' })
const REFUSAL = JSON.stringify({ place: null })

/** A listed, non-group world with an opening line. */
function listedWorld(overrides: Row = {}) {
  const _id = new ObjectId()
  fixture('world_templates').rows.push({
    _id,
    creator_id: new ObjectId(),
    title: 'The Counting House',
    slug: `world-${_id}`,
    description: 'A harbour counting house.',
    is_published: true,
    is_sentient: false,
    is_nsfw_capable: false,
    version: 1,
    seed_prompt: 'Grey harbour, ledgers, tallow.',
    global_lore: 'The tide rules everything.',
    opening_line: 'The Counting House smelled of wet rope and tallow.',
    base_stats_template: {},
    flag_definitions: {},
    scene_tags: [],
    model_preferences: {},
    max_context_memories: 20,
    max_lore_results: 5,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  })
  return String(_id)
}

const PLAYER = String(new ObjectId())
const clearCalls = () => { calls.length = 0 }

// ── A. Presence frames ──────────────────────────────────────────────────────
await check('A presence frame passes the schema', async () => {
  for (const frame of [
    { type: 'presence', foreground: false },
    { type: 'presence', foreground: true },
    { action: 'presence', foreground: true },
  ]) {
    assert.equal(Value.Check(WsMessage, frame), true, JSON.stringify(frame))
  }
})

await check('A ordinary frames still pass the schema', async () => {
  assert.equal(Value.Check(WsMessage, { action: 'ping' }), true)
  assert.equal(Value.Check(WsMessage, { action: 'chat', instance_id: String(new ObjectId()), payload: { message: 'I wait.' } }), true)
  assert.equal(Value.Check(WsMessage, { action: 'load_instance', instance_id: String(new ObjectId()) }), true)
})

await check('A a bad presence frame is still rejected', async () => {
  for (const frame of [
    { type: 'presence', foreground: 'no' },
    { type: 'presence', foreground: true, extra: 1 },
    { action: 'presence', foreground: true, extra: 1 },
    { type: 'presence' },
    {},
  ]) {
    assert.equal(Value.Check(WsMessage, frame), false, JSON.stringify(frame))
  }
})

await check('A a presence frame never reaches the switch, a log line or a reply', async () => {
  const sent: string[] = []
  let closed = false
  const socket = {
    data: { _user: { id: PLAYER, tier: 'free' as const, role: 'player' as const }, jwt: { verify: async () => null }, instanceId: 'save-under-watch', foreground: true },
    send: (text: string) => sent.push(text),
    close: () => { closed = true },
  }
  for (const frame of [
    { type: 'presence', foreground: false },
    { type: 'presence', foreground: true },
    { action: 'presence', foreground: true },
  ]) {
    logged.length = 0
    watchingCalls.length = 0
    liveAccessCalls = 0
    await playWsService.handleMessage(socket as never, frame)
    assert.deepEqual(sent, [], `a presence frame must not reply: ${JSON.stringify(frame)} -> ${sent.join(',')}`)
    assert.equal(closed, false)
    // The frame is honoured before anything else: it sets the socket's own
    // foreground flag and, on the way back up, re-claims the save it was on.
    assert.equal(socket.data.foreground, frame.foreground, JSON.stringify(frame))
    assert.deepEqual(logged.filter((line) => line.msg === 'ws.message'), [], 'a presence frame must not log ws.message')
    // It is not a heartbeat, so the ban re-check runs. That read is expected
    // and is noted in the report.
    assert.equal(liveAccessCalls, 1, 'the ban re-check runs for a presence frame')
    const expected = frame.foreground ? ['watch:save-under-watch'] : []
    assert.deepEqual(watchingCalls.slice(0, expected.length), expected, `watch bookkeeping for ${JSON.stringify(frame)}: ${watchingCalls.join(',')}`)
  }
})

await check('A an ordinary chat frame still logs and reaches the switch', async () => {
  const sent: string[] = []
  const socket = {
    data: { _user: { id: PLAYER, tier: 'free' as const, role: 'player' as const }, jwt: { verify: async () => null } },
    send: (text: string) => sent.push(text),
    close: () => {},
  }
  logged.length = 0
  // No instance_id: the chat branch refuses before it touches the lock, which
  // is enough to show the frame got past the presence branch and into the switch.
  await playWsService.handleMessage(socket as never, { action: 'chat' })
  assert.equal(logged.some((line) => line.msg === 'ws.message'), true, 'a chat frame is logged')
  assert.deepEqual(sent.map((text) => JSON.parse(text).message), ['Missing instance_id'])
})

// ── B. The cache contract ───────────────────────────────────────────────────
await check('B first derivation computes once and stores; the second is free', async () => {
  resetStore(); clearCalls()
  scripts.unit = JSON.stringify({ answer: 42 })
  let computes = 0
  const compute = async () => { computes++; return { value: { answer: 42 }, cacheable: true } }
  const first = await cachedDerivation('calendar', 'fixture input text', compute)
  const second = await cachedDerivation('calendar', 'fixture input text', compute)
  assert.deepEqual(first, { answer: 42 })
  assert.deepEqual(second, { answer: 42 })
  assert.equal(computes, 1, 'the second call must read the cache, not compute')
  const rows = fixture('world_derivations').rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0]._id, derivationKey('calendar', 'fixture input text'))
  assert.equal(rows[0].kind, 'calendar')
})

await check('B a changed input text computes again', async () => {
  resetStore(); clearCalls()
  let computes = 0
  const compute = async () => { computes++; return { value: { answer: 1 }, cacheable: true } }
  await cachedDerivation('calendar', 'input one', compute)
  await cachedDerivation('calendar', 'input two', compute)
  assert.equal(computes, 2)
  assert.equal(fixture('world_derivations').rows.length, 2)
})

await check('B a non-cacheable compute is not stored and the next call retries', async () => {
  resetStore(); clearCalls()
  let computes = 0
  const compute = async () => { computes++; return { value: null, cacheable: false } }
  assert.equal(await cachedDerivation('opening_place', 'an opening', compute), null)
  assert.equal(fixture('world_derivations').rows.length, 0, 'junk must not be stored')
  await cachedDerivation('opening_place', 'an opening', compute)
  assert.equal(computes, 2, 'the retry must reach compute again')
})

await check('B a cache read that throws still returns a computed value', async () => {
  resetStore(); clearCalls()
  fixture('world_derivations').failReads = 1
  const value = await cachedDerivation('calendar', 'throwing read', async () => ({ value: { answer: 7 }, cacheable: true }))
  assert.deepEqual(value, { answer: 7 })
})

// ── B. What is worth caching, per kind ──────────────────────────────────────
await check('B calendar: a modern answer is a decision and is cached as Gregorian', async () => {
  resetStore(); clearCalls()
  scripts.calendar_derivation = MODERN
  const template = { title: 'Neon Divide', description: 'A noir city.', seed_prompt: 'Rain.', global_lore: '' }
  const premise = calendarPremiseOf(template)
  assert.equal(premise.includes('Neon Divide'), true)
  const derived = await deriveCalendarFromPremise(premise)
  assert.equal(derived.cacheable, true, 'an explicit modern answer is cacheable')
  assert.equal(derived.spec?.months[0].name, 'January', 'modern must use the real calendar')

  const templateId = listedWorld({ title: 'Neon Divide', description: 'A noir city.', opening_line: '' })
  const calendar = await timeService.ensureDefaultCalendar(String(new ObjectId()), templateId)
  assert.equal(calendar.months[0].name, 'January')
  assert.equal(fixture('world_derivations').rows.length, 1, 'the modern answer is stored')
})

await check('B calendar: the same world text makes one model call, not two', async () => {
  resetStore(); clearCalls()
  scripts.calendar_derivation = MODERN
  const templateId = listedWorld({ title: 'Neon Divide', description: 'A noir city.', opening_line: '' })
  const a = await timeService.ensureDefaultCalendar(String(new ObjectId()), templateId)
  assert.equal(callsOf('calendar_derivation').length, 1)
  const b = await timeService.ensureDefaultCalendar(String(new ObjectId()), templateId)
  assert.equal(callsOf('calendar_derivation').length, 1, 'the second save must read the cache')
  assert.equal(a.months[0].name, 'January')
  assert.equal(b.months[0].name, 'January')
  assert.equal(fixture('world_derivations').rows.length, 1)
})

await check('B calendar: a fantasy answer is cached', async () => {
  resetStore(); clearCalls()
  scripts.calendar_derivation = FANTASY
  const templateId = listedWorld({ title: 'Ashen Reckoning', description: 'A shadow realm.', opening_line: '' })
  const calendar = await timeService.ensureDefaultCalendar(String(new ObjectId()), templateId)
  assert.equal(calendar.months[0].name, 'Ashfall')
  assert.equal(fixture('world_derivations').rows.length, 1, 'a themed calendar is a decision')
})

await check('B calendar: junk is not cached and is retried', async () => {
  resetStore(); clearCalls()
  scripts.calendar_derivation = JUNK
  const templateId = listedWorld({ title: 'Junk World', description: 'Indeterminate.', opening_line: '' })
  const calendar = await timeService.ensureDefaultCalendar(String(new ObjectId()), templateId)
  assert.equal(calendar.months[0].name, 'January', 'junk still falls back to Gregorian for this save')
  assert.equal(fixture('world_derivations').rows.length, 0, 'junk must not be pinned')
  await timeService.ensureDefaultCalendar(String(new ObjectId()), templateId)
  assert.equal(callsOf('calendar_derivation').length, 2, 'the next save must retry')
})

await check('B opening place: an accepted place is cached', async () => {
  resetStore(); clearCalls()
  scripts.opening_place = PLACE
  const line = 'The Counting House smelled of wet rope and tallow.'
  const first = await extractOpeningPlace({ openingLine: line })
  const second = await extractOpeningPlace({ openingLine: line })
  assert.equal(first?.name, 'Counting House')
  assert.deepEqual(second, first)
  assert.equal(callsOf('opening_place').length, 1, 'the second read must be free')
})

await check('B opening place: a verified refusal is cached', async () => {
  resetStore(); clearCalls()
  scripts.opening_place = REFUSAL
  const line = 'Ollen turned his head from the window.'
  assert.equal(await extractOpeningPlace({ openingLine: line }), null)
  assert.equal(await extractOpeningPlace({ openingLine: line }), null)
  assert.equal(callsOf('opening_place').length, 1, 'a refusal is a decision and is kept')
})

await check('B opening place: a thrown error is not cached', async () => {
  resetStore(); clearCalls()
  scripts.opening_place = () => { throw new Error('fixture: model down') }
  const line = 'The Long Pier ran out into grey water.'
  assert.equal(await extractOpeningPlace({ openingLine: line }), null)
  assert.equal(await extractOpeningPlace({ openingLine: line }), null)
  assert.equal(callsOf('opening_place').length, 2, 'a failure must retry on the next save')
  assert.equal(fixture('world_derivations').rows.length, 0)
})

// ── B. The create path ──────────────────────────────────────────────────────
await check('B a cold new save overlaps its two model calls and writes the same documents', async () => {
  resetStore(); clearCalls()
  delayMs = 200
  scripts.calendar_derivation = FANTASY
  scripts.opening_place = PLACE
  const templateId = listedWorld()

  const started = performance.now()
  const { instance } = await instanceService.create(PLAYER, templateId, 'free')
  const elapsed = performance.now() - started

  const calendarCalls = callsOf('calendar_derivation')
  const placeCalls = callsOf('opening_place')
  assert.equal(calendarCalls.length, 1)
  assert.equal(placeCalls.length, 1)
  // Overlap: the second call starts before the first one finishes.
  const [a, b] = [calendarCalls[0], placeCalls[0]].sort((x, y) => x.started - y.started)
  assert.ok(b.started < a.finished, `calls did not overlap: first finished at ${a.finished}, second started at ${b.started}`)
  assert.ok(elapsed < 350, `create took ${elapsed.toFixed(0)} ms — the two ~200 ms calls must overlap, not sum to ~400`)

  // The instance document's shape is unchanged.
  assert.deepEqual(Object.keys(instance).sort(), [
    '_id', 'active_flags', 'active_timeline_id', 'created_at', 'current_location',
    'current_scene', 'current_time_anchor', 'default_calendar_id', 'focus_character_id',
    'message_length', 'meta', 'mode', 'narrative_style_override', 'narration_pov',
    'narration_tone', 'persona_id', 'persona_snapshot', 'player_id', 'seed_cast_snapshot',
    'template_id', 'template_version', 'updated_at', 'world_state',
  ].sort())

  const event = fixture('events').rows[0]
  assert.deepEqual(Object.keys(event).sort(), [
    '_id', 'created_at', 'data', 'edit_history', 'instance_id', 'is_user_edited',
    'location_anchor', 'player_id', 'scene_tag', 'sequence', 'time_anchor', 'type',
  ].sort())
  assert.equal(event.sequence, 1)
  assert.equal(event.type, 'narration')
  assert.equal(event.data.model_used, 'seed')
  assert.equal(event.location_anchor.name, 'Counting House')
  assert.deepEqual(Object.keys(event.data).sort(), [
    'ai_response', 'flag_mutations', 'model_used', 'player_input', 'spoken_lines',
    'state_mutations', 'tokens_in', 'tokens_out',
  ].sort())

  const calendar = fixture('story_calendars').rows[0]
  assert.deepEqual(Object.keys(calendar).sort(), [
    '_id', 'created_at', 'eras', 'instance_id', 'is_default', 'months', 'name',
    'template_id', 'updated_at', 'weekdays',
  ].sort())
  assert.equal(calendar.is_default, true)
  assert.equal(calendar.months[0].name, 'Ashfall')
  assert.equal(instance.meta.total_events, 1)
})

await check('B a warm new save makes zero model calls', async () => {
  // State carried over from the previous check: both keys are already stored.
  clearCalls()
  const { instance } = await instanceService.create(PLAYER, fixture('world_templates').rows[0]._id.toString(), 'free')
  assert.equal(calls.length, 0, `expected no model calls, saw ${calls.map((c) => c.purpose).join(', ')}`)
  assert.equal(instance.meta.total_events, 1)
})

// ── B. Recalibration stays fresh ────────────────────────────────────────────
await check('B recalibration calls the model even when the cache holds the key', async () => {
  resetStore(); clearCalls()
  scripts.calendar_derivation = MODERN
  const templateId = listedWorld({ title: 'Repair Me', description: 'A modern city.', opening_line: '' })
  const instanceId = String(new ObjectId())
  // Prime the cache AND give the instance an existing default calendar.
  await timeService.ensureDefaultCalendar(instanceId, templateId)
  assert.equal(callsOf('calendar_derivation').length, 1)
  fixture('world_instances').rows.push({ _id: new ObjectId(instanceId), template_id: new ObjectId(templateId), player_id: new ObjectId(PLAYER), current_time_anchor: { sequence: 0 } })

  clearCalls()
  const result = await timeService.rederiveDefaultCalendar(instanceId)
  assert.equal(result.updated, true)
  assert.equal(callsOf('calendar_derivation').length, 1, 'recalibration must not read the cache')
})

console.log(`\nworld-open audit: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
