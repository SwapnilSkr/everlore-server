/**
 * WARM-ON-WRITE: a world's calendar and opening place are worked out when it is
 * created or edited, so its first player waits for neither.
 *
 * The write path must not wait for them. It starts the same two
 * `cachedDerivation` calls an open runs, behind the request, coalescing a burst
 * of edits for one world into one follow-up run. This audit pins:
 *
 *   - create, update and an admin update each start a warm;
 *   - the request resolves before a slow derivation does;
 *   - a failing derivation never throws and never rejects unhandled, and logs
 *     only the template id and kind (no world text);
 *   - a group warms the calendar only;
 *   - two calls for one id while a run is in flight make exactly two runs, and
 *     the second reads the newer text;
 *   - unchanged text is a cache hit and makes no model call;
 *   - the keys written are `derivationKey` of the open path's own inputs;
 *   - `warm-world-derivations.ts` plans the same worlds as before.
 *
 * In-memory Mongo, a fake model, no network, no real database:
 *
 *   bun --no-env-file run scripts/world-warm-audit.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'

const THROW_PHASE = Bun.argv.includes('--throw-phase')

// ── In-memory Mongo ─────────────────────────────────────────────────────────
type Row = Record<string, any>

const same = (a: unknown, b: unknown): boolean =>
  a instanceof ObjectId || b instanceof ObjectId ? String(a) === String(b) : a === b

function clone<T>(value: T): T {
  if (value instanceof ObjectId || value instanceof Date) return value
  if (Array.isArray(value)) return value.map((item) => clone(item)) as unknown as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T
  }
  return value
}

function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, want]) => {
    if (want && typeof want === 'object' && !(want instanceof ObjectId) && !(want instanceof Date) && !Array.isArray(want)) {
      return Object.entries(want).every(([op, val]) => {
        if (op === '$ne') return !same(row[key], val)
        if (op === '$exists') return (row[key] !== undefined) === val
        return same(row[key], val)
      })
    }
    return same(row[key], want)
  })
}

class Fixture {
  rows: Row[] = []
  reads = 0
  async findOne(filter: Row) {
    this.reads++
    const row = this.rows.find((candidate) => matches(candidate, filter))
    return row ? clone(row) : null
  }
  async insertOne(row: Row) {
    this.rows.push(clone(row))
    return { insertedId: row._id }
  }
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
    for (const [path, value] of Object.entries(update.$setOnInsert ?? {})) if (!(path in row)) row[path] = clone(value)
    return { matchedCount: 1, upsertedCount: 0 }
  }
  async findOneAndUpdate(filter: Row, update: Row) {
    const row = this.rows.find((candidate) => matches(candidate, filter))
    if (!row) return null
    for (const [path, value] of Object.entries(update.$set ?? {})) row[path] = clone(value)
    return clone(row)
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
  worldDerivations: () => fixture('world_derivations'),
  users: () => fixture('users'),
  worldInstances: () => fixture('world_instances'),
  events: () => fixture('events'),
  storyCalendars: () => fixture('story_calendars'),
}
mock.module('../src/config/mongo', () => ({
  mongoColl,
  connectMongo: async () => {},
  getDb: () => { throw new Error('no db in audit') },
}))

// ── Fake model ──────────────────────────────────────────────────────────────
type Call = { purpose: string; input: string; started: number; finished: number }
const calls: Call[] = []
let delayMs = 0
let gate: { promise: Promise<void>; release: () => void } | null = null
const scripts: Record<string, string | (() => string)> = {}

function userInput(params: { messages?: Array<{ content?: unknown }> }): string {
  const messages = params.messages ?? []
  return String(messages[messages.length - 1]?.content ?? '')
}

async function callLLM(params: { purpose?: string; messages?: Array<{ content?: unknown }> }): Promise<string> {
  const record: Call = {
    purpose: params.purpose ?? 'unlabeled',
    input: userInput(params),
    started: performance.now(),
    finished: 0,
  }
  calls.push(record)
  if (gate) await gate.promise
  if (delayMs > 0) await Bun.sleep(delayMs)
  record.finished = performance.now()
  const script = scripts[record.purpose]
  if (typeof script === 'string') return script
  if (typeof script === 'function') return script()
  throw new Error(`fixture: no script for ${record.purpose}`)
}

const AI_MODELS = {
  metadata: 'fixture-metadata',
  narrationSfw: 'fixture-narration',
  narrationNsfw: 'fixture-narration-nsfw',
  summary: 'fixture-summary',
  codexExtraction: 'fixture-codex',
}
mock.module('../src/ai', () => ({
  AI_MODELS,
  callLLM,
  callLLMStream: callLLM,
  callLLMWithFallback: callLLM,
  callLLMStreamWithFallback: callLLM,
  narrationTemperature: () => 0,
  embed: async () => [],
  embedQuery: async () => [],
  embedBatch: async (texts: string[]) => texts.map(() => []),
  isEmbedTimeout: () => false,
  EmbedTimeoutError: class extends Error {},
  generateImage: async () => null,
  submitVideo: async () => null,
  pollVideo: async () => null,
  awaitVideo: async () => null,
  downloadVideo: async () => null,
  synthesizeSpeech: async () => null,
  runWithLLMUsage: async (_scope: unknown, fn: () => unknown) => fn(),
  snapshotLLMUsage: () => ({}),
  isLLMUsageActive: () => false,
}))

// ── Everything else the write path touches ──────────────────────────────────
const logs: Array<{ level: string; msg: string; fields: Row }> = []
mock.module('../src/utils/logger', () => ({
  log: {
    debug(msg: string, fields: Row = {}) { logs.push({ level: 'debug', msg, fields }) },
    info(msg: string, fields: Row = {}) { logs.push({ level: 'info', msg, fields }) },
    warn(msg: string, fields: Row = {}) { logs.push({ level: 'warn', msg, fields }) },
    error(msg: string, fields: Row = {}) { logs.push({ level: 'error', msg, fields }) },
  },
  publicRequestMeta: () => ({}),
}))
mock.module('../src/services/guest-policy', () => ({
  requireIdentity: async () => undefined,
  reserveGuestTurn: async () => undefined,
  releaseGuestTurn: async () => undefined,
  GUEST_TURN_LIMIT: 0,
  signInRequired: () => undefined,
}))
mock.module('../worker/lib/template-cast-extractor', () => ({ extractTemplateCast: async () => [] }))
mock.module('../src/services/vector-store', () => ({ vectorStore: {} }))
mock.module('../src/services/storage.service', () => ({
  storageService: {
    promote: async () => null,
    delete: async () => {},
    keyFromUrl: () => null,
    isStorageConfigured: () => false,
  },
}))

// A derivation that throws, used only by the child phase so the real modules
// stay in place for every other check.
if (THROW_PHASE) {
  mock.module('../src/services/opening-place.service', () => ({
    OPENING_PLACE_PROMPT_VERSION: 1,
    extractOpeningPlace: async () => { throw new Error('fixture: opening place derivation failed') },
    deriveOpeningPlace: async () => { throw new Error('fixture: opening place derivation failed') },
    verifyOpeningPlace: () => ({ place: null, reason: 'fixture' }),
  }))
}

// ── The code under test ─────────────────────────────────────────────────────
const { templateService } = await import('../src/services/template.service')
const { adminService } = await import('../src/services/admin.service')
const { warmWorldDerivations, planForWorld } = await import('../src/services/world-warm.service')
const { derivationKey } = await import('../src/services/world-derivations.service')
const { calendarPremiseOf } = await import('../src/services/time.service')
const { isWorldListed } = await import('../src/utils/world-review')

// ── Harness ─────────────────────────────────────────────────────────────────
let pass = 0
let fail = 0
async function check(label: string, run: () => unknown | Promise<unknown>) {
  try { await run(); pass++; console.log(`  ok   ${label}`) }
  catch (error) { fail++; console.log(`  FAIL ${label}\n       ${(error as Error).message}`) }
}

async function waitFor(label: string, predicate: () => boolean, ms = 3000) {
  const end = performance.now() + ms
  while (performance.now() < end) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const callsOf = (purpose: string) => calls.filter((call) => call.purpose === purpose)
const purposes = () => new Set(calls.map((call) => call.purpose))
const rows = () => fixture('world_derivations').rows
const rowIds = () => rows().map((row) => String(row._id)).sort()

const MODERN = JSON.stringify({ setting: 'modern', name: 'Modern' })
const PLACE = JSON.stringify({ place: 'Counting House' })

function reset() {
  resetStore()
  calls.length = 0
  logs.length = 0
  delayMs = 0
  gate = null
  scripts.calendar_derivation = MODERN
  scripts.opening_place = PLACE
}

const PLAYER = new ObjectId().toHexString()

function addWorld(overrides: Row = {}): string {
  const _id = new ObjectId()
  fixture('world_templates').rows.push({
    _id,
    creator_id: new ObjectId(PLAYER),
    title: 'The Counting House',
    slug: `world-${_id}`,
    description: 'A harbour counting house.',
    kind: 'world',
    is_published: true,
    is_sentient: false,
    is_nsfw_capable: false,
    version: 1,
    seed_prompt: 'Grey harbour, ledgers, tallow.',
    global_lore: 'The tide rules everything.',
    opening_line: 'The Counting House smelled of wet rope and tallow.',
    base_stats_template: { hp: { min: 0, max: 10, default: 5, description: 'health' } },
    flag_definitions: {},
    scene_tags: [],
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  })
  return String(_id)
}

function worldData(title: string, overrides: Row = {}): Row {
  return {
    title,
    description: 'A harbour.',
    kind: 'world',
    seed_prompt: 'Grey water.',
    global_lore: 'The tide decides.',
    opening_line: 'The Counting House smelled of rope.',
    base_stats_template: { hp: { min: 0, max: 10, default: 5, description: 'health' } },
    flag_definitions: {},
    scene_tags: [],
    is_sentient: false,
    is_nsfw_capable: false,
    ...overrides,
  }
}

function expectedKeys(template: Row): string[] {
  return [
    derivationKey('calendar', calendarPremiseOf(template)),
    ...(template.kind === 'group' || !String(template.opening_line || '').trim()
      ? []
      : [derivationKey('opening_place', String(template.opening_line).trim())]),
  ].sort()
}

// ── Child phase: a derivation that throws ───────────────────────────────────
if (THROW_PHASE) {
  const unhandled: unknown[] = []
  process.on('unhandledRejection', (error) => { unhandled.push(error) })

  await check('a throwing derivation does not reject the returned promise', async () => {
    reset()
    const id = addWorld({ title: 'Throw Phase', opening_line: 'The Counting House is here.' })
    await assert.doesNotReject(warmWorldDerivations(id))
  })

  await check('a throwing derivation logs one warn with the id and kind, and no world text', async () => {
    reset()
    const opening = 'The Counting House is quiet.'
    const id = addWorld({ title: 'Throw Phase Warn', opening_line: opening })
    await warmWorldDerivations(id)
    const warns = logs.filter((line) => line.level === 'warn' && line.msg === 'world_warm.failed')
    assert.equal(warns.length, 1, `expected one warn, saw ${warns.length}`)
    assert.equal(warns[0].fields.templateId, id)
    assert.equal(warns[0].fields.kind, 'opening_place')
    assert.equal(JSON.stringify(warns[0].fields).includes(opening), false, 'the warn must not carry world text')
  })

  await check('a throwing derivation leaves no unhandled rejection', async () => {
    reset()
    const id = addWorld({ title: 'Throw Phase Unhandled', opening_line: 'The Counting House waits.' })
    void warmWorldDerivations(id)
    await Bun.sleep(50)
    assert.deepEqual(unhandled, [])
    assert.equal(logs.filter((line) => line.msg === 'world_warm.failed').length, 1)
  })

  console.log(`\nworld-warm audit (throw phase): ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

// ── A. The write paths start a warm ─────────────────────────────────────────
await check('create starts a warm and stores that world\u2019s keys', async () => {
  reset()
  const data = worldData('Create Warm World')
  const template = await templateService.create(PLAYER, data)
  await waitFor('create to start both derivations', () =>
    purposes().has('calendar_derivation') && purposes().has('opening_place'))
  const id = String(template._id)
  await warmWorldDerivations(id)
  assert.deepEqual(rowIds(), expectedKeys({ ...data, kind: data.kind }))
})

await check('create resolves before a slow derivation does', async () => {
  reset()
  delayMs = 400
  const started = performance.now()
  const template = await templateService.create(PLAYER, worldData('Slow Warm World'))
  const elapsed = performance.now() - started
  assert.ok(elapsed < 250, `create took ${elapsed.toFixed(0)} ms; it must not wait for the derivation`)
  await waitFor('the slow derivations to start', () => calls.length >= 2 && calls.some((call) => call.finished === 0))
  delayMs = 0
  await warmWorldDerivations(String(template._id))
})

await check('a creator update starts a warm with the edited text', async () => {
  reset()
  const id = addWorld({ title: 'Update Warm World', description: 'Before the edit.' })
  await templateService.update(id, PLAYER, { description: 'After the edit.' })
  await waitFor('update to start both derivations', () =>
    purposes().has('calendar_derivation') && purposes().has('opening_place'))
  await warmWorldDerivations(id)
  const row = fixture('world_templates').rows.find((candidate) => String(candidate._id) === id)!
  assert.deepEqual(rowIds(), expectedKeys(row))
})

await check('an admin update starts a warm with the edited text', async () => {
  reset()
  const id = addWorld({ title: 'Admin Warm World', description: 'Before the admin edit.' })
  await adminService.updateWorld(id, { description: 'After the admin edit.' })
  await waitFor('admin update to start both derivations', () =>
    purposes().has('calendar_derivation') && purposes().has('opening_place'))
  await warmWorldDerivations(id)
  const row = fixture('world_templates').rows.find((candidate) => String(candidate._id) === id)!
  assert.deepEqual(rowIds(), expectedKeys(row))
})

// ── B. What a warm does ─────────────────────────────────────────────────────
await check('a group warms the calendar only', async () => {
  reset()
  const id = addWorld({ title: 'Warm Group', kind: 'group', opening_line: 'The room is loud.' })
  await warmWorldDerivations(id)
  assert.equal(callsOf('calendar_derivation').length, 1)
  assert.equal(callsOf('opening_place').length, 0)
  const row = fixture('world_templates').rows.find((candidate) => String(candidate._id) === id)!
  assert.deepEqual(rowIds(), [derivationKey('calendar', calendarPremiseOf(row))])
})

await check('two calls while one runs make exactly two runs, the second on newer text', async () => {
  reset()
  const oldLine = 'The Counting House is old.'
  const newLine = 'The Counting House is new.'
  const id = addWorld({ title: 'Coalesced Warm World', opening_line: oldLine })
  const held = { promise: Promise.resolve(), release: () => {} }
  held.promise = new Promise<void>((resolve) => { held.release = resolve })
  gate = held

  const first = warmWorldDerivations(id)
  await waitFor('the first run to reach both model calls', () =>
    callsOf('calendar_derivation').length === 1 && callsOf('opening_place').length === 1 &&
    calls.every((call) => call.finished === 0))
  fixture('world_templates').rows.find((candidate) => String(candidate._id) === id)!.opening_line = newLine
  const second = warmWorldDerivations(id)
  assert.equal(second, first, 'a second call joins the run in flight')

  held.release()
  gate = null
  await second

  assert.equal(fixture('world_templates').reads, 2, 'exactly two runs (two fresh reads)')
  assert.deepEqual(callsOf('opening_place').map((call) => call.input), [oldLine, newLine])
  assert.equal(callsOf('calendar_derivation').length, 1, 'the unchanged premise hits the cache on the follow-up')
})

await check('unchanged text is a cache hit and makes no compute call', async () => {
  reset()
  const id = addWorld({ title: 'Cache Hit World' })
  await warmWorldDerivations(id)
  assert.equal(calls.length, 2)
  const before = rowIds()
  calls.length = 0
  await warmWorldDerivations(id)
  assert.deepEqual(calls, [])
  assert.deepEqual(rowIds(), before)
})

await check('the keys written equal derivationKey of the open path\u2019s inputs', async () => {
  reset()
  const row = {
    title: 'Keys World',
    description: 'A harbour at dusk.',
    seed_prompt: 'Salt and rope.',
    global_lore: 'The tide decides.',
    opening_line: '  The Counting House waits.  ',
    kind: 'world' as const,
  }
  const id = addWorld(row)
  await warmWorldDerivations(id)
  const expected = [
    derivationKey('calendar', calendarPremiseOf(row)),
    derivationKey('opening_place', 'The Counting House waits.'),
  ].sort()
  assert.deepEqual(rowIds(), expected)
})

// ── C. The bulk script plans the same worlds ────────────────────────────────
await check('the warm script plans the same worlds as before (fixture)', async () => {
  const scriptRows = [
    { _id: 'listed', is_published: true, title: 'Listed', description: 'D', seed_prompt: 'S', global_lore: 'G', opening_line: ' The Room. ', kind: 'world' },
    { _id: 'legacy', is_published: true, visibility: 'public', review_status: 'approved', title: 'Legacy', description: 'D2', seed_prompt: 'S2', global_lore: 'G2', opening_line: 'The Second Room.', kind: 'world' },
    { _id: 'hidden', is_published: true, moderation_status: 'hidden', title: 'Hidden', description: '', seed_prompt: '', global_lore: '', opening_line: '', kind: 'world' },
    { _id: 'pending', is_published: true, visibility: 'public', review_status: 'pending', title: 'Pending', description: '', seed_prompt: '', global_lore: '', opening_line: '', kind: 'world' },
    { _id: 'draft', is_published: false, title: 'Draft', description: '', seed_prompt: '', global_lore: '', opening_line: '', kind: 'world' },
    { _id: 'group', is_published: true, title: 'Group', description: '', seed_prompt: '', global_lore: '', opening_line: 'A room.', kind: 'group' },
  ]
  // The script's own selection: published, not a group, not hidden, then the
  // catalog gate. Groups are warmed on write now, not by this bulk run.
  const selected = scriptRows
    .filter((world) => world.is_published === true && world.kind !== 'group' && world.moderation_status !== 'hidden')
    .filter((world) => isWorldListed(world as never))
  assert.deepEqual(selected.map((world) => world._id), ['listed', 'legacy'])
  assert.deepEqual(selected.map((world) => ({ id: world._id, plan: planForWorld(world as never) })), [
    { id: 'listed', plan: { calendarInput: 'Listed\nD\nS\nG', openingInput: 'The Room.' } },
    { id: 'legacy', plan: { calendarInput: 'Legacy\nD2\nS2\nG2', openingInput: 'The Second Room.' } },
  ])

  // And the script really uses the moved function rather than a copy.
  const source = readFileSync(new URL('./warm-world-derivations.ts', import.meta.url), 'utf8')
  assert.match(source, /from '\.\.\/src\/services\/world-warm\.service'/)
  assert.doesNotMatch(source, /export function planForWorld/)
})

// ── D. The throwing-derivation child phase ──────────────────────────────────
await check('a throwing derivation is caught (child process)', async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_ENV'))
  const child = Bun.spawn(
    [process.execPath, '--no-env-file', 'run', import.meta.path, '--throw-phase'],
    { cwd: new URL('..', import.meta.url).pathname, env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
  )
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  assert.equal(code, 0, `${out}${err}`)
})

console.log(`\nworld-warm audit: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
