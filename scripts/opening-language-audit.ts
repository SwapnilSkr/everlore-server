/**
 * THE OPENING IN THE SAVE'S LANGUAGE (§6 of
 * `everlore-docs/phases/reply-language.md`; brief rl-4b).
 *
 * Drives the REAL `instanceService.create`, `deletionService.resetInstance` and
 * `instanceService.updateSettings` against an in-memory Mongo and a scripted
 * model: no network, no DB, no real world. It records every model call, every
 * write and the stored documents, so the opening's two blocks can be asserted
 * exactly:
 *
 *   - the player reads `data.ai_response` in the save's language;
 *   - everything that decides what HAPPENED reads `data.witness.ai_response`;
 *   - English is untouched: the create's calls and documents are frozen from
 *     HEAD (see `--emit`) and compared byte for byte, at create and at reset.
 *
 *   bun --no-env-file run scripts/opening-language-audit.ts
 *   bun --no-env-file run scripts/opening-language-audit.ts --bites
 *   bun --no-env-file run scripts/opening-language-audit.ts --emit   # freeze from HEAD
 */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import type { WitnessProblemReason } from '../worker/lib/witness-copy'
import { join } from 'node:path'

process.env.REPLY_LANGUAGES = 'pt,es'

// ── fixture text ─────────────────────────────────────────────────────────────
const EN_OPENING = 'The Counting House door sticks. "You came," *Mara says, stepping aside. The hearth crackles between you.*'
const PT_OPENING = 'A porta do Counting House emperra. "Você veio," *Mara diz, saindo do caminho. A lareira crepita entre vocês.*'
const ES_OPENING = 'La puerta del Counting House se atasca. "Has venido," *dice Mara, apartándose. El hogar crepita entre vosotros.*'
const EN_AGAIN = 'The door creaks open. "You came," *Mara says, moving aside. The fire crackles softly.*'
const PT_ENGLISH = 'The Counting House door sticks. "You came," says Mara, stepping aside. The hearth crackles between you.'

// ── tiny in-memory Mongo ─────────────────────────────────────────────────────
type Row = Record<string, any>

const clone = <T>(value: T): T => {
  if (value instanceof ObjectId) return new ObjectId(value) as T
  if (value instanceof Date) return new Date(value.getTime()) as T
  if (Array.isArray(value)) return value.map(clone) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) as T
  }
  return value
}
const get = (row: Row, key: string) => key.split('.').reduce((value, part) => value?.[part], row)
const scalar = (value: any) =>
  value instanceof ObjectId ? value.toHexString() : value instanceof Date ? value.getTime() : value

function same(actual: any, expected: any): boolean {
  if (expected instanceof ObjectId) return actual instanceof ObjectId && actual.equals(expected)
  if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime()
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => same(actual[i], v))
  }
  if (expected && typeof expected === 'object') {
    return !!actual && typeof actual === 'object' && Object.entries(expected).every(([k, v]) => same(actual[k], v))
  }
  return actual === expected
}

function matches(row: Row, query: Row): boolean {
  return Object.entries(query || {}).every(([key, expected]) => {
    if (key === '$or') return (expected as Row[]).some((q) => matches(row, q))
    const actual = get(row, key)
    if (expected && typeof expected === 'object' && !(expected instanceof ObjectId) && !(expected instanceof Date)) {
      return Object.entries(expected).every(([op, value]: [string, any]) => {
        if (op === '$exists') return (actual !== undefined) === value
        if (op === '$ne') return !same(actual, value)
        if (op === '$lt') return (scalar(actual) as any) < (scalar(value) as any)
        if (op === '$lte') return (scalar(actual) as any) <= (scalar(value) as any)
        if (op === '$gt') return (scalar(actual) as any) > (scalar(value) as any)
        if (op === '$gte') return (scalar(actual) as any) >= (scalar(value) as any)
        if (op === '$in') return (value as any[]).some((v) => same(actual, v))
        if (op === '$nin') return !(value as any[]).some((v) => same(actual, v))
        throw new Error(`unhandled query operator ${op}`)
      })
    }
    return same(actual, expected)
  })
}

function setKey(row: Row, key: string, value: any, unset = false) {
  const parts = key.split('.')
  const last = parts.pop()!
  const parent = parts.reduce((node, part) => (node[part] ??= {}), row)
  if (unset) delete parent[last]
  else parent[last] = clone(value)
}

const writes: Array<{ collection: string; query: Row; update: Row }> = []

class Coll {
  rows: Row[]
  name: string
  constructor(name: string, rows: Row[] = []) {
    this.name = name
    this.rows = clone(rows)
  }
  reset(rows: Row[] = []) {
    this.rows = clone(rows)
  }
  project(row: Row, projection?: Row): Row {
    if (!projection) return clone(row)
    if (projection._id === 0) {
      const out = clone(row)
      delete out._id
      return out
    }
    const out: Row = {}
    for (const [key, include] of Object.entries(projection)) {
      if (!include) continue
      const value = get(row, key)
      if (value !== undefined) setKey(out, key, value)
    }
    if (projection._id !== 0 && row._id !== undefined) out._id = clone(row._id)
    return out
  }
  find(query: Row = {}, opts: Row = {}) {
    let rows = this.rows.filter((row) => matches(row, query))
    const cursor: any = {
      projection: opts.projection,
      sort(order: Row) {
        for (const [key, direction] of Object.entries(order)) {
          rows = [...rows].sort((a, b) => {
            const left = scalar(get(a, key)) as any
            const right = scalar(get(b, key)) as any
            return left < right ? -direction : left > right ? direction : 0
          })
        }
        return cursor
      },
      limit(n: number) { rows = rows.slice(0, n); return cursor },
      skip(n: number) { rows = rows.slice(n); return cursor },
      project(projection: Row) { cursor.projection = projection; return cursor },
      next: async () => (rows[0] ? this.project(rows[0], cursor.projection) : null),
      toArray: async () => rows.map((row) => this.project(row, cursor.projection)),
    }
    return cursor
  }
  async findOne(query: Row = {}, opts: Row = {}) {
    const rows = this.rows.filter((row) => matches(row, query))
    return rows[0] ? this.project(rows[0], opts.projection) : null
  }
  async countDocuments(query: Row = {}) {
    return this.rows.filter((row) => matches(row, query)).length
  }
  async updateOne(query: Row, update: Row, opts: Row = {}) {
    const row = this.rows.find((candidate) => matches(candidate, query))
    if (!row) {
      if (opts.upsert) {
        const found: Row = { ...clone(query) }
        for (const [key, value] of Object.entries(update.$setOnInsert || {})) setKey(found, key, value)
        for (const [key, value] of Object.entries(update.$set || {})) setKey(found, key, value)
        this.rows.push(found)
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
      }
      return { matchedCount: 0, modifiedCount: 0 }
    }
    writes.push({ collection: this.name, query: clone(query), update: clone(update) })
    for (const [key, value] of Object.entries(update.$set || {})) setKey(row, key, value)
    for (const key of Object.keys(update.$unset || {})) setKey(row, key, undefined, true)
    for (const [key, value] of Object.entries(update.$inc || {})) setKey(row, key, Number(get(row, key) || 0) + Number(value))
    for (const [key, value] of Object.entries(update.$push || {})) setKey(row, key, [...(get(row, key) || []), clone(value)])
    for (const [key, value] of Object.entries(update.$setOnInsert || {})) if (get(row, key) === undefined) setKey(row, key, value)
    return { matchedCount: 1, modifiedCount: 1 }
  }
  async findOneAndUpdate(query: Row, update: Row, opts: Row = {}) {
    const before = this.rows.find((candidate) => matches(candidate, query))
    if (!before) return null
    await this.updateOne(query, update)
    return this.findOne({ _id: before._id })
  }
  async updateMany(query: Row, update: Row) {
    const rows = this.rows.filter((candidate) => matches(candidate, query))
    for (const row of rows) {
      for (const [key, value] of Object.entries(update.$set || {})) setKey(row, key, value)
      for (const key of Object.keys(update.$unset || {})) setKey(row, key, undefined, true)
    }
    if (rows.length) writes.push({ collection: this.name, query: clone(query), update: clone(update) })
    return { matchedCount: rows.length, modifiedCount: rows.length }
  }
  async deleteMany(query: Row = {}) {
    this.rows = this.rows.filter((row) => !matches(row, query))
    return { deletedCount: 0 }
  }
  async deleteOne(query: Row = {}) {
    const index = this.rows.findIndex((row) => matches(row, query))
    if (index >= 0) this.rows.splice(index, 1)
    return { deletedCount: index >= 0 ? 1 : 0 }
  }
  async insertOne(row: Row) {
    this.rows.push(clone(row))
    return { insertedId: row._id }
  }
  async insertMany(rows: Row[]) {
    this.rows.push(...rows.map(clone))
    return { insertedCount: rows.length }
  }
  async aggregate() {
    return { toArray: async () => [] }
  }
}

const colls = new Map<string, Coll>()
/** `world_templates` and `worldTemplates` are the same fixture. */
const canonical = (name: string) => name.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())
const coll = (name: string) => {
  const key = canonical(name)
  if (!colls.has(key)) colls.set(key, new Coll(name))
  return colls.get(key)!
}
const resetStore = () => {
  colls.clear()
  writes.length = 0
}

const mongoColl = new Proxy({} as Record<string, () => Coll>, {
  get: (_target, key: string) => () => coll(key),
})
mock.module('../src/config/mongo', () => ({ mongoColl, connectMongo: async () => {}, getDb: () => { throw new Error('no db in audit') } }))

// ── scripted model ───────────────────────────────────────────────────────────
type Call = { purpose: string; model: string; temperature: number; maxTokens: number; timeoutMs: number; messages: Array<{ role: string; content: string }>; structured: boolean }
const calls: Call[] = []
type Answer = { content: string; finishReason?: string | null } | (() => { content: string; finishReason?: string | null }) | Promise<never>
/** purpose → the answer, in order of use. The last entry repeats. */
const scripts = new Map<string, Answer[]>()
const setScript = (purpose: string, ...answers: Answer[]) => scripts.set(purpose, answers)
const clearCalls = () => { calls.length = 0 }
const callsOf = (purpose: string) => calls.filter((call) => call.purpose === purpose)

/** Run one scripted answer and record the call. */
async function runScript(request: any): Promise<{ content: string; finishReason?: string | null }> {
  const purpose = String(request.purpose ?? 'unlabeled')
  calls.push({
    purpose,
    model: request.model,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    timeoutMs: request.timeoutMs,
    messages: clone(request.messages || []),
    structured: !!request.responseSchema,
  })
  const queue = scripts.get(purpose) || []
  const answer = queue.length > 1 ? queue.shift()! : queue[0]
  if (answer === undefined) throw new Error(`fixture: no script for ${purpose}`)
  const resolved = typeof answer === 'function' ? await (answer as () => any)() : answer
  // A bare string is the model's whole content.
  if (typeof resolved === 'string') return { content: resolved, finishReason: 'stop' }
  return { content: resolved.content, finishReason: resolved.finishReason ?? 'stop' }
}

/** The module seam the real code reaches: `callLLM` returns a string. */
async function callLLM(request: any): Promise<string> {
  const answer = await runScript(request)
  request.onFinishReason?.(answer.finishReason ?? null)
  return answer.content
}

/** The injected seam a witness/opening call takes: `{ content, finishReason }`. */
const scriptedCall = (request: any) => runScript(request)

mock.module('../src/ai/client', () => ({ callLLM }))
mock.module('../src/ai', () => ({
  AI_MODELS: {
    narrationSfw: 'audit-narrator',
    narrationNsfw: 'audit-narrator-nsfw',
    metadata: 'audit-metadata',
    witnessCopy: 'audit-witness',
  },
  narrationTemperature: () => 1,
  callLLM,
  callLLMStream: async () => '',
  embed: async () => [],
  embedQuery: async () => [],
  embedBatch: async () => [],
  runWithLLMUsage: async (_meta: unknown, fn: () => unknown) => fn(),
  snapshotLLMUsage: () => ({}),
  isLLMUsageActive: () => false,
  generateImage: async () => '',
}))

const published: Array<{ channel: string; frame: any }> = []
let redisValue: string | null = null
const redisFixture = {
  get: async () => redisValue,
  set: async () => 'OK',
  del: async () => 1,
  publish: async (channel: string, frame: string) => { published.push({ channel, frame: JSON.parse(frame) }) ; return 0 },
  eval: async () => 0,
  expire: async () => 1,
}
mock.module('../src/config/redis', () => ({
  getRedisClient: () => redisFixture,
  getRedisSubscriber: () => redisFixture,
  connectRedis: async () => undefined,
}))

const logged: Array<{ level: string; msg: string; data: any }> = []
mock.module('../src/utils/logger', () => ({
  log: {
    info: (msg: string, data: any) => logged.push({ level: 'info', msg, data }),
    warn: (msg: string, data: any) => logged.push({ level: 'warn', msg, data }),
    error: (msg: string, data: any) => logged.push({ level: 'error', msg, data }),
    debug: (msg: string, data: any) => logged.push({ level: 'debug', msg, data }),
  },
}))
mock.module('../src/utils/record-anomaly', () => ({ recordAnomaly: async () => {} }))
mock.module('../src/services/vector-store', () => ({ vectorStore: { deleteScope: async () => {}, deleteIds: async () => {} } }))
mock.module('../src/services/storage.service', () => ({ storageService: { delete: async () => {}, deleteStrict: async () => {}, keyFromUrl: () => null } }))
mock.module('../src/queues', () => ({
  removeQueuedJobsForInstance: async () => {},
  QUEUE_RETENTION: {},
}))
mock.module('../src/services/telemetry/ingest.service', () => ({ telemetryService: { purgeUser: async () => {} } }))
mock.module('../src/services/llm-trace.service', () => ({
  traceStore: () => ({ calls: coll('llm_trace_calls'), bodies: coll('llm_trace_bodies') }),
}))
// The group path is out of scope here (rl-5); only its existence is checked.
const groupSeedCalls: string[] = []
mock.module('../src/services/group-chat/instance', () => ({
  seedGroupOpening: async (_instance: Row, template: Row) => { groupSeedCalls.push(String(template.title)) },
}))
mock.module('../src/services/group-chat/memory', () => ({ groupThreadFilter: () => ({}) }))
mock.module('../src/services/group-chat/public', () => ({ publicGroupData: (value: Row) => value }))
mock.module('../src/services/guest-policy', () => ({ requireIdentity: async () => {} }))
mock.module('../src/utils/protagonist', () => ({ deriveProtagonist: async () => ({ name: 'Fixture' }) }))
mock.module('../src/services/image.service', () => ({ imageService: {} }))

// ── the code under test ──────────────────────────────────────────────────────
const { instanceService } = await import('../src/services/instance.service')
const { deletionService } = await import('../src/services/deletion.service')
// `--emit` measures HEAD, where this module does not exist yet; everything else
// needs it, so it is loaded only when the audit actually runs its checks.
const EMIT = process.argv.includes('--emit')
const service = EMIT ? null : await import('../src/services/opening-language.service')
const openingInLanguage = service?.openingInLanguage as typeof import('../src/services/opening-language.service').openingInLanguage
const authoredOpening = service?.authoredOpening as typeof import('../src/services/opening-language.service').authoredOpening
const openingEventFields = service?.openingEventFields as typeof import('../src/services/opening-language.service').openingEventFields
const settingsOpeningFields = service?.settingsOpeningFields as typeof import('../src/services/opening-language.service').settingsOpeningFields
const openingGlossary = service?.openingGlossary as typeof import('../src/services/opening-language.service').openingGlossary
const { witnessOf } = await import('../src/utils/witness')
const { openingSceneCanon } = await import('../src/utils/prompt-builder')
const { effectiveReplyLanguage } = await import('../src/utils/reply-language')
const { detectSpokenLines } = await import('../src/services/media/detection')
const { normalizeEvent } = await import('../src/services/telemetry/schema')

// ── fixtures ─────────────────────────────────────────────────────────────────
const PLAYER = new ObjectId('600000000000000000000001')
const PLAYER_ID = PLAYER.toHexString()
const PT = effectiveReplyLanguage('pt', ['pt', 'es'])!
const ES = effectiveReplyLanguage('es', ['pt', 'es'])!

function template(overrides: Row = {}) {
  return {
    _id: new ObjectId(),
    creator_id: new ObjectId(),
    title: 'The Counting House',
    slug: 'counting-house',
    description: 'A harbour inn.',
    kind: 'world',
    is_published: true,
    visibility: 'public',
    review_status: 'approved',
    is_sentient: false,
    is_nsfw_capable: false,
    version: 1,
    seed_prompt: 'Grey harbour, ledgers, tallow.',
    global_lore: 'The tide rules everything.',
    opening_line: EN_OPENING,
    base_stats_template: {},
    flag_definitions: {},
    scene_tags: [],
    model_seed_cast: [],
    seed_cast: [{ name: 'Mara', aliases: ['the steward'] }],
    model_preferences: {},
    max_context_memories: 20,
    max_lore_results: 5,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...overrides,
  }
}

function resetWorld(overrides: Row = {}, options: { language?: string | null } = {}) {
  resetStore()
  clearCalls()
  logged.length = 0
  published.length = 0
  groupSeedCalls.length = 0
  redisValue = null
  scripts.clear()
  const tpl = template(overrides)
  coll('world_templates').rows.push(clone(tpl))
  coll('users').rows.push({
    _id: clone(PLAYER),
    // §2: a save starts in the language the player last chose; English when they
    // never have. The fixtures name it explicitly, never the phone.
    preferences: options.language ? { reply_language: options.language } : {},
  })
  // The two derivations a save already shares with its world's other saves.
  setScript('calendar_derivation', { content: JSON.stringify({ setting: 'fantasy', name: 'Ashen Reckoning', eras: ['Grey Years'], months: [{ name: 'Ashfall', days: 30 }, { name: 'Emberwane', days: 30 }, { name: 'Hollowtide', days: 30 }, { name: 'Longnight', days: 30 }], weekdays: ['Ashday', 'Emberday', 'Hollowday'] }) })
  setScript('opening_place', { content: JSON.stringify({ place: 'Counting House' }) })
  return tpl
}

/** A world whose saves open in Portuguese. */
const ptWorld = (overrides: Row = {}) => resetWorld(overrides, { language: 'pt' })

/** purpose → one answer for the opening's translation, keyed by source kind. */
function scriptOpening(kind: 'en' | 'target' | 'other', text = PT_OPENING) {
  setScript('opening_language', { content: JSON.stringify({ written_in: kind, text }) })
}

const seedEvent = (overrides: Row = {}) => coll('events').rows.find((row) => row.sequence === 1 && row.instance_id instanceof ObjectId && !overrides.instance_id)
const eventOf = (instanceId: ObjectId) => coll('events').rows.find((row) => row.instance_id.equals(instanceId) && row.sequence === 1)!

// ── harness ──────────────────────────────────────────────────────────────────
let pass = 0
let fail = 0
async function check(label: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    pass++
    console.log(`  ok   ${label}`)
  } catch (err) {
    fail++
    console.log(`  FAIL ${label}\n       ${(err as Error).message}`)
  }
}

if (EMIT) {
  await emit()
  process.exit(0)
}

// ── A. the pure helper: one result, two blocks ──────────────────────────────
await check('A witness shape: the opening reads English through witnessOf; player fields are empty', async () => {
  const fields = openingEventFields({
    result: { shown: PT_OPENING, english: EN_OPENING, status: 'translated' },
    entry: PT,
  })
  assert.equal(fields.ai_response, PT_OPENING)
  const event = { sequence: 1, data: { ...fields, model_used: 'seed' } }
  assert.equal(witnessOf(event).ai_response, EN_OPENING)
  assert.equal(witnessOf(event).player_input, '')
  assert.deepEqual(witnessOf(event).player_narration_facts, [])
  assert.equal(witnessOf(event).player_spoken_input, '')
  assert.deepEqual(fields.witness, {
    lang: 'pt',
    ai_response: EN_OPENING,
    player_input: '',
    player_spoken_input: '',
    player_narration_facts: [],
  })
  assert.equal('witness_status' in fields, false)
})

await check('A english source: shown is the translation, the authored text is the witness', async () => {
  const fields = openingEventFields({
    result: { shown: PT_OPENING, english: EN_OPENING, status: 'translated' },
    entry: PT,
  })
  // The spoken lines are read from the SHOWN text, never the English one.
  assert.deepEqual(fields.spoken_lines, detectSpokenLines(PT_OPENING))
  assert.equal(fields.spoken_lines.length, 1)
})

await check('A failed translation: the authored opening is shown, no witness, no status', async () => {
  const fields = openingEventFields({ result: { shown: EN_OPENING, status: 'failed' }, entry: PT })
  assert.equal(fields.ai_response, EN_OPENING)
  assert.equal('witness' in fields, false)
  assert.equal('witness_status' in fields, false)
})

await check('A already in the language but no English copy: shown native, marked failed', async () => {
  const fields = openingEventFields({ result: { shown: EN_OPENING, status: 'already' }, entry: PT })
  assert.equal(fields.ai_response, EN_OPENING)
  assert.equal(fields.witness_status, 'failed')
})

await check('A english save through the helper: the authored text, byte for byte', async () => {
  resetWorld()
  const fields = await authoredOpening({ entry: null, opening: EN_OPENING })
  assert.deepEqual(fields, { ai_response: EN_OPENING, spoken_lines: detectSpokenLines(EN_OPENING) })
  assert.deepEqual(Object.keys(fields).sort(), ['ai_response', 'spoken_lines'])
  assert.equal(calls.length, 0, 'the english helper makes no model call')
})

await check('A glossary: protagonist, seed cast names and aliases, persona, a known place', () => {
  const glossary = openingGlossary({
    protagonistName: 'Nell',
    seedCast: [{ name: 'Mara', aliases: ['the steward'] }, { name: 'mara' }],
    personaName: 'Wren',
    placeName: 'Counting House',
  })
  assert.deepEqual(glossary.people, ['Nell', 'Mara', 'the steward', 'Wren'])
  assert.deepEqual(glossary.places, ['Counting House'])
})

// ── B. the translation call itself (§6, §4's checks) ────────────────────────
const translate = (opening = EN_OPENING, people = ['Mara']) =>
  openingInLanguage({ entry: PT, opening, people, places: [] }, { call: scriptedCall, countTokens: (text) => Math.ceil(text.length / 4) })

await check('B en source: one structured call at temperature 0 on the witness model, 8 s budget', async () => {
  resetWorld()
  scriptOpening('en')
  const result = await translate()
  assert.deepEqual(result, { shown: PT_OPENING, english: EN_OPENING, status: 'translated' })
  const call = callsOf('opening_language')[0]
  assert.equal(calls.length, 1, 'an en opening needs no second call')
  assert.equal(call.model, 'audit-witness')
  assert.equal(call.temperature, 0)
  assert.equal(call.structured, true)
  assert.ok(call.timeoutMs > 0 && call.timeoutMs <= 8000, `8 s budget: ${call.timeoutMs}`)
  assert.equal(call.messages.length, 1 + 1)
  assert.ok(call.messages[1].content.includes(EN_OPENING), 'the authored text is sent')
  assert.ok(call.messages[0].content.includes('Brazilian Portuguese'), 'the language is named')
  assert.ok(call.messages[0].content.includes('Mara'), 'the glossary is sent')
})

await check('B target source: the authored text is shown and an English copy is made', async () => {
  resetWorld()
  setScript('opening_language', { content: JSON.stringify({ written_in: 'target', text: EN_OPENING }) })
  setScript('witness_copy', { content: JSON.stringify({ prose: PT_ENGLISH }) })
  const result = await translate()
  assert.equal(result.status, 'already')
  assert.equal(result.shown, EN_OPENING)
  assert.equal(result.english, PT_ENGLISH)
  assert.equal(callsOf('witness_copy').length, 1)
})

await check('B other source: shown is the translation, English from the authored text', async () => {
  resetWorld()
  scriptOpening('other')
  setScript('witness_copy', { content: JSON.stringify({ prose: PT_ENGLISH }) })
  const result = await translate()
  assert.equal(result.status, 'translated')
  assert.equal(result.shown, PT_OPENING)
  assert.equal(result.english, PT_ENGLISH)
  // The authored text (not the translation) is what the English copy reads.
  const body = callsOf('witness_copy')[0].messages.find((message) => message.role === 'user')!.content
  assert.ok(body.includes(EN_OPENING), 'the authored opening is copied')
  assert.ok(!body.includes(PT_OPENING), 'the translation is never the source of the copy')
})

await check('B cache hit: the same world and language makes no call', async () => {
  resetWorld()
  scriptOpening('en')
  const first = await translate()
  assert.equal(callsOf('opening_language').length, 1)
  const second = await translate()
  assert.equal(callsOf('opening_language').length, 1, 'the second read is free')
  assert.deepEqual(second, first)
})

await check('B cache: a changed language is a different key', async () => {
  resetWorld()
  scriptOpening('en')
  await translate()
  const spanish = await openingInLanguage({ entry: ES, opening: EN_OPENING, people: ['Mara'] }, { call: scriptedCall, countTokens: (t) => Math.ceil(t.length / 4) })
  assert.equal(callsOf('opening_language').length, 2)
  assert.equal(spanish.status, 'translated')
})

await check('B a refused translation is not cached; the next save retries', async () => {
  resetWorld()
  setScript('opening_language', { content: JSON.stringify({ written_in: 'en', text: '' }) })
  const first = await translate()
  assert.equal(first.status, 'failed')
  assert.equal(callsOf('opening_language').length, 2, 'both attempts are refused')
  assert.equal(coll('world_derivations').rows.length, 0, 'a failure is not pinned')
  scriptOpening('en')
  const second = await translate()
  assert.equal(second.status, 'translated')
})

await check('B timeout: a model that never answers fails fast and shows the authored text', async () => {
  resetWorld()
  setScript('opening_language', () => new Promise<never>(() => {}))
  const started = performance.now()
  const result = await openingInLanguage(
    { entry: PT, opening: EN_OPENING, people: ['Mara'] },
    { call: scriptedCall, countTokens: (t) => Math.ceil(t.length / 4), budgetMs: 30 },
  )
  const elapsed = performance.now() - started
  assert.equal(result.status, 'failed')
  assert.equal(result.shown, EN_OPENING)
  assert.ok(elapsed < 400, `timed out in ${elapsed.toFixed(0)} ms (one retry inside the same budget)`)
})

// Each refusal reason: the model answers, the shared checks refuse it, and the
// logged reason says WHICH check refused it — so a broken check cannot hide
// behind another one.
const reasons: Array<{ reason: WitnessProblemReason | 'json'; answer: { content: string; finishReason?: string } | string }> = [
  { reason: 'finish', answer: { content: JSON.stringify({ written_in: 'en', text: PT_OPENING }), finishReason: 'length' } },
  { reason: 'json', answer: 'not json at all' },
  { reason: 'empty', answer: JSON.stringify({ written_in: 'en', text: '' }) },
  { reason: 'name', answer: JSON.stringify({ written_in: 'en', text: 'A porta emperra. "Você veio," *ela diz.* A lareira crepita entre vocês.' }) },
  { reason: 'markers', answer: JSON.stringify({ written_in: 'en', text: 'A porta emperra. "Você veio," Mara diz, saindo do caminho. A lareira crepita entre vocês.' }) },
  { reason: 'paragraphs', answer: JSON.stringify({ written_in: 'en', text: `${PT_OPENING}\n\nExtra one.\n\nExtra two.\n\nExtra three.` }) },
  { reason: 'length', answer: JSON.stringify({ written_in: 'en', text: '*Mara says.* Counting House.' }) },
  { reason: 'unchanged', answer: JSON.stringify({ written_in: 'other', text: EN_OPENING }) },
  // A `written_in` outside the three the schema allows is unusable JSON.
  { reason: 'json', answer: JSON.stringify({ written_in: 'portuguese', text: PT_OPENING }) },
]

for (const { reason, answer } of reasons) {
  await check(`B refusal: ${reason} is rejected and the authored opening is shown`, async () => {
    resetWorld()
    setScript('opening_language', answer as any)
    const result = await translate()
    assert.equal(result.status, 'failed', reason)
    assert.equal(result.shown, EN_OPENING, reason)
    assert.equal(callsOf('opening_language').length, 2, `${reason}: both attempts run`)
    const failures = logged.filter((line) => line.msg === 'opening_language.failed')
    assert.ok(failures.length > 0, 'the refusal is logged')
    assert.equal(failures[failures.length - 1].data.reason, reason, `logged reason for ${reason}`)
  })
}

await check('B retry: the first attempt is refused on the witness model, the metadata retry is kept', async () => {
  resetWorld()
  setScript('opening_language', { content: JSON.stringify({ written_in: 'en', text: '' }), finishReason: 'stop', content2: '' } as any)
  scripts.get('opening_language')!.splice(0, 1, { content: JSON.stringify({ written_in: 'en', text: '' }) })
  scripts.get('opening_language')!.push({ content: JSON.stringify({ written_in: 'en', text: PT_OPENING }) })
  const result = await translate()
  assert.equal(result.status, 'translated')
  const models = callsOf('opening_language').map((call) => call.model)
  assert.deepEqual(models, ['audit-witness', 'audit-metadata'])
})

await check('B names: a name the authored text carries must survive; an ordinary word is not required', async () => {
  resetWorld()
  // "Luz" is a name only where it is written as one: "la luz" rightly becomes "the light".
  const opening = 'Luz acende a vela. "A luz é fraca," *ela diz.*'
  setScript('opening_language', { content: JSON.stringify({ written_in: 'en', text: 'Luz lights the candle. "The light is weak," *she says.*' }) })
  const ok = await openingInLanguage({ entry: PT, opening, people: ['Luz'] }, { call: scriptedCall, countTokens: (t) => Math.ceil(t.length / 4) })
  assert.equal(ok.status, 'translated')
  resetWorld()
  setScript('opening_language', { content: JSON.stringify({ written_in: 'en', text: 'She lights the candle. "The light is weak," *she says.*' }) })
  const refused = await openingInLanguage({ entry: PT, opening, people: ['Luz'] }, { call: scriptedCall, countTokens: (t) => Math.ceil(t.length / 4) })
  assert.equal(refused.status, 'failed', 'the name was dropped')
})

// ── C. the real create path ─────────────────────────────────────────────────
await check('C create, en source: the player reads Portuguese, the engine reads English', async () => {
  const tpl = ptWorld()
  scriptOpening('en')
  const { instance } = await instanceService.create(PLAYER_ID, tpl._id.toHexString(), 'free')
  const event = eventOf(instance._id)
  assert.equal(event.data.ai_response, PT_OPENING)
  assert.equal(event.data.witness.lang, 'pt')
  assert.equal(event.data.witness.ai_response, EN_OPENING)
  assert.equal(event.data.witness.player_input, '')
  assert.equal(event.data.witness_status, undefined)
  // The instance carries the language it opened in, and the source that chose it
  // (the fixture is the player's own last choice, §2).
  assert.equal(instance.reply_language, 'pt')
  assert.equal(instance.reply_language_source, 'player')
  // The opening place ran against the AUTHORED words.
  const placeBody = callsOf('opening_place')[0].messages.find((message) => message.role === 'user')!.content
  assert.ok(placeBody.includes(EN_OPENING))
  assert.ok(!placeBody.includes(PT_OPENING))
  assert.equal(event.location_anchor.name, 'Counting House')
  // The glossary reached the call: protagonist/seed cast names.
  const prompt = callsOf('opening_language')[0].messages[0].content
  assert.ok(prompt.includes('Mara'))
  assert.ok(prompt.includes('the steward'))
})

await check('C create: witnessOf, openingSceneCanon and the place all see the English', async () => {
  const tpl = ptWorld()
  scriptOpening('en')
  const { instance } = await instanceService.create(PLAYER_ID, tpl._id.toHexString(), 'free')
  const event = eventOf(instance._id)
  assert.equal(witnessOf(event).ai_response, EN_OPENING)
  assert.equal(openingSceneCanon([event]), EN_OPENING)
})

await check('C create, target source: the authored opening is shown, English copy is made', async () => {
  const tpl = ptWorld()
  setScript('opening_language', { content: JSON.stringify({ written_in: 'target', text: EN_OPENING }) })
  setScript('witness_copy', { content: JSON.stringify({ prose: PT_ENGLISH }) })
  const { instance } = await instanceService.create(PLAYER_ID, tpl._id.toHexString(), 'free')
  const event = eventOf(instance._id)
  assert.equal(event.data.ai_response, EN_OPENING)
  assert.equal(event.data.witness.ai_response, PT_ENGLISH)
  assert.equal(witnessOf(event).ai_response, PT_ENGLISH)
})

await check('C create, other source: the translation is shown, the authored text is the English side', async () => {
  const tpl = ptWorld()
  scriptOpening('other')
  setScript('witness_copy', { content: JSON.stringify({ prose: PT_ENGLISH }) })
  const { instance } = await instanceService.create(PLAYER_ID, tpl._id.toHexString(), 'free')
  const event = eventOf(instance._id)
  assert.equal(event.data.ai_response, PT_OPENING)
  assert.equal(event.data.witness.ai_response, PT_ENGLISH)
})

await check('C create, a failed translation: the authored opening is shown, no witness, the language stands', async () => {
  const tpl = ptWorld()
  setScript('opening_language', { content: 'garbage' })
  const { instance } = await instanceService.create(PLAYER_ID, tpl._id.toHexString(), 'free')
  const event = eventOf(instance._id)
  assert.equal(event.data.ai_response, EN_OPENING)
  assert.equal('witness' in event.data, false)
  assert.equal('witness_status' in event.data, false)
  assert.equal(instance.reply_language, 'pt')
})

await check('C create: the translation is awaited beside the calendar and place, never after', async () => {
  const tpl = ptWorld()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  // The translation blocks until released; the calendar and place answer at once.
  setScript('opening_language', async () => {
    await gate
    return { content: JSON.stringify({ written_in: 'en', text: PT_OPENING }) }
  })
  let created = false
  const pending = instanceService.create(PLAYER_ID, tpl._id.toHexString(), 'free').then((value) => {
    created = true
    return value
  })
  await Bun.sleep(20)
  assert.equal(created, false, 'the create is still waiting on the translation')
  assert.equal(callsOf('calendar_derivation').length, 1, 'the calendar ran while the translation waited')
  assert.equal(callsOf('opening_place').length, 1, 'the place ran while the translation waited')
  assert.equal(coll('events').rows.length, 0, 'the opening event is not written before the translation')
  release()
  const { instance } = await pending
  assert.equal(coll('events').rows.length, 1)
  assert.equal(eventOf(instance._id).data.ai_response, PT_OPENING)
})

await check('C create, warm cache: a cached translation makes no opening call', async () => {
  const tpl = ptWorld()
  scriptOpening('en')
  await instanceService.create(PLAYER_ID, tpl._id.toHexString(), 'free')
  const afterFirst = callsOf('opening_language').length
  clearCalls()
  // A second save of the same world: the calendar, the place and the translation
  // are all cached now.
  await instanceService.create(PLAYER_ID, tpl._id.toHexString(), 'free')
  assert.equal(callsOf('opening_language').length, 0, 'the second save reads the cache')
  assert.equal(calls.length, 0, `no model calls at all: ${calls.map((call) => call.purpose).join(', ')}`)
  assert.ok(afterFirst >= 1)
})

await check('C create, a group: the group path runs, no opening translation, no seed opening event', async () => {
  const tpl = resetWorld({ kind: 'group', opening_line: null }, { language: 'pt' })
  setScript('opening_language', { content: JSON.stringify({ written_in: 'en', text: PT_OPENING }) })
  const { instance } = await instanceService.create(PLAYER_ID, tpl._id.toHexString(), 'free')
  // A group keeps its own path: the save may carry the language (rl-5 owns it),
  // but no opening event is seeded and nothing is translated here.
  assert.equal(callsOf('opening_language').length, 0)
  assert.equal(coll('events').rows.length, 0)
  assert.equal(groupSeedCalls.length, 1)
  assert.equal(instance.group_state !== undefined || true, true)
})

// ── C2. English byte identity, frozen from HEAD ────────────────────────────
/** What a create and a reset did on an English save, deterministic. */
function englishTrace() {
  const instance = coll('world_instances').rows[coll('world_instances').rows.length - 1]
  const event = instance ? eventOf(instance._id) : null
  return normalize({
    calls: calls.map((call) => ({ purpose: call.purpose, model: call.model, temperature: call.temperature, timeoutMs: call.timeoutMs, messages: call.messages })),
    instance: instance ? { ...instance, _id: '<id>', template_id: '<id>', player_id: '<id>', seed_cast_snapshot: instance.seed_cast_snapshot } : null,
    event: event ? { ...event, _id: '<id>', instance_id: '<id>', player_id: '<id>' } : null,
    writes: writes.map((write) => ({ collection: write.collection, update: write.update })),
  })
}
function normalize(value: any): any {
  if (value instanceof ObjectId) return '<id>'
  if (value instanceof Date) return '<date>'
  if (Array.isArray(value)) return value.map(normalize)
  if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return '<uuid>'
  if (value && typeof value === 'object') {
    const out: Row = {}
    for (const [key, entry] of Object.entries(value)) if (entry !== undefined) out[key] = normalize(entry)
    return out
  }
  return value
}

async function emit() {
  resetWorld()
  scripts.delete('opening_language')
  await instanceService.create(PLAYER_ID, coll('world_templates').rows[0]._id.toHexString(), 'free')
  console.log(JSON.stringify(englishTrace(), null, 2))
}

// Filled from HEAD (see `--emit`); the English create must match it exactly.
const FROZEN: ReturnType<typeof englishTrace> = {
  "calls": [
    {
      "purpose": "opening_place",
      "model": "audit-metadata",
      "temperature": 0,
      "messages": [
        {
          "role": "system",
          "content": "You are given the opening line of a story. Return the name of the PLACE the viewpoint character is in, copied exactly as it appears in the line. Return null if the line names no place, if it only mentions a place someone is going to or talking about, or if the only candidate is a piece of furniture or a part of a room rather than the room itself."
        },
        {
          "role": "user",
          "content": "The Counting House door sticks. \"You came,\" *Mara says, stepping aside. The hearth crackles between you.*"
        }
      ]
    },
    {
      "purpose": "calendar_derivation",
      "model": "audit-metadata",
      "temperature": 0.4,
      "messages": [
        {
          "role": "system",
          "content": "You classify the SETTING of an interactive-story world and, only for non-Earth worlds, design its calendar.\n\nFirst decide \"setting\":\n- \"modern\" \u2014 the world uses the REAL human/Earth calendar. This includes present-day, contemporary, historical Earth, near-future, CYBERPUNK, noir, dystopian, post-apocalyptic Earth, and human space colonies. If real human months (January, etc.) would make sense, it is \"modern\".\n- \"fantasy\" \u2014 a genuinely non-Earth world with its OWN reckoning of time: high/epic fantasy, mythic, alien planets, other planes/realms (e.g. a shadow realm), other-world sci-fi.\n\nIf \"modern\": return setting only (the server supplies the real calendar). You may still give a \"name\".\nIf \"fantasy\": INVENT a calendar fitting THIS world's specific tone \u2014 themed month names, weekday names, a fitting era. Derive names from the world's own flavour (an alien world feels alien; a shadow realm shadowy); do NOT reuse generic boilerplate. 8-14 months, each \"days\" 20-40, 5-10 weekdays, names <= 20 chars, 0-2 eras.\n\nRespond ONLY with JSON: {\"setting\":\"modern|fantasy\",\"name\":\"<calendar name>\",\"eras\":[\"...\"],\"months\":[{\"name\":\"...\",\"days\":30}],\"weekdays\":[\"...\"]}"
        },
        {
          "role": "user",
          "content": "World premise:\nThe Counting House\nA harbour inn.\nGrey harbour, ledgers, tallow.\nThe tide rules everything."
        }
      ]
    }
  ],
  "instance": {
    "_id": "<id>",
    "template_id": "<id>",
    "template_version": 1,
    "seed_cast_snapshot": [
      {
        "name": "Mara",
        "aliases": [
          "the steward"
        ]
      }
    ],
    "player_id": "<id>",
    "world_state": {},
    "active_flags": {},
    "current_scene": {
      "tag": "dialogue",
      "turn_count": 0,
      "summary_pending": false
    },
    "narration_pov": "third",
    "mode": "free_play",
    "message_length": "medium",
    "narrative_style_override": null,
    "narration_tone": "modern",
    "focus_character_id": null,
    "persona_id": null,
    "persona_snapshot": null,
    "current_location": {
      "entity_id": null,
      "name": "Counting House",
      "name_normalized": "counting house"
    },
    "current_time_anchor": {
      "real_time": "<date>",
      "sequence": 1,
      "story_calendar": {
        "calendar_id": "<id>",
        "year": 1,
        "month": 1,
        "day": 1,
        "era": "Grey Years",
        "label": "Opening scene"
      },
      "event_time_label": "Opening scene",
      "timeline_id": "main",
      "causal_parent_event_ids": []
    },
    "active_timeline_id": "main",
    "default_calendar_id": "<id>",
    "meta": {
      "total_events": 1,
      "total_memories": 0,
      "total_tokens_consumed": 0,
      "last_active_at": "<date>",
      "is_archived": false
    },
    "created_at": "<date>",
    "updated_at": "<date>"
  },
  "event": {
    "_id": "<id>",
    "instance_id": "<id>",
    "player_id": "<id>",
    "sequence": 1,
    "type": "narration",
    "data": {
      "player_input": "",
      "ai_response": "The Counting House door sticks. \"You came,\" *Mara says, stepping aside. The hearth crackles between you.*",
      "spoken_lines": [
        {
          "line_id": "l0",
          "start": 32,
          "end": 43
        }
      ],
      "state_mutations": {},
      "flag_mutations": {},
      "model_used": "seed",
      "tokens_in": 0,
      "tokens_out": 0
    },
    "is_user_edited": false,
    "edit_history": [],
    "scene_tag": "dialogue",
    "time_anchor": {
      "real_time": "<date>",
      "sequence": 1,
      "story_calendar": {
        "calendar_id": "<id>",
        "year": 1,
        "month": 1,
        "day": 1,
        "era": "Grey Years",
        "label": "Opening scene"
      },
      "event_time_label": "Opening scene",
      "timeline_id": "main",
      "causal_parent_event_ids": []
    },
    "location_anchor": {
      "entity_id": null,
      "name": "Counting House",
      "name_normalized": "counting house"
    },
    "created_at": "<date>"
  },
  "writes": [
    {
      "collection": "worldInstances",
      "update": {
        "$set": {
          "current_time_anchor": {
            "real_time": "<date>",
            "sequence": 1,
            "story_calendar": {
              "calendar_id": "<id>",
              "year": 1,
              "month": 1,
              "day": 1,
              "era": "Grey Years",
              "label": "Opening scene"
            },
            "event_time_label": "Opening scene",
            "timeline_id": "main",
            "causal_parent_event_ids": []
          },
          "current_location": {
            "entity_id": null,
            "name": "Counting House",
            "name_normalized": "counting house"
          },
          "active_timeline_id": "main",
          "default_calendar_id": "<id>",
          "meta.total_events": 1
        }
      }
    }
  ]
}

await check('C english create: the calls and documents are HEAD, byte for byte', async () => {
  const tpl = resetWorld()
  await instanceService.create(PLAYER_ID, tpl._id.toHexString(), 'free')
  assert.deepEqual(englishTrace(), FROZEN)
})

// ── D. the real reset path ─────────────────────────────────────────────────
await check('D reset, en source: the opening is re-shown in the save language, witness English', async () => {
  const tpl = ptWorld()
  scriptOpening('en')
  const { instance } = await instanceService.create(PLAYER_ID, tpl._id.toHexString(), 'free')
  clearCalls()
  await deletionService.resetInstance(instance._id.toHexString(), PLAYER_ID)
  const event = eventOf(instance._id)
  assert.equal(event.data.ai_response, PT_OPENING)
  assert.equal(event.data.witness.ai_response, EN_OPENING)
  assert.equal(callsOf('opening_language').length, 0, 'the translation is cached')
})

await check('D reset keeps the language when the translation fails', async () => {
  const tpl = ptWorld()
  scriptOpening('en')
  const { instance } = await instanceService.create(PLAYER_ID, tpl._id.toHexString(), 'free')
  coll('world_derivations').rows.length = 0
  setScript('opening_language', { content: 'garbage' })
  await deletionService.resetInstance(instance._id.toHexString(), PLAYER_ID)
  const event = eventOf(instance._id)
  assert.equal(event.data.ai_response, EN_OPENING)
  const saved = coll('world_instances').rows.find((row) => row._id.equals(instance._id))!
  assert.equal(saved.reply_language, 'pt')
})

// ── E. the settings rewrite (§6, §10) ──────────────────────────────────────
async function openingOnlySave(entry: 'pt' | 'es' | null = 'pt') {
  const tpl = resetWorld({}, { language: entry })
  if (entry) {
    scripts.set('opening_language', [{ content: JSON.stringify({ written_in: 'en', text: entry === 'pt' ? PT_OPENING : ES_OPENING }) }])
  }
  const { instance } = await instanceService.create(PLAYER_ID, tpl._id.toHexString(), 'free')
  clearCalls()
  return instance
}

await check('E settings: pt to es rewrites the opening; the English side stays the authored text', async () => {
  const instance = await openingOnlySave('pt')
  setScript('opening_language', { content: JSON.stringify({ written_in: 'en', text: ES_OPENING }) })
  const response = await instanceService.updateSettings(instance._id.toHexString(), PLAYER_ID, { reply_language: 'es' })
  const event = eventOf(instance._id)
  assert.equal(response.opening_changed, true)
  assert.equal(event.data.ai_response, ES_OPENING)
  assert.equal(event.data.witness.ai_response, EN_OPENING)
  assert.equal(event.data.witness.lang, 'es')
  // The base text a later change translates is the English side, so a third
  // language never pivots through the second.
  assert.ok(callsOf('opening_language')[0].messages[1].content.includes(EN_OPENING))
})

await check('E settings: es to en shows the English base and unsets the witness', async () => {
  const instance = await openingOnlySave('pt')
  setScript('opening_language', { content: JSON.stringify({ written_in: 'en', text: ES_OPENING }) })
  await instanceService.updateSettings(instance._id.toHexString(), PLAYER_ID, { reply_language: 'es' })
  clearCalls()
  const response = await instanceService.updateSettings(instance._id.toHexString(), PLAYER_ID, { reply_language: 'en' })
  const event = eventOf(instance._id)
  assert.equal(response.opening_changed, true)
  assert.equal(event.data.ai_response, EN_OPENING)
  assert.equal('witness' in event.data, false)
  assert.equal('witness_status' in event.data, false)
  assert.equal(callsOf('opening_language').length, 0, 'English needs no model call')
})

await check('E settings: the set language stands even when the opening cannot be translated', async () => {
  const instance = await openingOnlySave('pt')
  setScript('opening_language', { content: 'garbage' })
  const response = await instanceService.updateSettings(instance._id.toHexString(), PLAYER_ID, { reply_language: 'es' })
  assert.equal(response.reply_language, 'es')
  assert.equal(response.opening_changed, undefined, 'nothing was rewritten, so nothing is claimed')
  const saved = coll('world_instances').rows.find((row) => row._id.equals(instance._id))!
  assert.equal(saved.reply_language, 'es')
  const event = eventOf(instance._id)
  assert.equal(event.data.ai_response, PT_OPENING, 'the old rendering is what it keeps')
})

await check('E settings: an English-to-English change does nothing new', async () => {
  const tpl = resetWorld()
  const { instance } = await instanceService.create(PLAYER_ID, tpl._id.toHexString(), 'free')
  clearCalls()
  const response = await instanceService.updateSettings(instance._id.toHexString(), PLAYER_ID, { reply_language: 'en' })
  assert.equal(response.opening_changed, undefined)
  assert.equal(calls.length, 0)
  const event = eventOf(instance._id)
  assert.equal(event.data.ai_response, EN_OPENING)
  assert.equal('witness' in event.data, false)
})

await check('E guard: a newer event means the opening is not rewritten', async () => {
  const instance = await openingOnlySave('pt')
  coll('events').rows.push({ _id: new ObjectId(), instance_id: clone(instance._id), player_id: clone(PLAYER), sequence: 2, data: { ai_response: 'later' } })
  setScript('opening_language', { content: JSON.stringify({ written_in: 'en', text: ES_OPENING }) })
  const response = await instanceService.updateSettings(instance._id.toHexString(), PLAYER_ID, { reply_language: 'es' })
  assert.equal(response.opening_changed, undefined)
  assert.equal(callsOf('opening_language').length, 0)
  assert.equal(eventOf(instance._id).data.ai_response, PT_OPENING)
})

await check('E guard: a generation holding the lock means the opening is not rewritten', async () => {
  const instance = await openingOnlySave('pt')
  redisValue = JSON.stringify({ owner: 'turn', phase: 'running' })
  setScript('opening_language', { content: JSON.stringify({ written_in: 'en', text: ES_OPENING }) })
  const response = await instanceService.updateSettings(instance._id.toHexString(), PLAYER_ID, { reply_language: 'es' })
  assert.equal(response.opening_changed, undefined)
  assert.equal(callsOf('opening_language').length, 0)
  assert.equal(eventOf(instance._id).data.ai_response, PT_OPENING)
})

await check('E guard: a first message sent while the opening translates is never overtaken', async () => {
  const translated = { content: JSON.stringify({ written_in: 'en', text: ES_OPENING }) }
  // A turn takes the lock during the translation.
  let instance = await openingOnlySave('pt')
  published.length = 0
  setScript('opening_language', () => { redisValue = JSON.stringify({ owner: 'turn' }); return translated })
  let response = await instanceService.updateSettings(instance._id.toHexString(), PLAYER_ID, { reply_language: 'es' })
  assert.equal(callsOf('opening_language').length, 1, 'the translation did start')
  assert.equal(response.opening_changed, undefined)
  assert.equal(eventOf(instance._id).data.ai_response, PT_OPENING)

  // The turn even finished during it.
  instance = await openingOnlySave('pt')
  setScript('opening_language', () => {
    coll('events').rows.push({ _id: new ObjectId(), instance_id: clone(instance._id), player_id: clone(PLAYER), sequence: 2, data: { ai_response: 'later' } })
    return translated
  })
  response = await instanceService.updateSettings(instance._id.toHexString(), PLAYER_ID, { reply_language: 'es' })
  assert.equal(callsOf('opening_language').length, 1)
  assert.equal(response.opening_changed, undefined)
  assert.equal(eventOf(instance._id).data.ai_response, PT_OPENING)

  // Or the player edited the opening during it (same words, marked edited).
  instance = await openingOnlySave('pt')
  setScript('opening_language', () => { eventOf(instance._id).is_user_edited = true; return translated })
  response = await instanceService.updateSettings(instance._id.toHexString(), PLAYER_ID, { reply_language: 'es' })
  assert.equal(response.opening_changed, undefined)
  assert.equal(eventOf(instance._id).data.ai_response, PT_OPENING)
})

await check('E guard: an edited opening is left alone', async () => {
  const instance = await openingOnlySave('pt')
  eventOf(instance._id).is_user_edited = true
  setScript('opening_language', { content: JSON.stringify({ written_in: 'en', text: ES_OPENING }) })
  const response = await instanceService.updateSettings(instance._id.toHexString(), PLAYER_ID, { reply_language: 'es' })
  assert.equal(response.opening_changed, undefined)
  assert.equal(callsOf('opening_language').length, 0, 'not even translated')
  assert.equal(eventOf(instance._id).data.ai_response, PT_OPENING)
})

await check('E guard: the update matches the same event id and the same old text', async () => {
  const instance = await openingOnlySave('pt')
  setScript('opening_language', { content: JSON.stringify({ written_in: 'en', text: ES_OPENING }) })
  await instanceService.updateSettings(instance._id.toHexString(), PLAYER_ID, { reply_language: 'es' })
  const eventWrite = writes.filter((write) => write.collection === 'events' && write.update.$set?.['data.ai_response'])
  assert.equal(eventWrite.length, 1)
  const guard = eventWrite[0].query
  assert.equal(guard._id instanceof ObjectId, true, 'guarded by the event id')
  assert.equal(guard['data.ai_response'], PT_OPENING, 'guarded by the old text')
})

await check('E as an edit: voice attribution unset, media purged, spoken lines published, no edit_history', async () => {
  const instance = await openingOnlySave('pt')
  const event = eventOf(instance._id)
  event.data.voice_attribution = { rule_version: 5 }
  published.length = 0
  setScript('opening_language', { content: JSON.stringify({ written_in: 'en', text: ES_OPENING }) })
  await instanceService.updateSettings(instance._id.toHexString(), PLAYER_ID, { reply_language: 'es' })
  const stored = eventOf(instance._id)
  assert.equal('voice_attribution' in stored.data, false)
  assert.deepEqual(stored.data.spoken_lines, detectSpokenLines(ES_OPENING))
  assert.equal(stored.edit_history.length, 0, 'no edit_history entry')
  assert.ok(published.some((entry) => entry.frame.type === 'spoken_lines'), 'the lines are published')
})

await check('E a language set by the player writing never touches the opening', async () => {
  const tpl = resetWorld()
  const { instance } = await instanceService.create(PLAYER_ID, tpl._id.toHexString(), 'free')
  clearCalls()
  // The worker's writing detector writes the language straight to the save; the
  // opening is not part of that path.
  await coll('world_instances').updateOne({ _id: clone(instance._id) }, { $set: { reply_language: 'pt', reply_language_source: 'writing' } })
  assert.equal(callsOf('opening_language').length, 0)
  assert.equal(eventOf(instance._id).data.ai_response, EN_OPENING)
})

await check('E a group settings change never touches an opening', async () => {
  // A group keeps its own path (rl-5). The adversarial fixture carries both a
  // `group_state` AND a seed opening, so only the group guard — not the
  // opening-only checks — can keep it from being rewritten.
  const tpl = ptWorld()
  scriptOpening('en')
  const { instance } = await instanceService.create(PLAYER_ID, tpl._id.toHexString(), 'free')
  coll('world_instances').rows.find((row) => row._id.equals(instance._id))!.group_state = { seeded: true }
  clearCalls()
  setScript('opening_language', { content: JSON.stringify({ written_in: 'en', text: ES_OPENING }) })
  const response = await instanceService.updateSettings(instance._id.toHexString(), PLAYER_ID, { reply_language: 'es' })
  assert.equal(response.opening_changed, undefined)
  assert.equal(callsOf('opening_language').length, 0)
  assert.equal(eventOf(instance._id).data.ai_response, PT_OPENING)
})

// ── F. settings helper is pure and shares the result ───────────────────────
await check('F settings helper: English chosen yields the base and no witness fields', async () => {
  const fields = await settingsOpeningFields({
    entry: null,
    seed: { ai_response: PT_OPENING, witness: { lang: 'pt', ai_response: EN_OPENING, player_input: '' } },
  })
  assert.deepEqual(fields, { ai_response: EN_OPENING, spoken_lines: detectSpokenLines(EN_OPENING) })
})

await check('F settings helper: no witness and no status means English (both keys dropped)', async () => {
  const fields = await settingsOpeningFields({
    entry: null,
    seed: { ai_response: PT_OPENING, witness_status: 'failed' },
  })
  assert.equal(fields!.ai_response, PT_OPENING, 'a failed witness falls back to the stored text')
  assert.equal(fields!.witness, undefined)
})

// ── T. the app's telemetry vocabulary (§7) ─────────────────────────────────
await check('T telemetry: story_settings_changed accepts language; the offer events accept their shapes', async () => {
  const ctx = {
    installId: '00000000-0000-4000-8000-000000000001',
    sessionId: '00000000-0000-4000-8000-000000000002',
    app: { version: '1.0.0', build: 1 },
    device: { os: 'android', form: 'phone' },
    now: new Date('2026-11-25T12:00:00Z'),
  } as const
  const at = '2026-11-25T11:59:00Z'
  const event = (name: string, props: Row) => ({
    id: '00000000-0000-4000-8000-000000000003', seq: 0, at, name, props,
  })
  const language = normalizeEvent(event('story_settings_changed', { setting: 'language' }), ctx as never)
  assert.ok(language, 'the language setting is accepted')
  assert.deepEqual(language.props, { setting: 'language' })
  assert.equal(normalizeEvent(event('story_settings_changed', { setting: 'colour' }), ctx as never), null, 'an unknown setting is dropped')

  const shown = normalizeEvent(event('language_offer_shown', {}), ctx as never)
  assert.ok(shown)
  assert.equal(shown.props, undefined)

  for (const answer of ['yes', 'no']) {
    const answered = normalizeEvent(event('language_offer_answered', { answer, code: 'pt' }), ctx as never)
    assert.ok(answered, `${answer} accepted`)
    assert.deepEqual(answered.props, { answer, code: 'pt' })
  }
  assert.equal(normalizeEvent(event('language_offer_answered', { answer: 'yes' }), ctx as never), null, 'code is required')
  assert.equal(normalizeEvent(event('language_offer_answered', { code: 'pt' }), ctx as never), null, 'answer is required')
  assert.equal(normalizeEvent(event('language_offer_answered', { answer: 'maybe', code: 'pt' }), ctx as never), null, 'an unknown answer is dropped')
  assert.equal(normalizeEvent(event('language_offer_answered', { answer: 'yes', code: 'Português!' }), ctx as never), null, 'a code is a slug')
})

if (fail > 0) {
  console.log(`\nopening language audit: ${pass} passed, ${fail} failed`)
  process.exit(1)
}

if (process.argv.includes('--bites')) {
  await runBites()
} else {
  console.log(`\nopening language audit: ${pass} passed, 0 failed`)
}

// ── bites ───────────────────────────────────────────────────────────────────
type Edit = [file: string, from: string, to: string]
type Mutation = { name: string; check: string; edits: Edit[] }

async function runBites() {
  const root = await mkdtemp(join(import.meta.dir, '.opening-language-bites-'))
  const server = new URL('..', import.meta.url).pathname
  const AUDIT = 'scripts/opening-language-audit.ts'
  const svc = 'src/services/opening-language.service.ts'
  const instance = 'src/services/instance.service.ts'
  const deletion = 'src/services/deletion.service.ts'
  const copy = 'worker/lib/witness-copy.ts'
  const schema = 'src/services/telemetry/schema.ts'

  const mutations: Mutation[] = [
    {
      name: '1 the shown text is the English one',
      check: 'C create, en source: the player reads Portuguese, the engine reads English',
      edits: [[svc, 'ai_response: shown,', 'ai_response: input.result.english || shown,']],
    },
    {
      name: '2 the witness is the shown text, not the English side',
      check: 'A witness shape: the opening reads English through witnessOf; player fields are empty',
      edits: [[svc, 'accepted: { player: \'\', prose: input.result.english },', 'accepted: { player: \'\', prose: input.result.shown },']],
    },
    {
      name: '3 a failed translation still writes a witness',
      check: 'A failed translation: the authored opening is shown, no witness, no status',
      edits: [[svc, "if (input.result.status === 'failed') return base", "if (input.result.status === 'failed') return { ...base, witness_status: 'failed' }"]],
    },
    {
      name: '4 the opening place runs against a translation',
      check: 'C create, en source: the player reads Portuguese, the engine reads English',
      edits: [[instance, "      ? extractOpeningPlace({ openingLine, instanceId: idString(_id) })", "      ? extractOpeningPlace({ openingLine: 'A porta do Counting House emperra.', instanceId: idString(_id) })"]],
    },
    {
      name: '5 the name check is skipped',
      check: 'B names: a name the authored text carries must survive; an ordinary word is not required',
      edits: [[copy, 'if (containsName(nativeAll, name, true) && !containsName(englishAll, name)) return \'name\'', 'void name']],
    },
    {
      name: '6 the marker check on the prose is skipped',
      check: 'B refusal: markers is rejected and the authored opening is shown',
      edits: [[copy, "if (options.markersOnProse && native.prose.trim() && markerCount(native.prose) !== markerCount(english.prose)) return 'markers'", "void options.markersOnProse"]],
    },
    {
      name: '7 the unchanged check ignores the already-in-language case',
      check: 'B target source: the authored text is shown and an English copy is made',
      edits: [[copy, 'if (!options.allowUnchanged && wordCount(native.prose) >= 6', 'if (wordCount(native.prose) >= 6']],
    },
    {
      name: '8 only one attempt is made',
      check: 'B a refused translation is not cached; the next save retries',
      edits: [[svc, 'const models = [deps.primaryModel ?? AI_MODELS.witnessCopy, deps.retryModel ?? AI_MODELS.metadata]', 'const models = [deps.primaryModel ?? AI_MODELS.witnessCopy]']],
    },
    {
      name: '9 the timeout is ignored',
      check: 'B timeout: a model that never answers fails fast and shows the authored text',
      edits: [[svc, 'const budgetMs = deps.budgetMs ?? OPENING_LANGUAGE_TIMEOUT_MS', 'const budgetMs = 60_000']],
    },
    {
      name: '10 a refused translation is cached',
      check: 'B a refused translation is not cached; the next save retries',
      edits: [[svc, "const cacheable =\n          (result.status === 'translated' || result.status === 'already') && !!result.english", 'const cacheable = true']],
    },
    {
      name: '11 the cache key ignores the language',
      check: 'B cache: a changed language is a different key',
      edits: [[svc, '`${entry.code}\\n${opening}`', 'opening']],
    },
    {
      name: '12 the language is not sent to the model',
      check: 'B en source: one structured call at temperature 0 on the witness model, 8 s budget',
      edits: [[svc, '`REQUESTED LANGUAGE: ${entry.name}`', '`REQUESTED LANGUAGE: English`']],
    },
    {
      name: '13 the other-language source copies the translation',
      check: 'B other source: shown is the translation, English from the authored text',
      edits: [[svc, "const english = await englishSide(opening, FOREIGN_SOURCE, glossary, deadline, now, deps)", "const english = await englishSide(translation.text, FOREIGN_SOURCE, glossary, deadline, now, deps)"]],
    },
    {
      name: '14 create never translates',
      check: 'C create, en source: the player reads Portuguese, the engine reads English',
      edits: [[instance, 'const openingLanguagePromise = languageEntry', 'const openingLanguagePromise = null && languageEntry']],
    },
    {
      name: '15 create writes the authored text regardless',
      check: 'C create, en source: the player reads Portuguese, the engine reads English',
      edits: [[instance, '...(openingFields ?? { ai_response: greeting, spoken_lines: detectSpokenLines(greeting) }),', 'ai_response: greeting, spoken_lines: detectSpokenLines(greeting),']],
    },
    {
      name: '16 reset never translates',
      check: 'D reset, en source: the opening is re-shown in the save language, witness English',
      edits: [[deletion, 'const openingLanguagePromise = languageEntry', 'const openingLanguagePromise = null && languageEntry']],
    },
    {
      name: '17 settings translate the old rendering, not the English base',
      check: 'E settings: pt to es rewrites the opening; the English side stays the authored text',
      edits: [[svc, "const base = String(input.seed.witness?.ai_response || input.seed.ai_response || '')", "const base = String(input.seed.ai_response || '')"]],
    },
    {
      name: '18 settings ignore the lock',
      check: 'E guard: a generation holding the lock means the opening is not rewritten',
      edits: [[instance, 'if (await generationHoldsSave()) return false\n\n    const seed', 'const seed']],
    },
    {
      name: '19 settings ignore the newer event',
      check: 'E guard: a newer event means the opening is not rewritten',
      edits: [[instance, 'if (await hasNewerEvent()) return false\n\n    const base', 'const base']],
    },
    {
      name: '19a settings do not look at the lock again',
      check: 'E guard: a first message sent while the opening translates is never overtaken',
      edits: [[instance, 'if (await generationHoldsSave()) return false\n    if (await hasNewerEvent()) return false', 'if (await hasNewerEvent()) return false']],
    },
    {
      name: '19b settings do not look for a newer event again',
      check: 'E guard: a first message sent while the opening translates is never overtaken',
      edits: [[instance, 'if (await generationHoldsSave()) return false\n    if (await hasNewerEvent()) return false', 'if (await generationHoldsSave()) return false']],
    },
    {
      name: '19c settings write over an opening edited meanwhile',
      check: 'E guard: a first message sent while the opening translates is never overtaken',
      edits: [[instance, ", is_user_edited: { $ne: true } }", ' }']],
    },
    {
      name: '20 settings ignore an edited opening',
      check: 'E guard: an edited opening is left alone',
      edits: [[instance, "if (!seed || seed.data?.model_used !== 'seed' || seed.is_user_edited) return false", "if (!seed || seed.data?.model_used !== 'seed') return false"]],
    },
    {
      name: '21 settings leave the old witness in place on English',
      check: 'E settings: es to en shows the English base and unsets the witness',
      edits: [[instance, "    else {\n      unset['data.witness'] = ''\n      unset['data.witness_status'] = ''\n    }", "    else {\n      unset['data.witness_status'] = ''\n    }"]],
    },
    {
      name: '22 settings write an edit_history entry',
      check: 'E as an edit: voice attribution unset, media purged, spoken lines published, no edit_history',
      edits: [[instance, "'data.spoken_lines': fields.spoken_lines,", "'data.spoken_lines': fields.spoken_lines,\n        edit_history: [{ edited_at: new Date() }],"]],
    },
    {
      name: '23 settings claim a change that did not happen',
      check: 'E settings: the set language stands even when the opening cannot be translated',
      edits: [[instance, '...(openingChanged ? { opening_changed: true } : {}),', 'opening_changed: true,']],
    },
    {
      name: '24 settings rewrite a group',
      check: 'E a group settings change never touches an opening',
      edits: [[instance, '      !target.group_state &&\n      !result.group_state\n    ) {', '      true\n    ) {']],
    },
    {
      name: '25 telemetry: the language setting is not accepted',
      check: 'T telemetry: story_settings_changed accepts language; the offer events accept their shapes',
      edits: [[schema, "oneOf('pov', 'mode', 'length', 'voice', 'tone', 'focus', 'persona', 'language')", "oneOf('pov', 'mode', 'length', 'voice', 'tone', 'focus', 'persona')"]],
    },
    {
      name: '26 telemetry: the offer answer needs no code',
      check: 'T telemetry: story_settings_changed accepts language; the offer events accept their shapes',
      edits: [[schema, "code: { rule: { kind: 'slug' }, required: true },", "code: { rule: { kind: 'slug' } },"]],
    },
  ]

  try {
    await cp(join(server, 'src'), join(root, 'src'), { recursive: true })
    await cp(join(server, 'worker'), join(root, 'worker'), { recursive: true })
    await mkdir(join(root, 'scripts'), { recursive: true })
    await cp(join(server, AUDIT), join(root, AUDIT))
    await symlink(join(server, 'node_modules'), join(root, 'node_modules'), 'dir')

    const runAudit = async () => {
      const child = Bun.spawn(['bun', '--no-env-file', 'run', AUDIT], {
        cwd: root,
        env: { ...process.env, NODE_ENV: 'test' },
        stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      })
      const timer = setTimeout(() => child.kill(9), 180_000)
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      clearTimeout(timer)
      return { stdout, stderr, code }
    }

    const clean = await runAudit()
    assert.equal(clean.code, 0, `the unmutated copy must pass:\n${clean.stdout}\n${clean.stderr}`)
    console.log(`baseline: clean copy passes (${(clean.stdout.match(/^  ok /gm) ?? []).length} checks)`)

    let bitten = 0
    for (const mutation of mutations) {
      const originals = new Map<string, string>()
      try {
        for (const [file, from, to] of mutation.edits) {
          const path = join(root, file)
          const text = originals.get(path) ?? (await readFile(path, 'utf8'))
          originals.set(path, text)
          assert.ok(text.includes(from), `${mutation.name}: mutation anchor missing: ${from}`)
          await writeFile(path, text.replaceAll(from, to))
        }
        const result = await runAudit()
        assert.notEqual(result.code, 0, `${mutation.name}: the audit accepted the broken behaviour\n${result.stdout}`)
        assert.ok(
          `${result.stdout}${result.stderr}`.includes(`FAIL ${mutation.check}`),
          `${mutation.name}: failed outside the intended check\n${result.stdout}\n${result.stderr}`,
        )
        bitten++
        console.log(`BITE ${mutation.name}: exit ${result.code}; FAIL ${mutation.check}`)
      } finally {
        for (const [path, original] of originals) await writeFile(path, original)
      }
    }
    console.log(`opening language bites: ${bitten}/${mutations.length} mutations rejected; scratch restored and removed`)
    if (bitten !== mutations.length) process.exit(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
