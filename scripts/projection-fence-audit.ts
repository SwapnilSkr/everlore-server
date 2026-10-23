/** In-memory Mongo + scripted extractors; never loads env, connects, or pays. */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

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
  async findOne(query: Doc) { return this.find(query).next() }
  async updateOne(query: Doc, update: Doc) {
    const row = this.rows.find((r) => matches(r, query))
    if (!row) return { matchedCount: 0, modifiedCount: 0 }
    if (update.$set?.['data.codex_projection_status'] === 'completed') {
      assert.ok(update.$set['data.codex_projection_ms'], 'completed status and timings must share one $set')
    }
    for (const [key, value] of Object.entries(update.$set || {})) set(row, key, value)
    for (const key of Object.keys(update.$unset || {})) set(row, key, undefined, true)
    return { matchedCount: 1, modifiedCount: 1 }
  }
}
const events = new Collection()
const characters = new Collection()
const anomalies: Doc[] = []
const logs: Array<{ name: string; data: Doc }> = []
const applied: number[] = []
const observed: Array<{ sequence: number; facts: string[] }> = []
let extract: (params: Doc) => Promise<Doc[]> = async () => []
const unavailable = () => { throw new Error('Network/dependency reached in pure projection audit') }
globalThis.fetch = Object.assign(async () => unavailable(), { preconnect: unavailable })
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
let publishFailure = false
let lifecycleCalls = 0
mock.module('../src/config/mongo', () => ({ mongoColl: { events: () => events, characters: () => characters } }))
mock.module('../src/utils/live-instance', () => ({ liveInstanceExists: async () => true }))
mock.module('../src/utils/logger', () => ({ log: {
  info: (name: string, data: Doc) => logs.push({ name, data }),
  warn: (name: string, data: Doc) => logs.push({ name, data }),
} }))
mock.module('../src/utils/record-anomaly', () => ({ recordAnomaly: async (row: Doc) => { anomalies.push(row) } }))
mock.module('../src/config/redis', () => ({ getRedisClient: () => ({ publish: async () => { if (publishFailure) throw new Error('scripted publish failure') } }) }))
mock.module('../src/services/instance.service', () => ({ instanceService: { loadSession: async () => ({ is_sentient: false, seed_prompt: 'audit' }) } }))
mock.module('../src/services/entity-graph.service', () => ({ entityGraphService: {
  syncCodexEntities: async () => new Map(), syncRelationshipEdges: async () => {},
} }))
mock.module('../worker/lib/character-codex-extractor', () => ({ extractCharacterCodexDeltas: async (params: Doc) => {
  observed.push({ sequence: params.sequence, facts: [...(params.existing[0]?.mutable_state || [])] })
  const deltas = await extract(params)
  params.onRaw?.('{}')
  if (params.playerInput === 'timing') await delay(20)
  return deltas
} }))
mock.module('../src/services/character-codex.service', () => ({ characterCodexService: {
  applyDeltas: async ({ sequence, deltas }: Doc) => {
    applied.push(sequence)
    characters.rows[0].mutable_state.push(...deltas.flatMap((d: Doc) => d.mutable_state || []))
    return copy(characters.rows)
  },
  applyLifecycleDeltas: async () => { lifecycleCalls++ },
} }))
// Import only after every transitive runtime dependency has been replaced.
const { projectCharacterEvent, characterProjectionProcessor } = await import('../worker/processors/character-projection.processor')
const { fenceOnPriorProjection, withCharacterProjection, CHARACTER_PROJECTION_CLAIM_LEASE_MS: LEASE, CHARACTER_PROJECTION_ORDER_BUDGET_MS: BOUND } = await import('../worker/lib/character-projection-lease')

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
function event(sequence: number, data: Doc = {}) {
  const row = { _id: new ObjectId(), instance_id: iid, player_id: pid, sequence, type: 'narration', data: {
    model_used: 'audit', player_input: 'Continue', ai_response: 'An action.', codex_projection_status: 'pending', ...data,
  } }
  events.rows.push(row)
  return row
}
function fixture() {
  publishFailure = false
  lifecycleCalls = 0
  events.rows = []
  characters.rows = [{ _id: new ObjectId(), instance_id: iid, canonical_name: 'Someone', aliases: [], mutable_state: ['before'] }]
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
  event(1)
  event(2)
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
await check('(d) pending fence repair outlives old 4s budget; inline contention cannot orphan it', async (clock) => {
  const one = event(1)
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
await check('inline uses the shared barrier, fresh inputs, awaited compaction, and finally starts after persistence', async () => {
  const source = readFileSync(new URL('../worker/processors/generation.processor.ts', import.meta.url), 'utf8')
  const start = source.indexOf('function startCharacterProjection()')
  const inline = source.slice(start, source.indexOf('\n  if (shouldSummarize)', start))
  assert.ok(inline.includes('withCharacterProjection('), 'inline barrier wiring')
  assert.ok(inline.includes(`const characterCodex = await timing.step('cards_read', () => mongoColl.characters().find({ instance_id: instanceOid }).toArray())`), 'inline fresh cards')
  assert.ok(inline.includes(`const knownPlaces = await timing.step('known_locations_read', () => entityGraphService.listKnownLocations(instanceId, 30))`), 'inline fresh locations')
  assert.ok(inline.includes('const knownCardNames = new Set(characterCodex.flatMap'), 'inline fresh anomaly baseline')
  assert.ok(inline.includes('compactImmutableFacts(c.canonical_name, c.immutable_facts, 16))'), 'compaction must finish before next projection')
  assert.ok(inline.includes('await assertOwned()\n      const codex ='), 'inline verifies ownership before application')
  assert.ok(source.includes('} finally {\n    // The event is durable and metadata is ready.'))
  assert.equal((source.match(/^    startCharacterProjection\(\)/gm) || []).length, 1)
  assert.ok(source.includes('const fenceMs = Date.now() - fenceStartedAt'), 'prep fence timing retained')
})
console.log(`projection fence audit: ${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0

if (process.argv.includes('--bites') && !failed) {
  const leasePath = new URL('../worker/lib/character-projection-lease.ts', import.meta.url)
  const recoveryPath = new URL('../worker/processors/character-projection.processor.ts', import.meta.url)
  const generationPath = new URL('../worker/processors/generation.processor.ts', import.meta.url)
  const mutations = [
    { name: '(a) restore player-facing polling', path: leasePath, before: "log.info('projection.fence_inflight', {", after: "await sleep(120)\n      log.info('projection.fence_inflight', {", expected: 'FAIL (a)' },
    { name: '(b) extract against stale packet cards', path: generationPath, before: `const characterCodex = await timing.step('cards_read', () => mongoColl.characters().find({ instance_id: instanceOid }).toArray())`, after: 'const stalePacketCards = await mongoColl.characters().find({ instance_id: instanceOid }).toArray()', expected: 'FAIL inline' },
    { name: '(c) remove sequence barrier', path: leasePath, before: 'if (!prior) break', after: 'if (true) break', expected: 'FAIL (b,c)' },
    { name: '(d) omit background repair', path: leasePath, before: 'void repair(params).then((result) => {', after: 'void Promise.resolve({ skipped: true }).then((result) => {', expected: 'FAIL (d)' },
    { name: '(d) drop finally launch', path: generationPath, before: '    startCharacterProjection()\n', after: '', expected: 'FAIL inline' },
    { name: '(e) swallow failed extraction', path: leasePath, before: 'throw err\n  } finally', after: 'return { skipped: \'broken\' }\n  } finally', expected: 'FAIL (e)' },
    { name: '(f) double 60s bound', path: leasePath, before: 'CHARACTER_PROJECTION_ORDER_BUDGET_MS = 60_000', after: 'CHARACTER_PROJECTION_ORDER_BUDGET_MS = 120_000', expected: 'FAIL (f)' },
    { name: '(g) corrupt total', path: leasePath, before: 'total: Math.max(0, Date.now() - this.startedAt)', after: 'total: 0', expected: 'FAIL (g)' },
    { name: '(g) omit bond timing boundary', path: recoveryPath, before: '      onRaw,', after: '      onRaw: undefined,', expected: 'FAIL (g)' },
    { name: 'lose heartbeat', path: leasePath, before: '}, CHARACTER_PROJECTION_CLAIM_LEASE_MS / 4)', after: '}, CHARACTER_PROJECTION_CLAIM_LEASE_MS * 4)', expected: 'FAIL lease' },
    { name: 'drop zero-delta completion', path: recoveryPath, before: 'const deltas = event.data.codex_deltas ?? await timing.extract', after: 'const deltas = await timing.extract', expected: 'FAIL (d) ledgered' },
  ]
  for (const m of mutations) {
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
  console.log(`${mutations.length}/${mutations.length} mutations rejected; production files restored byte for byte`)
}
