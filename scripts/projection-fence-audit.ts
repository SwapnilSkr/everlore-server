/** In-memory Mongo + scripted extractors; never loads env, connects, or pays. */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

// Production default is 1 (batching off); this audit exercises the batch path.
process.env.CHARACTER_PROJECTION_BATCH_MAX ??= '4'

if (process.argv.includes('--extractor-only')) {
  await auditRealExtractor()
  process.exit(0)
}

// Deliberately flexible Mongo fixture documents/queries, including dotted keys.
type Doc = Record<string, any>
const copy = <T>(value: T): T => {
  if (value instanceof ObjectId) return new ObjectId(value) as T
  if (value instanceof Date) return new Date(value) as T
  if (Array.isArray(value)) return value.map(copy) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)])) as T
  return value
}
const get = (row: Doc, key: string) => key.split('.').reduce((value, k) => value?.[k], row)
const scalar = (v: any) => v instanceof ObjectId ? v.toHexString() : v instanceof Date ? v.getTime() : v
function matches(row: Doc, query: Doc): boolean {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some((q: Doc) => matches(row, q))
    const actual = get(row, key)
    if (expected && typeof expected === 'object' && !(expected instanceof ObjectId) && !(expected instanceof Date)) {
      return Object.entries(expected).every(([op, v]: [string, any]) => {
        if (op === '$exists') return (actual !== undefined) === v
        if (op === '$ne') return scalar(actual) !== scalar(v)
        if (op === '$lt') return scalar(actual) < scalar(v)
        if (op === '$lte') return scalar(actual) <= scalar(v)
        if (op === '$gt') return scalar(actual) > scalar(v)
        if (op === '$in') return v.includes(actual)
        if (op === '$nin') return !v.includes(actual)
        throw new Error(`unhandled query operator ${op}`)
      })
    }
    return scalar(actual) === scalar(expected)
  })
}
function set(row: Doc, key: string, value: any, unset = false) {
  const parts = key.split('.')
  const field = parts.pop()!
  const parent = parts.reduce((v, k) => v[k] ??= {}, row)
  if (unset) delete parent[field]
  else parent[field] = copy(value)
}
class Collection {
  rows: Doc[] = []
  find(query: Doc) {
    let rows = this.rows.filter((r) => matches(r, query))
    const cursor = {
      sort: (order: Doc) => { const [key, direction] = Object.entries(order)[0]; rows.sort((a, b) => (scalar(get(a, key)) - scalar(get(b, key))) * direction); return cursor },
      limit: (n: number) => { rows = rows.slice(0, n); return cursor },
      next: async () => rows[0] ? copy(rows[0]) : null,
      toArray: async () => copy(rows),
    }
    return cursor
  }
  async insertMany(rows: Doc[]) { this.rows.push(...copy(rows)); return {} }
  async updateMany(query: Doc, update: Doc) {
    for (const row of this.rows.filter((r) => matches(r, query))) await this.updateOne({ _id: row._id }, update)
  }
  async findOne(query: Doc) { return this.find(query).next() }
  async updateOne(query: Doc, update: Doc) {
    const row = this.rows.find((r) => matches(r, query))
    if (!row) return { matchedCount: 0, modifiedCount: 0 }
    if (update.$set?.['data.codex_projection_claimed_at']) claimWrites.push(row.sequence)
    if (update.$set?.['data.codex_projection_status'] === 'completed') {
      assert.ok(update.$set['data.codex_projection_ms'], 'completed status and timings must share one $set')
    }
    for (const [key, value] of Object.entries(update.$set || {})) set(row, key, value)
    for (const key of Object.keys(update.$unset || {})) set(row, key, undefined, true)
    return { matchedCount: 1, modifiedCount: 1 }
  }
}
const attributionMode = process.argv.includes('--attribution-batch-only')
const realExtractorMode = process.argv.includes('--tolerant-batch-only') || attributionMode
let attributionReply: 'tagged' | 'envelope' | 'conflict' | 'all' | 'empty' = 'tagged'
const modelCalls: string[] = []
const claimWrites: number[] = []
const tolerantNames = ['Someone', 'Rowan', 'Ellis', 'Morgan', 'Harper', 'Quinn', 'Blair']
function tolerantCharacters(sequence: number) {
  return tolerantNames.map((name, index) => ({ sequence, name,
    resolved_name: null, role: null, appearance: null, appearance_evidence: null,
    persona: index % 2 ? 42 : null, disposition_to_player: null, hidden_thought: false,
    aliases: null, identity_kind: null, is_protagonist: null,
    immutable_facts: Array.from({ length: 8 }, (_, n) => `fact-${n}`),
    mutable_state: [`turn-${sequence}`, ...Array.from({ length: 7 }, (_, n) => n)],
    retire_state: null, interaction_hints: null, relationship_deltas: null,
    relationship_evidence: null, relationship_initialization: null, relationship_state: null, relationship_facts: null,
  }))
}
const events = new Collection()
const characters = new Collection()
const entities = new Collection()
const kinshipCalls: Doc[] = []
const batchCalls: number[][] = []
let batchFailure = false
let dropped = 0
let batchProposal: (sequence: number) => Doc[] = scriptedDelta
const anomalies: Doc[] = []
const logs: Array<{ name: string; data: Doc }> = []
const applied: number[] = []
const observed: Array<{ sequence: number; facts: string[] }> = []
let extract: (params: Doc) => Promise<Doc[]> = async () => []
const unavailable = () => { throw new Error('Network/dependency reached in pure projection audit') }
globalThis.fetch = Object.assign(async () => unavailable(), { preconnect: unavailable })
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
let publishFailure = false
let graphFailure = false
let anomalyFailure = false
let signalFailure = false
const signalRows: Doc[] = []
let lifecycleCalls = 0
mock.module('../src/config/mongo', () => ({ mongoColl: { events: () => events, characters: () => characters, entities: () => entities, signalLedger: () => ({ updateOne: async (_query: Doc, update: Doc) => {
  if (signalFailure) throw new Error('scripted signal write failure')
  signalRows.push(copy(update.$set))
} }) } }))
mock.module('../src/utils/live-instance', () => ({ liveInstanceExists: async () => true }))
mock.module('../src/utils/logger', () => ({ log: {
  info: (name: string, data: Doc) => logs.push({ name, data }),
  warn: (name: string, data: Doc) => logs.push({ name, data }),
} }))
mock.module('../src/utils/record-anomaly', () => ({ recordAnomaly: async (row: Doc) => { if (anomalyFailure) throw new Error('scripted anomaly write failure'); anomalies.push(row) } }))
mock.module('../src/config/redis', () => ({ getRedisClient: () => ({ publish: async () => { if (publishFailure) throw new Error('scripted publish failure') } }) }))
mock.module('../src/services/instance.service', () => ({ instanceService: { loadSession: async () => ({ is_sentient: false, seed_prompt: 'audit' }) } }))
mock.module('../src/services/entity-graph.service', () => ({ normalizeEntityName: (s: string) => s.toLowerCase().trim(), entityGraphService: {
  syncCodexEntities: async ({ cards }: Doc) => {
    if (graphFailure) throw new Error('scripted graph failure')
    return new Map(cards.map((c: Doc) => [c.name_normalized, { _id: c._id }]))
  },
  syncRelationshipEdges: async () => {}, listKnownLocations: async () => [],
  ensurePlayerEntity: async () => ({ _id: new ObjectId() }),
  ensureStubEntity: async () => new ObjectId(),
} }))
mock.module('../src/services/kinship-graph.service', () => ({ kinshipGraphService: {
  applyRelationAssertions: async (p: Doc) => { kinshipCalls.push(copy(p)); return { written: p.assertions.length, notes: [] } },
  seedPremiseKinship: async () => ({ seeded: 0, notes: [] }),
} }))
mock.module('../src/services/relation-candidate.service', () => ({ relationCandidateService: { propose: async () => {} } }))
mock.module('../src/services/memory-supersession.service', () => ({ memorySupersessionService: { supersedeMemories: async () => {} } }))
mock.module('../worker/lib/codex-compactor', () => ({ compactImmutableFacts: unavailable }))
if (!realExtractorMode) mock.module('../worker/lib/character-codex-extractor', () => ({
  looksLikeUnnamedLabel: () => false,
  extractCharacterCodexDeltas: async (params: Doc) => {
    observed.push({ sequence: params.sequence, facts: [...(params.existing[0]?.mutable_state || [])] })
    const deltas = await extract(params)
    params.onRaw?.('{}')
    if (params.playerInput === 'timing') await delay(20)
    return deltas
  },
  extractCharacterCodexBatch: async (params: Doc) => {
    batchCalls.push(params.turns.map((t: Doc) => t.sequence))
    if (batchFailure) throw new Error('scripted invalid batch')
    // One model-call delay per batch; proposals stay tied to each input turn.
    const first = params.turns[0]
    const firstDeltas = await extract({ ...params, ...first })
    const deltas = new Map<number, Doc[]>([[first.sequence, firstDeltas]])
    for (const turn of params.turns.slice(1)) deltas.set(turn.sequence, batchProposal(turn.sequence))
    params.onRaw?.('{}')
    return { deltas, droppedUnattributable: dropped }
  },
}))
else mock.module('../src/ai', () => ({
  AI_MODELS: { metadata: 'adjudicator', codexExtraction: 'extractor' },
  callLLM: async (p: Doc) => {
    modelCalls.push(p.model)
    if (p.model === 'adjudicator') return JSON.stringify({ reject: [], supplements: [] })
    const input = p.messages[1].content as string
    if (input.startsWith('{')) {
      const { turns } = JSON.parse(input)
      const rows = turns.map((t: Doc) => {
        let characters: Doc[] = tolerantCharacters(t.sequence)
        if (attributionReply === 'envelope') characters = characters.map(({ sequence, ...c }, index) => index % 2 ? { ...c, sequence: null } : c)
        if (attributionReply === 'conflict') characters.push({ sequence: t.sequence === 1 ? 2 : 1, name: 'Someone', mutable_state: ['WRONG TURN'] })
        if (attributionReply === 'all') characters = characters.map((c) => ({ ...c, sequence: 99 }))
        if (attributionReply === 'empty') characters = []
        return { sequence: t.sequence, characters, relation_assertions: null }
      })
      // Neither envelope order nor a familiar character name conveys a turn.
      if (attributionReply === 'envelope') rows.reverse()
      if (attributionReply === 'all') rows.push({ sequence: 99, characters: [{ name: 'Someone' }], relation_assertions: null })
      return JSON.stringify({ turns: rows, ...(attributionReply === 'all' ? { characters: [{ name: 'Someone' }] } : {}) })
    }
    const sequence = Number(input.match(/beat (\d+)/)?.[1])
    assert.ok(sequence, 'scripted single-turn source identifies its turn')
    return JSON.stringify({ characters: tolerantCharacters(sequence), relation_assertions: null })
  },
}))
const realCodex = await import('../src/services/character-codex.service')
const originalApply = realCodex.characterCodexService.applyDeltas.bind(realCodex.characterCodexService)
realCodex.characterCodexService.applyDeltas = async (p) => { applied.push(p.sequence); return originalApply(p) }
const originalLifecycle = realCodex.characterCodexService.applyLifecycleDeltas.bind(realCodex.characterCodexService)
realCodex.characterCodexService.applyLifecycleDeltas = async (p) => { lifecycleCalls++; return originalLifecycle(p) }
function scriptedDelta(sequence: number): Doc[] {
  return [{ name: 'Someone', mutable_state: [`turn-${sequence}`] }]
}
// Import only after every transitive runtime dependency has been replaced.
const { projectCharacterEvent, characterProjectionProcessor } = await import('../worker/processors/character-projection.processor')
const { fenceOnPriorProjection, withCharacterProjection, CHARACTER_PROJECTION_CLAIM_LEASE_MS: LEASE, CHARACTER_PROJECTION_ORDER_BUDGET_MS: BOUND, CHARACTER_PROJECTION_ORPHAN_GRACE_MS: GRACE } = await import('../worker/lib/character-projection-lease')

const realNow = Date.now
const realTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const realInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const flush = async () => { for (let i = 0; i < 150; i++) await Promise.resolve() }
class Clock {
  now = realNow()
  timers = new Map<number, { at: number; fn: () => void; repeat: number }>()
  id = 0
  install() {
    Date.now = () => this.now
    const add = (fn: () => void, ms = 0, repeat = 0) => {
      const id = ++this.id
      this.timers.set(id, { at: this.now + ms, fn, repeat })
      return id
    }
    globalThis.setTimeout = ((fn: () => void, ms: number) => add(fn, ms)) as unknown as typeof setTimeout
    globalThis.setInterval = ((fn: () => void, ms: number) => add(fn, ms, ms)) as unknown as typeof setInterval
    globalThis.clearTimeout = ((id: number) => { this.timers.delete(id) }) as unknown as typeof clearTimeout
    globalThis.clearInterval = globalThis.clearTimeout as unknown as typeof clearInterval
  }
  async advance(ms: number) {
    const target = this.now + ms
    await flush()
    while (true) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > target) break
      this.now = next[1].at
      if (next[1].repeat) next[1].at += next[1].repeat
      else this.timers.delete(next[0])
      next[1].fn()
      await flush()
    }
    this.now = target
    await flush()
  }
  restore() {
    Date.now = realNow
    globalThis.setTimeout = realTimeout
    globalThis.clearTimeout = realClearTimeout
    globalThis.setInterval = realInterval
    globalThis.clearInterval = realClearInterval
  }
}
const iid = new ObjectId()
const pid = new ObjectId()
const base = { instanceId: iid.toHexString(), playerId: pid.toHexString() }
const params = (e: Doc) => ({ ...base, eventId: e._id.toHexString() })
function event(sequence: number, data: Doc = {}): Doc {
  const row = { _id: new ObjectId(), instance_id: iid, player_id: pid, sequence, type: 'narration', created_at: new Date(Date.now()), data: {
    model_used: 'audit', player_input: 'Continue', ai_response: 'An action.', codex_projection_status: 'pending', ...data,
  } }
  events.rows.push(row)
  return row
}
function fixture() {
  publishFailure = batchFailure = graphFailure = anomalyFailure = signalFailure = false
  signalRows.length = modelCalls.length = claimWrites.length = 0
  lifecycleCalls = dropped = 0
  attributionReply = 'tagged'
  batchCalls.length = kinshipCalls.length = 0
  batchProposal = scriptedDelta
  events.rows = []
  characters.rows = [{ _id: new ObjectId(), instance_id: iid, player_id: pid, canonical_name: 'Someone', name_normalized: 'someone', aliases: [], mutable_state: ['before'], immutable_facts: [], disposition_to_player: '', hidden_thought: '', first_seen_sequence: 0, last_seen_sequence: 0, mention_count: 1, created_at: new Date(0), updated_at: new Date(0) }]
  anomalies.length = logs.length = applied.length = observed.length = 0
  extract = async (p) => [{ name: 'Someone', mutable_state: [`turn-${p.sequence}`] }]
  const clock = new Clock()
  clock.install()
  return clock
}
let passed = 0
let failed = 0
async function check(name: string, fn: (clock: Clock) => Promise<void>) {
  const clock = fixture()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      fn(clock),
      new Promise<never>((_, reject) => { timeout = realTimeout(() => reject(new Error('audit case stalled')), 2000) }),
    ])
    passed++
    console.log(`PASS ${name}`)
  }
  catch (err) { failed++; console.error(`FAIL ${name}:`, err) }
  finally { if (timeout) realClearTimeout(timeout); clock.restore() }
}
const canonicalCards = () => characters.rows.map((c) => {
  const { _id, created_at, updated_at, ...fields } = c
  return fields
}).sort((a, b) => a.canonical_name.localeCompare(b.canonical_name))

if (realExtractorMode && !attributionMode) {
  await check('tolerant batch applies null/wrong optional fields and seven characters with single-turn parity', async () => {
    const initial = tolerantNames.map((name) => ({ ...copy(characters.rows[0]), _id: new ObjectId(), canonical_name: name, name_normalized: name.toLowerCase() }))
    const makeTurns = () => [1, 2].map((sequence) => event(sequence, { present_characters: tolerantNames,
      ai_response: `Someone waits on beat ${sequence}.`, player_input: 'Continue' }))
    const previousMax = process.env.CHARACTER_PROJECTION_BATCH_MAX
    try {
      process.env.CHARACTER_PROJECTION_BATCH_MAX = '1'
      characters.rows = copy(initial)
      const separateTurns = makeTurns()
      for (const row of separateTurns) await projectCharacterEvent(params(row))
      const expectedDeltas = separateTurns.map((e) => copy(e.data.codex_deltas))
      const expectedCards = canonicalCards()
      assert.ok(expectedDeltas.every((d) => d.length === 6), 'single-turn path caps at six characters')
      assert.equal(expectedDeltas[0][0].immutable_facts.length, 6)
      assert.equal(expectedDeltas[0][0].mutable_state.length, 6)
      assert.equal(expectedDeltas[0][0].role, undefined)
      process.env.CHARACTER_PROJECTION_BATCH_MAX = '4'
      characters.rows = copy(initial); events.rows = []; applied.length = modelCalls.length = 0
      const rows = makeTurns()
      await projectCharacterEvent(params(rows[0]))
      assert.deepEqual(modelCalls, ['extractor', 'adjudicator'], 'one batch; no per-turn fallback calls')
      assert.equal(logs.some((l) => l.name === 'projection.batch_fallback'), false)
      assert.ok(rows.every((e) => e.data.codex_projection_status === 'completed' && e.data.codex_projection_ms.batch_size === 2))
      assert.deepEqual(applied, [1, 2])
      assert.deepEqual(rows.map((e) => e.data.codex_deltas), expectedDeltas)
      assert.deepEqual(canonicalCards(), expectedCards)
    } finally {
      if (previousMax === undefined) delete process.env.CHARACTER_PROJECTION_BATCH_MAX
      else process.env.CHARACTER_PROJECTION_BATCH_MAX = previousMax
    }
  })
  process.exit(failed ? 1 : 0)
}
if (attributionMode) {
  const makeTurns = () => [1, 2].map((sequence) => event(sequence, { present_characters: tolerantNames,
    ai_response: `Someone waits on beat ${sequence}.`, player_input: 'Continue' }))
  for (const reply of ['envelope', 'conflict', 'all'] as const) {
    await check(`envelope attribution ${reply}: real extraction applies with single-turn parity`, async () => {
      const initial = tolerantNames.map((name) => ({ ...copy(characters.rows[0]), _id: new ObjectId(), canonical_name: name, name_normalized: name.toLowerCase() }))
      const previousMax = process.env.CHARACTER_PROJECTION_BATCH_MAX
      try {
        process.env.CHARACTER_PROJECTION_BATCH_MAX = '1'
        characters.rows = copy(initial)
        const separate = makeTurns()
        for (const row of separate) await projectCharacterEvent(params(row))
        const expectedDeltas = separate.map((e) => copy(e.data.codex_deltas))
        const expectedCards = canonicalCards()
        process.env.CHARACTER_PROJECTION_BATCH_MAX = '4'
        characters.rows = copy(initial); events.rows = []
        applied.length = modelCalls.length = logs.length = claimWrites.length = 0
        attributionReply = reply
        const rows = makeTurns()
        await projectCharacterEvent(params(rows[0]))
        assert.deepEqual(applied, [1, 2])
        assert.deepEqual(rows.map((e) => e.data.codex_deltas), expectedDeltas)
        assert.deepEqual(canonicalCards(), expectedCards)
        assert.deepEqual(claimWrites, [1, 2], 'fallback retains the original claims without reacquiring')
        assert.ok(rows.every((e) => e.data.codex_projection_status === 'completed' && !('codex_projection_claimed_at' in e.data)))
        if (reply === 'all') {
          assert.deepEqual(modelCalls, ['extractor', 'adjudicator', 'extractor', 'adjudicator', 'extractor', 'adjudicator'], 'invalid batch falls back once per turn')
          assert.equal(logs.filter((l) => l.name === 'projection.batch_fallback').length, 1)
          assert.deepEqual(logs.filter((l) => l.name === 'projection.batch_all_unattributable').map((l) => l.data),
            [{ sequence: 1, turn_count: 2, proposed_count: 16, dropped_count: 16 }])
        } else {
          assert.deepEqual(modelCalls, ['extractor', 'adjudicator'], 'one batch without per-turn fallback')
          assert.equal(logs.some((l) => l.name === 'projection.batch_fallback' || l.name === 'projection.batch_all_unattributable'), false)
          const count = reply === 'conflict' ? 2 : 0
          assert.ok(rows.every((e) => e.data.codex_projection_dropped_unattributable === count))
          assert.deepEqual(logs.filter((l) => l.name === 'projection.batch_unattributable').map((l) => l.data.count), count ? [count] : [])
        }
      } finally {
        if (previousMax === undefined) delete process.env.CHARACTER_PROJECTION_BATCH_MAX
        else process.env.CHARACTER_PROJECTION_BATCH_MAX = previousMax
      }
    })
  }
  await check('envelope attribution empty: no proposals need no alarm or fallback', async () => {
    attributionReply = 'empty'
    const rows = makeTurns()
    await projectCharacterEvent(params(rows[0]))
    assert.deepEqual(modelCalls, ['extractor', 'adjudicator'])
    assert.deepEqual(rows.map((e) => e.data.codex_deltas), [[], []])
    assert.ok(rows.every((e) => e.data.codex_projection_status === 'completed' && e.data.codex_projection_dropped_unattributable === 0))
    assert.equal(logs.some((l) => l.name === 'projection.batch_fallback' || l.name === 'projection.batch_all_unattributable'), false)
  })
  process.exit(failed ? 1 : 0)
}
await check('(a) live fence returns <50ms, logs claim age, starts no repair', async (clock) => {
  event(1, { codex_projection_status: 'processing', codex_projection_claimed_at: new Date(Date.now() - 1200) })
  let repairCalls = 0
  let done = false
  const started = performance.now()
  const pending = fenceOnPriorProjection(base, async () => { repairCalls++; return {} }).then(() => { done = true })
  await flush()
  assert.equal(done, true, 'fence must settle without clock advancement')
  assert.ok(performance.now() - started < 50)
  assert.equal(repairCalls, 0)
  assert.equal(logs.find((l) => l.name === 'projection.fence_inflight')?.data.claim_age_ms, 1200)
  assert.equal(anomalies.length, 0)
  await clock.advance(200)
  await pending
})
await check('(b,c) quick projections wait, re-read cards, apply 1 then 2, both complete', async (clock) => {
  const one = event(1)
  const two = event(2)
  extract = async (p) => {
    if (p.sequence === 1) await new Promise((resolve) => setTimeout(resolve, 800))
    return [{ name: 'Someone', mutable_state: [`turn-${p.sequence}`] }]
  }
  const p1 = projectCharacterEvent(params(one))
  const p2 = projectCharacterEvent(params(two))
  await clock.advance(500)
  assert.deepEqual(observed.map((p) => p.sequence), [1], 'second extractor must not run yet')
  await clock.advance(600)
  await Promise.all([p1, p2])
  assert.deepEqual(observed[1].facts, ['before', 'turn-1'], 'fresh Mongo state required')
  assert.deepEqual(applied, [1, 2])
  assert.deepEqual(events.rows.map((r) => r.data.codex_projection_status), ['completed', 'completed'])
  assert.deepEqual(characters.rows[0].mutable_state, ['before', 'turn-1', 'turn-2'])
  assert.ok(events.rows.every((r) => !('codex_projection_claimed_at' in r.data)))
})
await check('(b,c) newest projection repairs pending gaps in ascending order', async (clock) => {
  const one = event(1)
  const two = event(2)
  one.created_at = two.created_at = new Date(Date.now() - GRACE - 1)
  const three = event(3)
  extract = async (p) => { await delay(100); return [{ name: 'Someone', mutable_state: [`turn-${p.sequence}`] }] }
  const pending = projectCharacterEvent(params(three))
  await clock.advance(1000)
  await pending
  assert.deepEqual(applied, [1, 2, 3])
  assert.deepEqual(observed.map((p) => p.facts), [
    ['before'], ['before', 'turn-1'], ['before', 'turn-1', 'turn-2'],
  ])
  assert.ok(events.rows.every((row) => row.data.codex_projection_status === 'completed'))
})
await check('repair narrator fence leaves fresh waiter alone and retries attempted prior', async () => {
  const one = event(1)
  let repairs = 0
  await fenceOnPriorProjection(base, async () => { repairs++; return {} })
  assert.equal(repairs, 0)
  assert.equal(anomalies.length, 0)
  one.data.codex_projection_attempts = 1
  await fenceOnPriorProjection(base, async () => { repairs++; return {} })
  assert.equal(repairs, 1)
  assert.equal(anomalies.length, 1)
})
await check('repair fresh waiter is left alone until orphan grace expires; launches once', async (clock) => {
  assert.equal(GRACE, 15_000)
  const one = event(1), two = event(2)
  let repairs = 0, worked = false
  const pending = withCharacterProjection(params(two), async () => { repairs++; return {} }, async () => { worked = true })
  await clock.advance(GRACE)
  assert.equal(repairs, 0, 'fresh waiting worker must not acquire extra polling repairs')
  assert.equal(worked, false)
  await clock.advance(240)
  assert.equal(repairs, 1, 'old orphan is repaired once')
  await clock.advance(1200)
  assert.equal(repairs, 1)
  one.data.codex_projection_status = 'completed'
  await clock.advance(120)
  await pending
  assert.equal(worked, true)
})
await check('repair fresh attempted prior recovers immediately without waiting for grace', async (clock) => {
  event(1, { codex_projection_attempts: 1 })
  const two = event(2)
  const pending = projectCharacterEvent(params(two))
  await clock.advance(240)
  await pending
  assert.deepEqual(applied, [1, 2])
  assert.ok(events.rows.every((e) => e.data.codex_projection_status === 'completed'))
})
const telemetryContext = () => ({ anomalies: { stubNames: [], witnessLocationName: 'Audit room' },
  signals: { movement: { detected: false, committed: false }, time: { detected: false, committed: false },
    party: { detected: 0, committedConfidences: [] }, presence: { detected: 0, committed: 0 }, playerCorrected: false } })
await check('telemetry graph failure still records anomalies and signal ledger', async () => {
  graphFailure = true
  const row = event(1, { player_input: '*Someone is my sister.*', codex_projection_context: telemetryContext() })
  await projectCharacterEvent(params(row))
  assert.equal(row.data.codex_projection_status, 'completed')
  assert.ok(anomalies.some((a) => a.type === 'location_phrase_no_anchor'))
  assert.equal(signalRows.length, 1)
  assert.deepEqual(signalRows[0].signals.kinship, { detected: 1, committed: 0 })
  assert.ok(signalRows[0].miss_candidates > 0)
})
for (const failure of ['anomaly', 'signal']) await check(`telemetry ${failure} failure has own catch and completes projection`, async () => {
  anomalyFailure = failure === 'anomaly'; signalFailure = failure === 'signal'
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    const row = event(1, { codex_projection_context: telemetryContext() })
    await projectCharacterEvent(params(row))
    assert.equal(row.data.codex_projection_status, 'completed')
    assert.deepEqual(applied, [1])
    assert.ok(warnings.some((w) => w.includes(`scripted ${failure} write failure`)))
    assert.ok(warnings.every((w) => w.startsWith('projection anomaly/signal logging failed:')))
  } finally { console.warn = warn }
})
await check('(d) pending fence repair outlives old 4s budget; inline contention cannot orphan it', async (clock) => {
  const one = event(1)
  one.created_at = new Date(Date.now() - GRACE - 1)
  extract = async () => { await new Promise((resolve) => setTimeout(resolve, 9000)); return [{ name: 'Someone', mutable_state: ['repaired'] }] }
  let finished = false
  await fenceOnPriorProjection(base, async (p) => { const result = await projectCharacterEvent(p); finished = true; return result })
  await flush()
  const contender = await withCharacterProjection(params(one), projectCharacterEvent, async () => { throw new Error('losing inline owner ran') })
  assert.deepEqual(contender, { skipped: 'claimed_by_active_worker' })
  await clock.advance(4100)
  assert.equal(finished, false)
  assert.equal(one.data.codex_projection_status, 'processing')
  await clock.advance(5000)
  assert.equal(finished, true)
  assert.equal(one.data.codex_projection_status, 'completed', 'must finish before 90s recovery')
  assert.deepEqual(applied, [1])
})
await check('(d) ledgered projection closes status without applying its deltas twice', async (clock) => {
  const one = event(1, { codex_deltas: [], codex_projection_status: 'pending' })
  const pending = projectCharacterEvent(params(one))
  await clock.advance(20)
  await pending
  assert.equal(one.data.codex_projection_status, 'completed')
  assert.deepEqual(observed, [])
  assert.deepEqual(applied, [])
})
await check('(e) real failures release claim, record anomaly, retry then stop at four attempts', async () => {
  const one = event(1)
  extract = async () => { throw new Error('scripted extraction failure') }
  for (let n = 1; n <= 4; n++) {
    await assert.rejects(projectCharacterEvent(params(one)), /scripted extraction failure/)
    assert.equal(one.data.codex_projection_status, n === 4 ? 'failed' : 'pending')
    assert.equal(one.data.codex_projection_attempts, n)
    assert.equal('codex_projection_claimed_at' in one.data, false)
    assert.equal(anomalies.filter((a) => a.type === 'projection_failed').length, n)
  }
  assert.deepEqual(await projectCharacterEvent(params(one)), { skipped: 'failed' })
})
await check('(f) stuck prior bounds wait at 60s, records degradation; late old result cannot roll cards back', async (clock) => {
  assert.equal(BOUND, 60_000)
  const one = event(1)
  const two = event(2)
  let release!: () => void
  const stuck = new Promise<void>((resolve) => { release = resolve })
  extract = async (p) => { if (p.sequence === 1) await stuck; return [{ name: 'Someone', mutable_state: [`turn-${p.sequence}`] }] }
  const p1 = projectCharacterEvent(params(one)).catch((e: Error) => e)
  let done = false
  const p2 = projectCharacterEvent(params(two)).then(() => { done = true })
  await clock.advance(BOUND - 1)
  assert.equal(done, false)
  await clock.advance(1)
  assert.equal(done, true, '60s deadline must release the tail')
  await p2
  assert.ok(anomalies.some((a) => a.type === 'stale_scene_state' && a.details.includes('timed out')))
  release()
  await flush()
  assert.match(String(await p1), /overtaken/)
  assert.ok(anomalies.some((a) => a.details.includes('sequence 1 overtaken by sequence 2')), 'overtaken anomaly names BOTH sequences')
  assert.deepEqual(applied, [2], 'late predecessor must not apply after its successor')
})
await check('lease renews past two minutes, prevents stealing, and stale claims repair', async (clock) => {
  const one = event(1)
  extract = async () => { await new Promise((resolve) => setTimeout(resolve, LEASE + 1000)); return [] }
  const pending = projectCharacterEvent(params(one))
  await clock.advance(LEASE)
  assert.ok(Date.now() - one.data.codex_projection_claimed_at.getTime() < LEASE)
  assert.deepEqual(await projectCharacterEvent(params(one)), { skipped: 'claimed_by_active_worker' })
  await clock.advance(1000)
  await pending
  const two = event(2, { codex_projection_status: 'processing', codex_projection_claimed_at: new Date(Date.now() - LEASE - 1) })
  extract = async () => []
  await projectCharacterEvent(params(two))
  assert.equal(two.data.codex_projection_status, 'completed')
})
await check('recovery delivery retries active claims rather than swallowing the safety net', async () => {
  const one = event(1, { codex_projection_status: 'processing', codex_projection_claimed_at: new Date(Date.now()) })
  await assert.rejects(characterProjectionProcessor({ data: params(one) } as never), /retry after lease expiry/)
  assert.equal(anomalies.length, 0, 'contention is not a projection failure')
})
await check('(d) retry after ledger/publish failure finishes lifecycle and never re-applies', async () => {
  const one = event(1, { character_lifecycle_deltas: [{ name: 'Someone', state: 'dead' }] })
  publishFailure = true
  await assert.rejects(projectCharacterEvent(params(one)), /scripted publish failure/)
  assert.equal(one.data.codex_projection_status, 'pending')
  assert.ok(one.data.codex_deltas)
  publishFailure = false
  await projectCharacterEvent(params(one))
  assert.equal(one.data.codex_projection_status, 'completed')
  assert.deepEqual(applied, [1])
  assert.equal(observed.length, 1)
  assert.equal(lifecycleCalls, 2, 'ledgered retry must finish derived work')
})
await check('(g) completed projection atomically carries integer sequential step times and total', async (clock) => {
  const one = event(1, { player_input: 'timing', character_lifecycle_deltas: [{ name: 'Someone', state: 'dead' }] })
  extract = async () => { await delay(70); return [{ name: 'Someone', mutable_state: ['timed'] }] }
  const pending = projectCharacterEvent(params(one))
  await clock.advance(69)
  assert.equal(one.data.codex_projection_ms, undefined, 'no premature timing write')
  await clock.advance(21)
  await pending
  assert.equal(one.data.codex_projection_status, 'completed')
  const ms = one.data.codex_projection_ms
  assert.ok(ms && !Array.isArray(ms))
  assert.equal(ms.extractor_call, 70)
  assert.equal(ms.bond_adjudication, 20)
  for (const key of ['instance_exists_read', 'event_read', 'claim', 'ordering_wait', 'session_read', 'cards_read', 'ownership_check', 'apply_deltas', 'deltas_ledger_write', 'entity_graph_sync', 'lifecycle_reprojection', 'codex_publish', 'claim_flush']) {
    assert.ok(key in ms, `missing executed step ${key}`)
  }
  assert.equal('relationship_sync' in ms, false, 'omit unexecuted steps')
  assert.ok(Object.values(ms).every((v) => Number.isInteger(v) && Number(v) >= 0))
  const sum = Object.entries(ms).reduce((total, [key, value]) => total + (key === 'total' ? 0 : Number(value)), 0)
  assert.ok(ms.total >= sum, `total ${ms.total} must cover sequential spans ${sum}`)
  assert.equal(ms.total, 90)
})
await check('inline uses shared projection tail, fresh inputs, awaited compaction, and finally starts after persistence', async () => {
  const generation = readFileSync(new URL('../worker/processors/generation.processor.ts', import.meta.url), 'utf8')
  const source = readFileSync(new URL('../worker/processors/character-projection.processor.ts', import.meta.url), 'utf8')
  assert.ok(generation.includes('void projectCharacterEvent({ instanceId, playerId, eventId: eventIdStr })'), 'shared inline wiring')
  assert.ok(source.includes('withCharacterProjection('), 'shared barrier wiring')
  assert.ok(source.includes('const characterCodex = await readCards()'), 'fresh cards')
  assert.ok(source.includes("timing.step('known_locations_read', () => entityGraphService.listKnownLocations(instanceId, 30))"), 'fresh locations')
  assert.ok(source.includes('compactImmutableFacts(c.canonical_name, c.immutable_facts, 16))'))
  assert.ok(source.includes('await assertOwned()\n    const codex ='), 'ownership before application')
  assert.ok(generation.includes('} finally {\n    // The event is durable and metadata is ready.'))
  assert.equal((generation.match(/^    startCharacterProjection\(\)/gm) || []).length, 1)
  assert.ok(generation.includes('const fenceMs = Date.now() - fenceStartedAt'))
})
const ready = (sequence: number, data: Doc = {}) => event(sequence, { present_characters: ['Someone'], ...data })
await check('batch (a) five turns at 6s / 14s: two calls overlap burst, one owner, ordered completion', async (clock) => {
  let calls = 0, concurrent = 0, peak = 0
  const starts: number[] = []
  extract = async (p) => {
    calls++; concurrent++; peak = Math.max(peak, concurrent); starts.push(Date.now())
    await delay(14_000)
    concurrent--
    return scriptedDelta(p.sequence)
  }
  const beginning = Date.now()
  const pending: Promise<unknown>[] = []
  for (let sequence = 1; sequence <= 5; sequence++) {
    if (sequence > 1) await clock.advance(6000)
    pending.push(projectCharacterEvent(params(ready(sequence))))
    await flush()
  }
  assert.equal(starts.filter((at) => at <= beginning + 24_000).length, 2)
  await clock.advance(30_000)
  await Promise.all(pending)
  assert.equal(calls, 3)
  assert.equal(peak, 1)
  assert.deepEqual(batchCalls, [[2, 3], [4, 5]])
  assert.deepEqual(applied, [1, 2, 3, 4, 5])
  assert.ok(events.rows.every((e) => e.data.codex_projection_status === 'completed'))
  assert.equal('batch_size' in events.rows[0].data.codex_projection_ms, false)
  for (const e of events.rows.slice(1)) {
    assert.equal(e.data.codex_projection_ms.batch_size, 2)
    assert.equal(e.data.codex_projection_ms.batch_leader_sequence, e.sequence < 4 ? 2 : 4)
    assert.deepEqual(e.data.codex_deltas, scriptedDelta(e.sequence))
  }
})
await check('batch (b,g) real applyDeltas and rewind rebuild match separate turns field by field', async () => {
  const initial = copy(characters.rows)
  const prefixes = new Map<number, Doc[]>()
  const proposal = (sequence: number): Doc[] => [{ name: 'Someone', mutable_state: [`turn-${sequence}`],
    retire_state: sequence > 1 ? [`turn-${sequence - 1}`] : [],
    immutable_facts: [`history-${sequence}`], relationship_deltas: { trust: sequence, fear: -1 },
    relationship_evidence: { trust: `Someone accepted your promise on turn ${sequence}.`, fear: `Someone relaxed after your reassurance on turn ${sequence}.` },
  }, ...(sequence === 3 ? [{ name: 'Another Person', role: 'companion', mutable_state: ['waiting'] }] : [])]
  // The scripted batch returns equivalent, tagged proposals. The production
  // extractor and its attribution validator get their own isolated checks below.
  extract = async (p) => proposal(p.sequence)
  for (let sequence = 1; sequence <= 5; sequence++) {
    await projectCharacterEvent(params(ready(sequence)))
    prefixes.set(sequence, copy(canonicalCards()))
  }
  const separate = canonicalCards()
  const separateLedger = copy(events.rows)
  characters.rows = copy(initial); events.rows = []; applied.length = 0
  // The generic batch fake is configured by a separate proposal callback.
  batchProposal = proposal
  for (let sequence = 1; sequence <= 5; sequence++) ready(sequence)
  await projectCharacterEvent(params(events.rows[0]))
  await projectCharacterEvent(params(events.rows[4]))
  assert.deepEqual(canonicalCards(), separate)
  assert.deepEqual(applied, [1, 2, 3, 4, 5])
  assert.equal(events.rows[0].data.codex_projection_ms.batch_size, 4)
  const batchedLedger = copy(events.rows)
  for (const end of [1, 2, 3, 4]) {
    const rebuild = async (ledger: Doc[]) => {
      characters.rows = copy(initial)
      await realCodex.characterCodexService.rebuildCodexFromLedger({ ...base,
        batches: ledger.filter((e) => e.sequence <= end).map((e) => ({ sequence: e.sequence, deltas: e.data.codex_deltas })),
      })
      return canonicalCards()
    }
    assert.deepEqual(await rebuild(batchedLedger), prefixes.get(end), `rewind inside batch to ${end} matches LIVE prefix`)
    assert.deepEqual(await rebuild(separateLedger), prefixes.get(end), `unbatched rewind ${end} matches LIVE prefix`)
  }
})
await check('batch (c) missing present cast stops batch at the not-ready turn', async () => {
  const one = ready(1); const two = event(2); ready(3)
  await projectCharacterEvent(params(one))
  assert.deepEqual(batchCalls, [])
  assert.equal(two.data.codex_projection_status, 'pending')
  await projectCharacterEvent(params(two))
  assert.equal(two.data.codex_projection_status, 'completed')
})
await check('batch (d) invalid batch falls back inside same claims with fresh per-turn cards', async () => {
  batchFailure = true
  const rows = [ready(1), ready(2), ready(3)]
  await projectCharacterEvent(params(rows[0]))
  assert.deepEqual(batchCalls, [[1, 2, 3]])
  assert.deepEqual(applied, [1, 2, 3])
  assert.deepEqual(observed.map((o) => o.facts), [['before'], ['before', 'turn-1'], ['before', 'turn-1', 'turn-2']])
  assert.ok(rows.every((r) => r.data.codex_projection_status === 'completed'))
  assert.ok(logs.some((l) => l.name === 'projection.batch_fallback'))
})
await check('batch (e) unattributable count persisted and observable', async () => {
  dropped = 2
  const rows = [ready(1), ready(2)]
  await projectCharacterEvent(params(rows[0]))
  assert.ok(rows.every((r) => r.data.codex_projection_dropped_unattributable === 2))
  assert.equal(logs.find((l) => l.name === 'projection.batch_unattributable')?.data.count, 2)
})
await check('batch kinship retains each event sequence, player text and narration', async () => {
  const rows = [ready(1, { player_input: '*Someone is my sister.*', ai_response: 'Someone waits beside you.' }),
    ready(2, { player_input: '*Someone is my mother.*', ai_response: 'Someone speaks softly.' })]
  await projectCharacterEvent(params(rows[0]))
  assert.deepEqual(kinshipCalls.map((p) => [p.sequence, p.eventId, p.sceneText]), rows.map((e) => [e.sequence, e._id, e.data.ai_response]))
  assert.deepEqual(kinshipCalls.map((p) => p.assertions[0]?.kind), ['sibling_of', 'parent_of'])
})
await check('batch all member leases heartbeat and live contenders exit without duplicate work', async (clock) => {
  const rows = [ready(1), ready(2), ready(3)]
  extract = async (p) => { await delay(LEASE + 1000); return scriptedDelta(p.sequence) }
  const pending = projectCharacterEvent(params(rows[0]))
  await clock.advance(LEASE)
  for (const row of rows) {
    assert.ok(Date.now() - row.data.codex_projection_claimed_at.getTime() < LEASE)
    assert.deepEqual(await projectCharacterEvent(params(row)), { skipped: 'claimed_by_active_worker' })
  }
  await clock.advance(1000)
  await pending
  assert.deepEqual(applied, [1, 2, 3])
  assert.deepEqual(batchCalls, [[1, 2, 3]])
})
await check('batch tolerance real extractor and processor apply without fallback', async () => {
  const result = spawnSync('bun', ['--no-env-file', 'run', 'scripts/projection-fence-audit.ts', '--tolerant-batch-only'],
    { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  console.log(result.stdout.trim())
})
await check('batch envelope attribution real extractor and same-claim fallback', async () => {
  const result = spawnSync('bun', ['--no-env-file', 'run', 'scripts/projection-fence-audit.ts', '--attribution-batch-only'],
    { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  console.log(result.stdout.trim())
})
await check('batch real extractor validates tags, turn evidence, shared adjudication and fold parity', async () => {
  const result = spawnSync('bun', ['--no-env-file', 'run', 'scripts/projection-fence-audit.ts', '--extractor-only'],
    { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  console.log(result.stdout.trim())
})
console.log(`projection fence audit: ${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0

if ((process.argv.includes('--bites') || process.argv.includes('--extractor-bites')) && !failed) {
  const leasePath = new URL('../worker/lib/character-projection-lease.ts', import.meta.url)
  const recoveryPath = new URL('../worker/processors/character-projection.processor.ts', import.meta.url)
  const generationPath = new URL('../worker/processors/generation.processor.ts', import.meta.url)
  const extractorPath = new URL('../worker/lib/character-codex-extractor.ts', import.meta.url)
  const codexPath = new URL('../src/services/character-codex.service.ts', import.meta.url)
  const mutations = [
    { name: 'envelope missing sequence not inherited', path: extractorPath, before: 'characters.push({ ...character, sequence })', after: 'characters.push({ ...character, sequence: character.sequence === undefined ? undefined : sequence })', expected: 'FAIL envelope attribution envelope' },
    { name: 'envelope null sequence not inherited', path: extractorPath, before: 'characters.push({ ...character, sequence })', after: 'characters.push({ ...character, sequence: character.sequence === null ? null : sequence })', expected: 'FAIL envelope attribution envelope' },
    { name: 'envelope conflicting sequence accepted', path: extractorPath, before: 'character.sequence != null && character.sequence !== sequence', after: 'false', expected: 'FAIL envelope attribution conflict' },
    { name: 'envelope total loss skips fallback', path: extractorPath, before: 'proposedCount > 0 && droppedUnattributable === proposedCount', after: 'false', expected: 'FAIL envelope attribution all' },
    { name: 'envelope total loss alarm silenced', path: extractorPath, before: "log.warn('projection.batch_all_unattributable'", after: "log.warn('projection.batch_all_unattributable_disabled'", expected: 'FAIL envelope attribution all' },
    { name: 'tolerance reject null optional field', path: extractorPath, before: "return typeof item.name === 'string' && !!item.name.trim()", after: "return item.role !== null && typeof item.name === 'string' && !!item.name.trim()", expected: 'FAIL batch tolerance' },
    { name: 'tolerance reject wrong optional type', path: extractorPath, before: "return typeof item.name === 'string' && !!item.name.trim()", after: "return (item.persona == null || typeof item.persona === 'string') && typeof item.name === 'string' && !!item.name.trim()", expected: 'FAIL batch tolerance' },
    { name: 'tolerance reject seventh character', path: extractorPath, before: 'rows.has(sequence) || !Array.isArray(row.characters)', after: 'rows.has(sequence) || !Array.isArray(row.characters) || row.characters.length > 6', expected: 'FAIL batch tolerance' },
    { name: 'tolerance reject null turn relation assertions', path: extractorPath, before: 'rows.has(sequence) || !Array.isArray(row.characters)', after: 'rows.has(sequence) || !Array.isArray(row.characters) || row.relation_assertions === null', expected: 'FAIL batch tolerance' },
    { name: 'validation drop non-object instead of fallback', path: extractorPath, before: "if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid codex batch character')", after: "if (!item || typeof item !== 'object' || Array.isArray(item)) { droppedUnattributable++; continue }", expected: 'FAIL batch real extractor' },
    { name: 'repair fresh waiting workers', path: leasePath, before: 'isPlausiblyOrphaned(prior) && !launched.has(priorId)', after: '!hasLiveProjectionClaim(prior) && !launched.has(priorId)', expected: 'FAIL repair fresh waiter' },
    { name: 'repair narrator fence repairs fresh waiter', path: leasePath, before: "    if (prior.data.codex_projection_status !== 'failed' && !isPlausiblyOrphaned(prior)) return\n", after: '', expected: 'FAIL repair narrator fence' },
    { name: 'repair ignore attempted fresh prior', path: leasePath, before: '(event.data.codex_projection_attempts || 0) > 0', after: 'false', expected: 'FAIL repair fresh attempted prior' },
    { name: 'repair disable old orphan recovery', path: leasePath, before: 'isPlausiblyOrphaned(prior) && !launched.has(priorId)', after: 'false && !launched.has(priorId)', expected: 'FAIL (b,c) newest projection repairs' },
    { name: 'repair relaunch same orphan every poll', path: leasePath, before: 'isPlausiblyOrphaned(prior) && !launched.has(priorId)', after: 'isPlausiblyOrphaned(prior)', expected: 'FAIL repair fresh waiter' },
    { name: 'telemetry put logging back inside graph try', path: recoveryPath, before: "    } catch (err) {\n      console.warn('entity graph sync failed:', (err as Error).message)\n    }\n\n    try {\n      const context", after: '      const context', expected: 'FAIL telemetry graph failure' },
    { name: 'telemetry mislabel logging failure as graph sync', path: recoveryPath, before: "console.warn('projection anomaly/signal logging failed:', (err as Error).message)", after: "console.warn('entity graph sync failed:', (err as Error).message)", expected: 'FAIL telemetry anomaly failure' },
    { name: 'telemetry throw logging failures into projection', path: recoveryPath, before: "console.warn('projection anomaly/signal logging failed:', (err as Error).message)", after: 'throw err', expected: 'FAIL telemetry signal failure' },
    { name: 'batch validation ignore invalid adjudication', path: extractorPath, before: "throw new Error('Invalid codex batch adjudication')", after: 'return { rejected: new Map(), supplements: [] }', expected: 'FAIL batch real extractor' },
    { name: 'batch heartbeat only leader', path: leasePath, before: 'for (const claim of claims) {\n        const next', after: 'for (const claim of claims.slice(0, 1)) {\n        const next', expected: 'FAIL batch all member leases' },
    { name: 'batch (a) disable coalescing', path: leasePath, before: 'if (prepareBatch && characterProjectionBatchMax()', after: 'if (false && prepareBatch && characterProjectionBatchMax()', expected: 'FAIL batch (a)' },
    { name: 'batch (b) apply with leader sequence', path: recoveryPath, before: 'sequence: nextSequence,\n          deltas,', after: 'sequence: 1,\n          deltas,', expected: 'FAIL batch (b,g)' },
    { name: 'batch (c) take not-ready cast', path: leasePath, before: '!Array.isArray(row.data.present_characters)', after: 'false', expected: 'FAIL batch (c)' },
    { name: 'batch (d) abandon per-turn fallback', path: recoveryPath, before: 'return undefined // Each work callback', after: 'throw err // Each work callback', expected: 'FAIL batch (d)' },
    { name: 'batch (e) lose dropped counter', path: recoveryPath, before: "'data.codex_projection_dropped_unattributable': batch.droppedUnattributable", after: "'data.codex_projection_dropped_unattributable': 0", expected: 'FAIL batch (e)' },
    { name: 'batch (e) accept conflicting delta', path: extractorPath, before: 'character.sequence != null && character.sequence !== sequence', after: 'false', expected: 'FAIL batch real extractor' },
    { name: 'batch (f) lose overtaken anomaly', path: leasePath, before: 'details: `late projection sequence ${claim.event.sequence} overtaken by sequence ${overtaken.sequence}; deltas rejected`', after: 'details: `late projection rejected`', expected: 'FAIL (f)' },
    { name: 'batch (g) reverse rewind ledger', path: codexPath, before: 'await foldAndPersist(iid, pid, existing, batches)', after: 'await foldAndPersist(iid, pid, existing, [...batches].reverse())', expected: 'FAIL batch (b,g)' },
    { name: 'batch kinship wrong turn', path: recoveryPath, before: 'sequence: nextSequence,\n          eventId: event._id,\n          assertions:', after: 'sequence: 1,\n          eventId: event._id,\n          assertions:', expected: 'FAIL batch kinship' },
    { name: 'batch evidence borrow other turn', path: extractorPath, before: 'toDelta(item, sourceText, turnText)', after: 'toDelta(item, sourceText, sourceText)', expected: 'FAIL batch real extractor' },
    { name: '(a) restore player-facing polling', path: leasePath, before: "log.info('projection.fence_inflight', {", after: "await sleep(120)\n      log.info('projection.fence_inflight', {", expected: 'FAIL (a)' },
    { name: '(b) extract against stale packet cards', path: recoveryPath, before: 'const characterCodex = await readCards()', after: 'const stalePacketCards = await readCards()', expected: 'FAIL inline' },
    { name: '(c) remove sequence barrier', path: leasePath, before: 'if (!prior) break', after: 'if (true) break', expected: 'FAIL (b,c)' },
    { name: '(d) omit background repair', path: leasePath, before: 'void repair(params).then((result) => {', after: 'void Promise.resolve({ skipped: true }).then((result) => {', expected: 'FAIL (d)' },
    { name: '(d) drop finally launch', path: generationPath, before: '    startCharacterProjection()\n', after: '', expected: 'FAIL inline' },
    { name: '(e) swallow failed extraction', path: leasePath, before: 'throw err\n  } finally', after: 'return { skipped: \'broken\' }\n  } finally', expected: 'FAIL (e)' },
    { name: '(f) double 60s bound', path: leasePath, before: 'CHARACTER_PROJECTION_ORDER_BUDGET_MS = 60_000', after: 'CHARACTER_PROJECTION_ORDER_BUDGET_MS = 120_000', expected: 'FAIL (f)' },
    { name: '(g) corrupt total', path: leasePath, before: 'total: Math.max(0, Date.now() - this.startedAt)', after: 'total: 0', expected: 'FAIL (g)' },
    { name: '(g) omit bond timing boundary', path: recoveryPath, before: '      onRaw, ...inputs!', after: '      onRaw: undefined, ...inputs!', expected: 'FAIL (g)' },
    { name: 'lose heartbeat', path: leasePath, before: '}, CHARACTER_PROJECTION_CLAIM_LEASE_MS / 4)', after: '}, CHARACTER_PROJECTION_CLAIM_LEASE_MS * 4)', expected: 'FAIL lease' },
    { name: 'drop zero-delta completion', path: recoveryPath, before: 'const deltas = event.data.codex_deltas ?? prepared ?? await timing.extract', after: 'const deltas = prepared ?? await timing.extract', expected: 'FAIL (d) ledgered' },
  ]
  // Dispatched briefs can exercise extractor bites without touching other owners' files.
  const selected = process.argv.includes('--extractor-bites') ? mutations.filter((m) => m.path === extractorPath) : mutations
  for (const m of selected) {
    const original = readFileSync(m.path, 'utf8')
    try {
      assert.equal(original.split(m.before).length, 2, `unique mutation target: ${m.name}`)
      writeFileSync(m.path, original.replace(m.before, m.after))
      const child = spawnSync('bun', ['--no-env-file', 'run', 'scripts/projection-fence-audit.ts'], { encoding: 'utf8', timeout: 15000 })
      assert.ok(!child.error, `child executed: ${m.name}: ${child.error}`)
      assert.notEqual(child.status, 0, `mutation must bite: ${m.name}`)
      assert.ok((child.stdout + child.stderr).includes(m.expected), `intended check: ${m.name}\n${child.stdout}${child.stderr}`)
      console.log(`BITE ${m.name}: exit ${child.status}; ${m.expected}`)
    } finally { writeFileSync(m.path, original) }
    assert.equal(readFileSync(m.path, 'utf8'), original)
  }
  console.log(`${selected.length}/${selected.length} mutations rejected; production files restored byte for byte`)
}

/** Isolated process: exercises the real extractor/validator with scripted LLM
 * output, alongside the separate fake-extractor concurrency tests above. */
async function auditRealExtractor() {
  type Item = Record<string, unknown>
  let response: unknown
  let review: Item = { reject: [], supplements: [] }
  let calls = 0
  let failureModel = ''
  const requests: Item[] = []
  const forbidden = () => { throw new Error('external I/O in extractor audit') }
  globalThis.fetch = Object.assign(async () => forbidden(), { preconnect: forbidden })
  mock.module('../src/config/mongo', () => ({ mongoColl: new Proxy({}, { get: () => forbidden }) }))
  mock.module('../src/utils/logger', () => ({ log: { warn: () => {} } }))
  mock.module('../src/ai', () => ({ AI_MODELS: { metadata: 'adjudicator', codexExtraction: 'extractor' }, callLLM: async (p: Item) => {
    requests.push(p); calls++
    if (p.model === failureModel) throw new Error('scripted provider failure')
    return p.model === 'adjudicator' ? JSON.stringify(review) : typeof response === 'string' ? response : JSON.stringify(response)
  } }))
  const { extractCharacterCodexDeltas: single, extractCharacterCodexBatch: batch } = await import('../worker/lib/character-codex-extractor')
  const { newFoldState, foldDelta } = await import('../src/services/character-codex.service')
  const iid = new ObjectId(), pid = new ObjectId(), now = new Date(0)
  const initial = [{ _id: new ObjectId(), instance_id: iid, player_id: pid, canonical_name: 'Someone', name_normalized: 'someone', aliases: [],
    immutable_facts: [], mutable_state: ['before'], disposition_to_player: '', hidden_thought: '', first_seen_sequence: 0,
    last_seen_sequence: 0, mention_count: 1, created_at: now, updated_at: now }]
  const turns = [1, 2, 3, 4].map((sequence) => ({ sequence, playerInput: `Player text for turn ${sequence}.`,
    aiResponse: `Someone accepts your promise and squeezes your hand on beat ${sequence}. Rowan says, "I will wait outside."`,
    presentCast: sequence >= 3 ? ['Someone', 'Rowan'] : ['Someone'] }))
  const proposal = (sequence: number) => ({ sequence, name: 'Someone', mutable_state: [`state-${sequence}`],
    retire_state: sequence > 1 ? [`state-${sequence - 1}`] : [], immutable_facts: [`history-${sequence}`],
    relationship_deltas: { trust: sequence, affection: 1 }, relationship_evidence: {
      trust: turns[sequence - 1].aiResponse.split(' Rowan')[0], affection: turns[sequence - 1].aiResponse.split(' Rowan')[0],
    } })
  const responseFor = (sequence: number) => ({ characters: [proposal(sequence), ...(sequence === 3
    ? [{ sequence, name: 'Rowan', identity_kind: 'proper_name', role: 'companion', mutable_state: ['waiting'] }] : [])] })
  const baseParams = { existing: initial, seedPrompt: '', isSentient: false }
  const separate = newFoldState(structuredClone(initial))
  const ownLedgers = new Map<number, import('../src/services/character-codex.service').CharacterCodexDelta[]>()
  for (const turn of turns) {
    response = responseFor(turn.sequence)
    const deltas = await single({ ...baseParams, ...turn, existing: [...new Set(separate.byName.values())] })
    ownLedgers.set(turn.sequence, deltas)
    for (const delta of deltas) foldDelta(separate, delta, turn.sequence, { iid, pid, now, prose: turn.aiResponse })
  }
  calls = 0; requests.length = 0
  response = { turns: turns.map((t) => ({ sequence: t.sequence, ...responseFor(t.sequence) })) }
  const combined = await batch({ ...baseParams, turns })
  assert.equal(calls, 2, 'one extraction plus one adjudication for the entire batch')
  const supplied = JSON.parse((requests[0].messages as Array<{ content: string }>)[1].content).turns
  assert.deepEqual(supplied, turns, 'prompt keeps each input/cast/narration separate')
  const reviewedTurns = (requests[1].messages as Array<{ content: string }>)[1].content
  for (const t of turns) assert.ok(reviewedTurns.includes(JSON.stringify(t)), 'adjudicator has each source turn intact')
  const folded = newFoldState(structuredClone(initial))
  for (const t of turns) {
    assert.deepEqual(combined.deltas.get(t.sequence), ownLedgers.get(t.sequence), `attributed deltas ${t.sequence}`)
    for (const delta of combined.deltas.get(t.sequence)!) foldDelta(folded, delta, t.sequence, { iid, pid, now, prose: t.aiResponse })
  }
  const canonical = (state: ReturnType<typeof newFoldState>) => [...new Set(state.byName.values())].map((card) => {
    const { _id, ...fields } = card
    return fields
  }).sort((a, b) => a.canonical_name.localeCompare(b.canonical_name))
  assert.deepEqual(canonical(folded), canonical(separate), 'all real folded card fields and moments match')
  console.log('PASS extractor parity: deltas, cards, moments, new cards, per-turn prompt and single batch adjudication')

  response = { turns: turns.map((t) => ({ sequence: t.sequence, characters: [proposal(t.sequence)] })) }
  const bad = response as { turns: Array<{ sequence: number; characters: Item[] }> }
  bad.turns[0].characters.push({ name: 'Someone', mutable_state: ['INHERITED'] }, { sequence: null, name: 'Someone', mutable_state: ['INHERITED NULL'] },
    { sequence: 2, name: 'Someone', mutable_state: ['WRONG TAG'] }, { sequence: 99, name: 'Someone', mutable_state: ['WRONG TAG'] })
  bad.turns.push({ sequence: 99, characters: [{ name: 'Someone' }] })
  review = { reject: [], supplements: [{ name: 'Someone', relationship_deltas: { trust: 10 } },
    { sequence: null, name: 'Someone', relationship_deltas: { trust: 10 } }, { sequence: 99, name: 'Someone', relationship_deltas: { trust: 10 } }] }
  const untagged = await batch({ ...baseParams, turns })
  assert.equal(untagged.droppedUnattributable, 6)
  assert.ok(untagged.deltas.get(1)!.some((d) => d.mutable_state?.includes('INHERITED')))
  assert.ok(untagged.deltas.get(1)!.some((d) => d.mutable_state?.includes('INHERITED NULL')))
  assert.ok(!untagged.deltas.get(1)!.some((d) => d.relationship_deltas?.trust === 10))
  assert.ok(![...untagged.deltas.values()].flat().some((d) => d.mutable_state?.some((s) => s.includes('TAG'))))
  console.log('PASS extractor attribution: envelope tags inherited; conflicting/unknown tags and untagged/null/unknown supplements dropped and counted')

  // A quote in turn 1 (or in the seed) cannot support a turn 2 meter.
  review = { reject: [], supplements: [] }
  bad.turns[1].characters[0] = { ...proposal(2), relationship_evidence: { trust: turns[0].aiResponse.split(' Rowan')[0] } }
  const evidence = await batch({ ...baseParams, seedPrompt: turns[0].aiResponse, turns })
  assert.equal(evidence.deltas.get(2)![0].relationship_deltas, undefined)
  review = { reject: [{ index: 0, meters: ['trust'] }], supplements: [] }
  const rejected = await batch({ ...baseParams, turns })
  assert.equal(rejected.deltas.get(1)![0].relationship_deltas?.trust, undefined)
  assert.equal(rejected.deltas.get(1)![0].relationship_deltas?.affection, 1)
  console.log('PASS extractor evidence: other turns/seed cannot move meters; adjudication keeps supported meters')
  for (const malformed of ['not json', 'null', '42', '[]', { turns: [] }, { turns: [{ sequence: 1, characters: 'wrong' }] },
    { turns: turns.map((t) => ({ sequence: t.sequence, characters: [{ sequence: t.sequence }] })) },
    { turns: turns.map((t) => ({ sequence: t.sequence, characters: [null, proposal(t.sequence)] })) },
    { turns: turns.map((t) => ({ sequence: t.sequence, characters: ['wrong', proposal(t.sequence)] })) },
    { turns: turns.map((t) => ({ sequence: t.sequence, characters: [{ sequence: t.sequence, name: 42 }] })) },
    { turns: turns.map((t) => ({ sequence: t.sequence, characters: [{ sequence: t.sequence, name: '   ' }] })) },
    { turns: turns.map((t) => ({ sequence: t.sequence, characters: [[], proposal(t.sequence)] })) },
    { turns: [...turns, turns[0]].map((t) => ({ sequence: t.sequence, characters: [] })) }]) {
    response = malformed
    await assert.rejects(batch({ ...baseParams, turns }), /Invalid codex batch/)
  }
  console.log('PASS extractor validation: malformed, incomplete and invalid character output throws for fallback')
  response = { turns: turns.map((t) => ({ sequence: t.sequence, characters: [proposal(t.sequence)] })) }
  review = {}
  await assert.rejects(batch({ ...baseParams, turns }), /Invalid codex batch adjudication/)
  review = { reject: [], supplements: [] }
  for (const model of ['extractor', 'adjudicator']) {
    failureModel = model
    await assert.rejects(batch({ ...baseParams, turns }), /scripted provider failure/)
  }
  console.log('PASS extractor failures: provider failures and invalid adjudication throw for same-claim fallback')

}
