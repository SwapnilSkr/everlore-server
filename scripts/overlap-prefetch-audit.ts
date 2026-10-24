/** Pure raw-search overlap audit. Real packet, retrieval, vector store and barrier;
 * fake Redis/index/Mongo only. Mutants live in a disposable temporary directory. */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { ObjectId } from 'mongodb'
import type { PineconeRecord, QueryResponse } from '@pinecone-database/pinecone'
import type { VectorIndex, VectorQuery } from '../src/services/vector-store'
import type { VectorPrefetch, VectorPrefetchInputs } from '../src/providers/rag.provider'

const unhandled: unknown[] = []
process.on('unhandledRejection', (error) => { unhandled.push(error) })
const mutant = process.argv[2] === '--checks-only' ? undefined : process.argv[2]
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const tid = '000000000000000000000010', iid = '000000000000000000000011', pid = '000000000000000000000012'
const inputs: VectorPrefetchInputs = { templateId: tid, instanceId: iid, queryText: 'I wait.', maxLoreResults: 10, maxMemoryResults: 25, timelineId: 'main' }
const networkForbidden = (): never => { throw new Error('Network forbidden in pure prefetch audit') }
globalThis.fetch = Object.assign(async () => networkForbidden(), { preconnect: networkForbidden })
const env = { VECTOR_LAYOUT: 'shared', PINECONE_SHARED_NAMESPACE: 'shared', RAG_RERANK_ENABLED: false, OVERLAP_PREFETCH: 'on' }
mock.module('../src/config/env', () => ({ env }))
const redisConfigUrl = new URL('../src/config/redis.ts', import.meta.url)
const { cacheRedisProcess, getRedisProcess: cachedProcess } = await import(mutant ? join(mutant, 'redisConfig.ts') : redisConfigUrl.pathname) as typeof import('../src/config/redis')
const runA = 'a'.repeat(40), runB = 'b'.repeat(40), runC = 'c'.repeat(40)
let identity: { runId: string } | undefined = { runId: runA }
const readyListeners = new Set<() => void>()
class RedisConnection extends EventEmitter {
  runId = runA
  infos = 0
  infoGate?: Promise<string>
  async info() { this.infos++; return this.infoGate ?? `# Server\r\nrun_id:${this.runId}\r\n` }
}
let cacheConnection: RedisConnection | undefined
const currentProcess = () => cacheConnection ? cachedProcess(cacheConnection) : identity
function attachConnection() {
  const connection = cacheConnection = new RedisConnection()
  cacheRedisProcess(connection as unknown as Parameters<typeof cacheRedisProcess>[0], () => { for (const listener of readyListeners) listener() })
  return connection
}
async function eventually(test: () => boolean) {
  for (let i = 0; i < 100 && !test(); i++) await Bun.sleep(2)
  assert.ok(test(), 'asynchronous recovery did not finish')
}
const transportUrl = new URL('../src/config/pinecone.ts', import.meta.url)
const transport = await import(mutant ? join(mutant, 'transport.ts') : transportUrl.pathname) as typeof import('../src/config/pinecone')
const wrappedFetch = transport.pineconeFetchApi(Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => new Response('{}', init), { preconnect: networkForbidden }))
async function headers(kind: 'write' | 'query', lsn: string | undefined) {
  const h = lsn === undefined ? {} : { [kind === 'write' ? 'x-pinecone-request-lsn' : 'x-pinecone-max-indexed-lsn']: lsn }
  await wrappedFetch('https://fixture.invalid', { headers: h })
}
let embedFailure = false, embedCalls = 0
mock.module('../src/ai', () => ({ embedQuery: async () => { embedCalls++; if (embedFailure) throw new Error('embedding timeout'); return [1, 0] },
  isEmbedTimeout: (e: Error) => e.message === 'embedding timeout', callLLM: networkForbidden, AI_MODELS: {} }))
// Models the durable hash and independently expiring writer registrations.
class RedisFixture {
  data = new Map<string, Record<string, string>>()
  strings = new Map<string, string>()
  flights = new Map<string, Map<string, number>>()
  ttls = new Map<string, number>()
  reads = 0
  failRead = false
  failFloorRead = false
  hangFloorRead = false
  failBegin = false
  failSettle = false
  hangRead = false
  readHook?: () => Promise<void>
  async reading<T>(result: T): Promise<T> {
    this.reads++
    if (this.failRead) throw new Error('injected Redis read failure')
    if (this.hangRead) return await new Promise<T>(() => {})
    if (this.readHook) await this.readHook()
    return result
  }
  async get(key: string) {
    if (this.hangFloorRead) return await new Promise<string | null>(() => {})
    if (this.failFloorRead) throw new Error('injected floor read failure')
    this.reads++; return this.strings.get(key) ?? null
  }
  async eval(script: string, count: number, ...args: string[]) {
    const key = args[0]
    if (script.includes('local previous = redis.call("get"')) {
      assert.equal(count, 1)
      const lsn = args[1], runId = args[2], previous = this.strings.get(key)
      const parsed = /^([0-9a-f]{40}):(0|[1-9][0-9]*)$/.exec(previous ?? '')
      if (!parsed || (parsed[1] !== runId && script.includes('previousRun ~= run')) || BigInt(lsn) > BigInt(parsed[2]) || script.includes('if true or')) this.strings.set(key, `${runId}:${lsn}`)
      this.ttls.delete(key)
      return this.strings.get(key)
    }
    assert.equal(count, 2)
    const flightKey = args[1]
    let row = this.data.get(key)
    if (script.includes('tostring(redis.call("exists"')) {
      const now = Number(args[2])
      const inFlight = [...(this.flights.get(flightKey)?.values() ?? [])].filter((deadline) => deadline > now).length
      return this.reading([row ? '1' : '0', String(inFlight), row?.epoch ?? '', row?.unknown ?? '', row?.version ?? '', row?.lsn ?? ''])
    }
    const begin = script.includes('redis.call("zadd"')
    if (begin ? this.failBegin : this.failSettle) throw new Error('injected Redis write failure')
    let leases = this.flights.get(flightKey)
    if (!leases) { leases = new Map(); this.flights.set(flightKey, leases) }
    if (begin) {
      const [, , registration, now, deadline] = args
      if (!row) { row = { epoch: registration, unknown: '1', version: '0' }; this.data.set(key, row) }
      for (const [id, expiry] of leases) if (expiry <= Number(now)) leases.delete(id)
      leases.set(registration, Number(deadline)); this.ttls.set(flightKey, 3600)
      this.ttls.delete(key)
      if (script.includes('redis.call("expire", KEYS[1]')) this.ttls.set(key, 3600)
      return [row.epoch, row.version]
    }
    const [, , epoch, version, lsn, newEpoch, registration, now, deleted] = args
    const same = row?.epoch === epoch && (leases.get(registration) ?? 0) > Number(now)
    leases.delete(registration)
    if (!row) { row = { epoch: newEpoch, unknown: '1', version: '0' }; this.data.set(key, row) }
    const newer = lsn !== '' && (row.lsn === undefined || BigInt(lsn) > BigInt(row.lsn))
    if (newer) row.lsn = lsn
    if (!same || lsn === '') { row.unknown = '1'; row.version = String(Number(row.version) + 1) }
    else if (newer && row.version === version) row.unknown = '0'
    this.ttls.delete(key)
    if (script.includes('redis.call("expire", KEYS[1]')) this.ttls.set(key, 3600)
    if (deleted === 'deleted' && same && leases.size === 0 && script.includes('redis.call("del", KEYS[1], KEYS[2])')) await this.del(key, flightKey)
    return 1
  }
  async del(...keys: string[]) {
    for (const key of keys) { this.data.delete(key); this.flights.delete(key); this.strings.delete(key); this.ttls.delete(key) }
    return 1
  }
}
const keyFor = (kind: 'lore' | 'mem' | 'sum') => `vecf:v1:shared:${kind}:${kind === 'lore' ? tid : iid}`
const floorKey = 'vecf:v1:shared:floor'
let redis = new RedisFixture()
mock.module('../src/config/redis', () => ({ getRedisClient: () => redis, getRedisProcess: currentProcess,
  onRedisProcessReady: (listener: () => void) => { readyListeners.add(listener); return () => { readyListeners.delete(listener) } } }))
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
class FakeIndex {
  data = new Map<string, Map<string, PineconeRecord>>()
  calls: string[] = []
  writeCalls: string[] = []
  rejectQueries = new Set<string>()
  queryGate?: ReturnType<typeof deferred<void>>
  writeGate?: ReturnType<typeof deferred<void>>
  throwWrite = false
  missingWriteLsn = false
  missingQueryLsn = false
  lsns = new Map<string, bigint>()
  indexed = new Map<string, string>()
  nextQueryLsns: string[] = []
  async acknowledged(name: string) {
    const next = (this.lsns.get(name) ?? 0n) + 1n
    this.lsns.set(name, next)
    await headers('write', this.missingWriteLsn ? undefined : String(next))
  }
  namespace(name: string) {
    const rows = () => { if (!this.data.has(name)) this.data.set(name, new Map()); return this.data.get(name)! }
    return {
      upsert: async ({ records }: { records: PineconeRecord[] }) => {
        this.writeCalls.push('upsert')
        if (this.writeGate) await this.writeGate.promise
        for (const row of records) rows().set(row.id, structuredClone(row))
        if (this.throwWrite) throw new Error('partly applied write')
        await this.acknowledged(name)
      },
      query: async (query: VectorQuery): Promise<QueryResponse> => {
        const clauses = (query.filter as { $and?: object[] })?.$and ?? [query.filter]
        const kind = clauses.map((f) => (f as { scope_kind?: { $eq: string } })?.scope_kind?.$eq).find(Boolean) ?? name.split('_')[0]
        this.calls.push(kind)
        const matches = [...rows().values()].filter((r) => clauses.every((filter) => !filter || Object.entries(filter).every(
          ([field, value]) => r.metadata?.[field] === (value as { $eq: unknown }).$eq))).slice(0, query.topK).map((r) => ({ id: r.id, score: 0.9, metadata: r.metadata }))
        const indexedLsn = this.nextQueryLsns.shift() ?? this.indexed.get(name) ?? String(this.lsns.get(name) ?? 0n)
        if (this.queryGate) await this.queryGate.promise
        if (this.rejectQueries.has(kind)) throw new Error('injected query failure')
        await headers('query', this.missingQueryLsn ? undefined : indexedLsn)
        return { matches, namespace: name }
      },
      deleteMany: async ({ ids }: { ids: string[] }) => {
        this.writeCalls.push('delete')
        if (this.writeGate) await this.writeGate.promise
        for (const id of ids) rows().delete(id)
        if (this.throwWrite) throw new Error('partly applied write')
        await this.acknowledged(name)
      },
      deleteAll: async () => {
        if (this.writeGate) await this.writeGate.promise
        rows().clear()
        if (this.throwWrite) throw new Error('partly applied write')
        await this.acknowledged(name)
      },
      listPaginated: async ({ prefix }: { prefix?: string } = {}) => ({ vectors: [...rows().keys()].filter((id) => !prefix || id.startsWith(prefix)).map((id) => ({ id })) }),
    }
  }
  native() { return this as unknown as VectorIndex } // SDK index has private transport fields the fake never uses.
}
let index = new FakeIndex()
mock.module('../src/config/pinecone', () => ({ ...transport, getPineconeIndex: () => index.native() }))
// Deliberately partial heterogeneous Mongo documents/operators in this fixture only.
type Row = Record<string, any>
let mongoReads = 0
let summaryRows: Row[] = []
const events = Array.from({ length: 6 }, (_, i) => ({ _id: new ObjectId(), instance_id: new ObjectId(iid), sequence: 50 + i, data: { ai_response: 'Settled narration.' } }))
function collection(name: string) {
  return {
    find: (filter: Row = {}) => {
      mongoReads++
      let result = name === 'events' ? [...events] : ['sceneSummaries', 'chapterSummaries', 'arcSummaries'].includes(name)
        ? summaryRows.filter((r) => r.tier === name && filter.pinecone_id?.$in.includes(r.pinecone_id) && r.status !== 'stale') : []
      const cursor = { sort: (order: Row) => { if (name === 'events') result.sort((a, b) => (a.sequence - b.sequence) * order.sequence); return cursor },
        limit: (n: number) => { result = result.slice(0, n); return cursor }, project: () => cursor, toArray: async () => result }
      return cursor
    },
    findOne: async () => { mongoReads++; return null },
    updateMany: async () => ({}), updateOne: async () => ({}),
  }
}
mock.module('../src/config/mongo', () => ({ mongoColl: new Proxy({}, { get: (_t, name) => () => collection(String(name)) }) }))
mock.module('../src/services/character-codex.service', () => ({ rankCodexForInjection: () => [] }))
mock.module('../src/services/entity-graph.service', () => ({ normalizeEntityName: (s: string) => s.toLowerCase(), entityGraphService: {
  normalizeEntityName: (s: string) => s.toLowerCase(), findMentionedCharacterCards: async () => ({ mentionedEntityIds: [], cards: [] }),
  wakeStubsByCues: async () => ({ entityIds: [] }),
} }))
mock.module('../src/services/kinship-graph.service', () => ({ kinshipGraphService: { kinshipBrief: async () => [] } }))
mock.module('../src/services/time.service', () => ({ timeService: { timelineContext: async () => null } }))
mock.module('../src/services/scene-state.service', () => ({ loadCurrentSceneState: async () => null }))
const storeUrl = new URL('../src/services/vector-store.ts', import.meta.url)
const ragUrl = new URL('../src/providers/rag.provider.ts', import.meta.url)
const floorUrl = new URL('./vector-freshness-floor.ts', import.meta.url)
const packetUrl = new URL('../src/services/context-packet.service.ts', import.meta.url)
const store = await import(mutant ? join(mutant, 'store.ts') : storeUrl.pathname) as typeof import('../src/services/vector-store')
const rag = await import(mutant ? join(mutant, 'rag.ts') : ragUrl.pathname) as typeof import('../src/providers/rag.provider')
const { buildContextPacket } = await import(mutant ? join(mutant, 'packet.ts') : packetUrl.pathname) as typeof import('../src/services/context-packet.service')
const { runFreshnessFloor } = await import(mutant ? join(mutant, 'floor.ts') : floorUrl.pathname) as typeof import('./vector-freshness-floor')
const { waitForPriorGeneration } = await import('../src/utils/generation-lock')
function record(id: string, text: string): PineconeRecord { return { id, values: [1, 0], metadata: { text, timeline_id: 'main' } } }
async function reset() {
  identity = { runId: runA }; cacheConnection = undefined; readyListeners.clear()
  env.VECTOR_LAYOUT = 'shared'; env.OVERLAP_PREFETCH = 'on'; index = new FakeIndex(); redis = new RedisFixture(); mongoReads = 0; summaryRows = []; embedFailure = false
  await store.vectorStore.upsert({ kind: 'lore', templateId: tid }, [record('lore1', 'Fixture lore')])
  await store.vectorStore.upsert({ kind: 'mem', instanceId: iid }, [record('memory1', 'Fixture memory')])
  await addSummary('summary1', 'Fixture summary')
  await runFreshnessFloor(['--execute'], floorRuntime())
  index.calls = []
}
function floorRuntime(log: (line: string) => void = () => {}) {
  const runtime = { layout: env.VECTOR_LAYOUT as 'shared' | 'namespaced' | 'dual', namespace: 'shared',
    store: { upsert: store.vectorStore.upsert, deleteIds: store.vectorStore.deleteIds }, raise: store.raiseVectorFreshnessFloor, log,
    establish: () => store.establishVectorFreshnessFloor(runtime.store, runtime.raise) }
  return runtime
}
async function addSummary(id: string, text: string, end = 3) {
  summaryRows.push({ tier: 'chapterSummaries', pinecone_id: id, summary_text: text, event_range: { start_sequence: 1, end_sequence: end } })
  await store.vectorStore.upsert({ kind: 'sum', instanceId: iid }, [record(id, text)])
}
function start(overrides: Partial<Parameters<typeof rag.startVectorPrefetch>[0]> = {}) {
  return rag.startVectorPrefetch({ priorTurnId: 'N', isContinuation: false, inputs, embedding: Promise.resolve([1, 0]), ...overrides })
}
async function settle(p: VectorPrefetch) {
  for (let i = 0; i < 80 && p.settled === undefined; i++) await Bun.sleep(1)
  assert.equal(p.settled, true, 'prefetch never settled')
}
function packet(prefetch?: VectorPrefetch, changes: Partial<VectorPrefetchInputs> = {}) {
  const q = { ...inputs, ...changes }
  return buildContextPacket({ instanceId: q.instanceId, playerId: pid, userMessage: q.queryText, isContinuation: false, vectorPrefetch: prefetch,
    session: { template_id: q.templateId, max_lore_results: q.maxLoreResults, max_context_memories: q.maxMemoryResults,
      current_time_anchor: { timeline_id: q.timelineId } as Parameters<typeof buildContextPacket>[0]['session']['current_time_anchor'] } })
}
const texts = (p: Awaited<ReturnType<typeof packet>>) => ({ lore: p.loreTexts, memory: p.memoryTexts, summary: p.relevantSummaries })
let passed = 0, failed = 0
async function check(name: string, run: () => Promise<void>) {
  try { await reset(); await run(); passed++; console.log(`ok ${name}`) }
  catch (error) { failed++; console.error(`FAIL ${name}: ${(error as Error).message}`) }
}
await check('(a) successor overlap reuses all raw responses; packet texts equal fresh search', async () => {
  await redis.del(keyFor('lore'), keyFor('sum')) // Written before the floor; no tracked history.
  const saved = deferred<void>(); let promoted = false, barrierDone = false
  const lockRedis = { get: async (key: string) => {
    if (key.includes(':done:')) { await saved.promise; return 'saved' }
    return JSON.stringify(promoted ? { owner: 'N1', phase: 'running' } : { owner: 'N', phase: 'tail', next: 'N1' })
  } }
  const waiting = waitForPriorGeneration(lockRedis as Parameters<typeof waitForPriorGeneration>[0], 'lock', 'N1', 'N', { timeoutMs: 1000 })
    .then(() => { barrierDone = true })
  const p = start()!; assert.ok(p); await settle(p)
  assert.equal(barrierDone, false, 'searches must finish while the barrier is waiting')
  promoted = true; saved.resolve(); await waiting
  assert.equal(mongoReads, 0, 'prefetch must not read Mongo'); assert.deepEqual(index.calls.sort(), ['lore', 'mem', 'sum'])
  index.calls = []; const reused = await packet(p)
  assert.equal(reused.prefetchOutcome, 'reused'); assert.deepEqual(index.calls, [])
  assert.equal(typeof reused.prepStages.vector_prefetch, 'number')
  const fresh = await packet(); assert.deepEqual(texts(reused), texts(fresh))
  assert.deepEqual(texts(reused), { lore: ['Fixture lore'], memory: ['Fixture memory'], summary: ['Fixture summary'] })
  assert.equal(Object.hasOwn(fresh, 'prefetchOutcome'), false); assert.equal(Object.hasOwn(fresh.prepStages, 'vector_prefetch'), false)
})
await check('(b) memory upsert reruns only memories and retrieves the new memory', async () => {
  const p = start()!; await settle(p)
  await store.vectorStore.upsert({ kind: 'mem', instanceId: iid }, [record('memory2', 'New memory')])
  index.calls = []; const result = await packet(p)
  assert.deepEqual(index.calls, ['mem']); assert.ok(result.memoryTexts.includes('New memory')); assert.match(result.prefetchOutcome!, /memory:lsn_behind/)
})
await check('(c) summary upsert and deleteIds rerun only the affected search', async () => {
  const p = start()!; await settle(p); await addSummary('summary2', 'New summary', 4)
  index.calls = []; const result = await packet(p); assert.deepEqual(index.calls, ['sum']); assert.ok(result.relevantSummaries.includes('New summary'))
  for (const kind of ['mem', 'sum'] as const) {
    const p = start()!; await settle(p)
    await store.vectorStore.deleteIds({ kind, instanceId: iid }, [kind === 'mem' ? 'memory1' : 'summary1'])
    index.calls = []; const result = await packet(p); assert.deepEqual(index.calls, [kind])
    assert.ok(!(kind === 'mem' ? result.memoryTexts : result.relevantSummaries).includes(kind === 'mem' ? 'Fixture memory' : 'Fixture summary'))
  }
})
await check('(b2) acknowledged before prefetch but not indexed reruns only memory', async () => {
  const namespace = 'shared', before = new Map(index.data.get(namespace))
  await store.vectorStore.upsert({ kind: 'mem', instanceId: iid }, [record('ack', 'Already acknowledged')])
  const after = index.data.get(namespace)!
  // Acknowledgement precedes query visibility: speculation sees the old index.
  index.data.set(namespace, before); index.nextQueryLsns = [String(index.lsns.get(namespace)), store.parseVectorFreshnessFloor(redis.strings.get(floorKey))!.lsn, String(index.lsns.get(namespace))]
  const p = start()!; await settle(p)
  assert.ok(!p.responses.memory!.matches.some((r) => r.id === 'ack'))
  index.data.set(namespace, after); index.indexed.clear(); index.calls = []
  const result = await packet(p)
  assert.deepEqual(index.calls, ['mem']); assert.equal(result.prefetchOutcome, 'rerun:memory:lsn_behind')
  assert.ok(result.memoryTexts.includes('Already acknowledged'))
})
await check('(d) unreadable/missing/malformed/expired Redis and unknown query LSN fail closed; bounded reads', async () => {
  const p = start()!; await settle(p); redis.failRead = true
  index.calls = []; const result = await packet(p); assert.deepEqual(index.calls.sort(), ['lore', 'mem', 'sum'])
  assert.match(result.prefetchOutcome!, /lsn_unknown/); redis.failRead = false
  for (const field of ['epoch', 'unknown', 'version', 'lsn']) {
    const row = redis.data.get(keyFor('mem'))!, original = row[field]
    row[field] = 'malformed'
    if (field === 'epoch') row[field] = ''
    index.calls = []; await packet(p); assert.deepEqual(index.calls, ['mem'], field)
    row[field] = original
  }
  redis.data.set(keyFor('sum'), { unrelated: 'malformed' })
  index.calls = []; await packet(p); assert.deepEqual(index.calls, ['sum'])
  await redis.del(keyFor('sum'))
  index.calls = []; await packet(p); assert.deepEqual(index.calls, [])
  index.missingQueryLsn = true; const missing = start()!; await settle(missing); index.missingQueryLsn = false
  index.calls = []; await packet(missing); assert.deepEqual(index.calls.sort(), ['lore', 'mem', 'sum'])
  redis.hangRead = true
  const at = Date.now(); const selection = await rag.reusableVectorPrefetch(p, inputs)
  assert.deepEqual(selection.responses, {}); assert.ok(Date.now() - at < 1000)
})
await check('(e) changed query, both topKs, scope ids or timeline rerun all searches', async () => {
  const p = start()!; await settle(p)
  for (const change of [{ queryText: 'Different words' }, { maxLoreResults: 11 }, { maxMemoryResults: 26 }, { timelineId: 'branch' },
    { templateId: '000000000000000000000020' }, { instanceId: '000000000000000000000021' }]) {
    const selection = await rag.reusableVectorPrefetch(p, { ...inputs, ...change })
    assert.deepEqual(selection.responses, {}); assert.match(selection.outcome, /^rerun:inputs:/)
    index.calls = []; await packet(p, change); assert.deepEqual(index.calls.sort(), ['lore', 'mem', 'sum'])
  }
})
await check('(f) head, Continue, world action and replay never prefetch; processor wires only input embedding', async () => {
  for (const overrides of [{ priorTurnId: undefined }, { isContinuation: true }, { worldAction: { kind: 'travel' } }, { replay: true }]) assert.equal(start(overrides), undefined)
  await Bun.sleep(1); assert.deepEqual(index.calls, [])
  const source = readFileSync(new URL('../worker/processors/generation.processor.ts', import.meta.url), 'utf8')
  const prefetchAt = source.indexOf("const vectorPrefetch = env.OVERLAP_PREFETCH === 'on' && earlyEmbedding ? startVectorPrefetch(")
  assert.ok(prefetchAt >= 0)
  const barrierAt = source.indexOf('const priorTurnWaitMs = await waitForPriorGeneration(')
  assert.ok(source.indexOf("if (job.data?.mode === 'replay')") < prefetchAt)
  assert.ok(source.includes('priorTurnId: job.data.priorTurnId, isContinuation, worldAction,'))
  assert.ok(prefetchAt < barrierAt && prefetchAt > source.indexOf('await redis.publish('))
  assert.ok(source.includes('const packet = await buildContextPacket({\n    vectorPrefetch,'))
  assert.ok(source.includes('prefetch_outcome: packet.prefetchOutcome'))
  assert.ok(!source.includes('Object.assign(prepStages, { vector_prefetch:'))
  const { buildPrepStages } = await import('../src/models/generation-log.model')
  assert.deepEqual(buildPrepStages({ vector_prefetch: 12.4 }), { vector_prefetch: 12 })
})
await check('(flag) off never starts prefetch and packet bytes equal the ordinary packet', async () => {
  const p = start()!; await settle(p)
  env.OVERLAP_PREFETCH = 'off'; index.calls = []; const reads = redis.reads
  assert.equal(start(), undefined)
  await Bun.sleep(1); assert.deepEqual(index.calls, [])
  const now = Date.now; Date.now = () => 123456789
  try {
    const ordinary = JSON.stringify(await packet())
    const withUnusedPrefetch = JSON.stringify(await packet(p))
    assert.equal(withUnusedPrefetch, ordinary)
    assert.equal(redis.reads, reads)
    assert.deepEqual(index.calls.sort(), ['lore', 'lore', 'mem', 'mem', 'sum', 'sum'])
  } finally { Date.now = now; env.OVERLAP_PREFETCH = 'on' }
  const source = readFileSync(new URL('../src/config/env.ts', import.meta.url), 'utf8')
  assert.ok(source.includes("OVERLAP_PREFETCH: 'off',"))
  assert.ok(source.includes("OVERLAP_PREFETCH: process.env.OVERLAP_PREFETCH === 'on' ? 'on' : 'off',"))
})
await check('(g) rejected/pending prefetch and embedding timeout fall back without delaying packet', async () => {
  index.rejectQueries.add('mem'); const rejected = start()!; await settle(rejected); index.rejectQueries.clear()
  index.calls = []; await packet(rejected); assert.deepEqual(index.calls, ['mem'])
  const embedding = deferred<number[]>(); const timed = start({ embedding: embedding.promise })!
  embedding.reject(new Error('embedding timeout')); await settle(timed)
  index.calls = []; const fallback = await packet(timed); assert.deepEqual(index.calls.sort(), ['lore', 'mem', 'sum'])
  assert.equal(Object.hasOwn(fallback, 'prefetchOutcome'), false); assert.equal(Object.hasOwn(fallback.prepStages, 'vector_prefetch'), false)
  const gate = index.queryGate = deferred<void>(); const pending = start()!
  await Bun.sleep(1); index.queryGate = undefined; index.calls = []
  await packet(pending); assert.deepEqual(index.calls.sort(), ['lore', 'mem', 'sum']); gate.resolve(); await settle(pending)
})
await check('(h) predecessor failure/timeout abandon rejecting prefetch with no unhandled rejection', async () => {
  {
    for (const outcome of ['failed', 'timeout']) {
      const gate = index.queryGate = deferred<void>(); const p = start()!; await Bun.sleep(1)
      const r = { get: async (key: string) => key.includes(':done:') ? outcome === 'failed' ? 'failed' : null : JSON.stringify({ owner: 'N', phase: 'tail', next: 'N1' }) }
      await assert.rejects(waitForPriorGeneration(r as Parameters<typeof waitForPriorGeneration>[0], 'lock', 'N1', 'N', { timeoutMs: 8 }), /Prior turn unavailable/)
      gate.reject(new Error('late abandoned rejection')); await settle(p); await Bun.sleep(1)
      index.queryGate = undefined
      const embedding = deferred<number[]>(); const abandoned = start({ embedding: embedding.promise })!
      await assert.rejects(waitForPriorGeneration(r as Parameters<typeof waitForPriorGeneration>[0], 'lock', 'N1', 'N', { timeoutMs: 8 }), /Prior turn unavailable/)
      embedding.reject(new Error('late abandoned embedding timeout')); await settle(abandoned); await Bun.sleep(1)
    }
    assert.deepEqual(unhandled, [])
  }
})
await check('(i) in-flight count covers every whole write; failures tombstone until a later known LSN', async () => {
  for (const kind of ['mem', 'sum'] as const) for (const operation of ['upsert', 'deleteIds', 'deleteScope'] as const) for (const throws of [false, true]) {
    const scope = { kind, instanceId: iid }
    await store.vectorStore.upsert(scope, [record('write', 'Existing')])
    const p = start()!; await settle(p)
    index.writeGate = deferred<void>(); index.throwWrite = throws
    const write = operation === 'upsert' ? store.vectorStore.upsert(scope, [record('write', 'New')]) : operation === 'deleteIds' ? store.vectorStore.deleteIds(scope, ['write']) : store.vectorStore.deleteScope(scope)
    const caught = write.catch((e) => e as Error)
    await Bun.sleep(1)
    assert.equal((await store.readVectorWriteStates(iid, tid))[kind]?.inFlight, 1)
    const blocked = await rag.reusableVectorPrefetch(p, inputs)
    assert.match(blocked.outcome, new RegExp(`${kind === 'mem' ? 'memory' : 'summary'}:in_flight`))
    index.writeGate.resolve(); const error = await caught
    assert.equal(error instanceof Error, throws)
    const after = (await store.readVectorWriteStates(iid, tid))[kind]!
    assert.equal(after.inFlight, 0); assert.equal(after.highestLsn === undefined, throws || operation === 'deleteScope')
    assert.equal(redis.ttls.has(keyFor(kind)), false)
    index.writeGate = undefined; index.throwWrite = false
    if (throws) {
      const unknown = start()!; await settle(unknown)
      assert.match((await rag.reusableVectorPrefetch(unknown, inputs)).outcome, /lsn_unknown/)
      await store.vectorStore.upsert(scope, [record('repair', 'Later acknowledged')])
      const repaired = start()!; await settle(repaired)
      assert.equal((await rag.reusableVectorPrefetch(repaired, inputs)).outcome, 'reused')
    }
  }
})
await check('(unknown) missing write header tombstones; older concurrent acknowledgements cannot clear it', async () => {
  index.missingWriteLsn = true
  assert.equal(await store.vectorStore.upsert({ kind: 'mem', instanceId: iid }, [record('noHeader', 'Unknown')]), undefined)
  index.missingWriteLsn = false
  const p = start()!; await settle(p)
  assert.equal((await rag.reusableVectorPrefetch(p, inputs)).outcome, 'rerun:memory:lsn_unknown')
  await store.vectorStore.upsert({ kind: 'mem', instanceId: iid }, [record('known', 'Known')])
  const known = start()!; await settle(known)
  assert.equal((await rag.reusableVectorPrefetch(known, inputs)).outcome, 'reused')
  const scope = { kind: 'mem', instanceId: iid } as const
  const gate = index.writeGate = deferred<void>()
  const slow = store.vectorStore.upsert(scope, [record('slow', 'Older flight')]); await Bun.sleep(1)
  index.writeGate = undefined; index.missingWriteLsn = true
  await store.vectorStore.upsert(scope, [record('unknown', 'Unknown concurrent')]); index.missingWriteLsn = false
  gate.resolve(); await slow
  assert.equal((await store.readVectorWriteStates(iid, tid)).mem?.highestLsn, undefined)
  await store.vectorStore.upsert(scope, [record('repair', 'Later flight')])
  assert.ok((await store.readVectorWriteStates(iid, tid)).mem?.highestLsn)
})
await check('(redis-write) failed begin/settle never fails a vector write; missing proof blocks reuse', async () => {
  for (const field of ['failBegin', 'failSettle'] as const) {
    await reset()
    const p = start()!; await settle(p); redis[field] = true
    await store.vectorStore.upsert({ kind: 'mem', instanceId: iid }, [record(field, 'Applied despite Redis failure')])
    redis[field] = false; index.calls = []
    if (field === 'failSettle') assert.equal((await store.readVectorWriteStates(iid, tid)).mem?.inFlight, 1, 'failed settlement must preserve the raised count')
    const result = await packet(p); assert.deepEqual(index.calls, ['mem']); assert.match(result.prefetchOutcome!, /lsn_unknown|in_flight/)
    await store.vectorStore.upsert({ kind: 'mem', instanceId: iid }, [record('repair', 'Known again')])
  }
})
await check('(headers) concurrent queries keep exact per-call LSNs; malformed headers are unknown', async () => {
  index.nextQueryLsns = ['9007199254740993', '9007199254740994']
  const gate = index.queryGate = deferred<void>()
  const a = store.vectorStore.query({ kind: 'mem', instanceId: iid }, { vector: [1, 0], topK: 1 })
  const b = store.vectorStore.query({ kind: 'sum', instanceId: iid }, { vector: [1, 0], topK: 1 })
  await Bun.sleep(1); gate.resolve()
  const results = await Promise.all([a, b]); index.queryGate = undefined
  assert.deepEqual(results.map((r) => r.indexedLsn), ['9007199254740993', '9007199254740994'])
  for (const bad of [undefined, '', '-1', '1.5', 'NaN', '4e2']) {
    const result = await transport.withPineconeLsn(() => headers('write', bad))
    assert.equal(result.writeLsn, undefined)
    const query = await transport.withPineconeLsn(() => headers('query', bad))
    assert.equal(query.indexedLsn, undefined)
  }
  const request = new Request('https://fixture.invalid', { method: 'POST', body: 'identical' })
  const init: RequestInit = { headers: { unchanged: 'yes' } }, response = new Response('{}', { headers: { 'x-pinecone-request-lsn': '12' } })
  const passthrough = transport.pineconeFetchApi(Object.assign(async (input: RequestInfo | URL, options?: RequestInit) => {
    assert.equal(input, request); assert.equal(options, init); return response
  }, { preconnect: networkForbidden }))
  assert.equal(await passthrough(request, init), response)
})
await check('(snapshot) a query settling during validation cannot join the packet', async () => {
  const p = start()!; await settle(p)
  const late = p.responses.memory!; delete p.responses.memory
  redis.readHook = async () => { p.responses.memory = late }
  const selection = await rag.reusableVectorPrefetch(p, inputs)
  assert.equal(selection.responses.memory, undefined); assert.match(selection.outcome, /memory:unsettled/)
})
await check('(batches) max LSNs for batched and composite writes; epoch expiry cannot decrement a new count', async () => {
  const scope = { kind: 'mem', instanceId: iid } as const
  assert.equal(await store.vectorStore.upsert(scope, Array.from({ length: 201 }, (_, i) => record(`batch${i}`, 'Batch'))), '8')
  assert.equal(await store.vectorStore.deleteIds(scope, Array.from({ length: 1001 }, (_, i) => `batch${i}`)), '10')
  assert.equal(await store.vectorStore.deleteScope(scope), '11')
  const loreLsn = await store.vectorStore.replaceLore({ kind: 'lore', templateId: tid }, [record('replacement', 'New lore')])
  assert.equal(loreLsn, '13')
  const gate = index.writeGate = deferred<void>(); const old = store.vectorStore.upsert(scope, [record('oldEpoch', 'Old')])
  await Bun.sleep(1); await redis.del(`${keyFor('mem')}:flight`); index.writeGate = undefined
  await store.vectorStore.upsert(scope, [record('newEpoch', 'New')]); gate.resolve(); await old
  const state = (await store.readVectorWriteStates(iid, tid)).mem!
  assert.equal(state.inFlight, 0); assert.equal(state.highestLsn, undefined)
})
await check('lore republish blocks only lore; post-barrier summary Mongo checks remain authoritative', async () => {
  const p = start()!; await settle(p)
  const gate = index.writeGate = deferred<void>()
  const replacing = store.vectorStore.replaceLore({ kind: 'lore', templateId: tid }, [record('lore2', 'Republished lore')])
  await Bun.sleep(1)
  assert.match((await rag.reusableVectorPrefetch(p, inputs)).outcome, /lore:in_flight/)
  gate.resolve(); await replacing; index.writeGate = undefined
  index.calls = []; const result = await packet(p); assert.deepEqual(index.calls, ['lore']); assert.deepEqual(result.loreTexts, ['Republished lore'])
  const beforeMongoChange = start()!; await settle(beforeMongoChange)
  summaryRows[0].summary_text = 'Authoritative Mongo summary'
  const authoritative = await packet(beforeMongoChange); assert.deepEqual(authoritative.relevantSummaries, ['Authoritative Mongo summary'])
  summaryRows[0].status = 'stale'; assert.deepEqual((await packet(beforeMongoChange)).relevantSummaries, [])
  summaryRows[0].status = 'active'; summaryRows[0].event_range.end_sequence = 55
  assert.deepEqual((await packet(beforeMongoChange)).relevantSummaries, [])
})
await check('(floor-b) absent, malformed, unreadable floor never authorizes reuse', async () => {
  const p = start()!; await settle(p)
  redis.failFloorRead = true
  assert.deepEqual((await rag.reusableVectorPrefetch(p, inputs)).responses, {})
  redis.failFloorRead = false
  redis.hangFloorRead = true
  const at = Date.now(); assert.deepEqual((await rag.reusableVectorPrefetch(p, inputs)).responses, {})
  assert.ok(Date.now() - at < 1000); redis.hangFloorRead = false
  for (const value of [undefined, '', '-1', '1.5', '01', 'bad']) {
    if (value === undefined) redis.strings.delete(floorKey)
    else redis.strings.set(floorKey, value)
    index.calls = []; const result = await packet(p)
    assert.deepEqual(index.calls.sort(), ['lore', 'mem', 'sum'])
    assert.equal(result.prefetchOutcome, 'rerun:lore:no_floor,memory:no_floor,summary:no_floor')
  }
})
await check('(floor-c) indexed LSN below floor reruns even scopes with no state', async () => {
  const p = start()!; await settle(p)
  await redis.del(keyFor('lore'), keyFor('sum'))
  redis.strings.set(floorKey, `${runA}:${BigInt(p.responses.lore!.indexedLsn!) + 1n}`)
  index.calls = []; const result = await packet(p)
  assert.deepEqual(index.calls.sort(), ['lore', 'mem', 'sum'])
  assert.match(result.prefetchOutcome!, /lore:below_floor.*summary:below_floor/)
})
await check('(floor-e) expired writer lease preserves durable LSN and tombstone; busy scope recovers', async () => {
  const p = start()!; await settle(p)
  await store.vectorStore.upsert({ kind: 'mem', instanceId: iid }, [record('durable', 'Durable memory')])
  const key = keyFor('mem'), highest = redis.data.get(key)!.lsn
  redis.flights.set(`${key}:flight`, new Map([['crashed', Date.now() - 1]]))
  const state = (await store.readVectorWriteStates(iid, tid)).mem!
  assert.equal(state.inFlight, 0); assert.equal(state.highestLsn, highest)
  assert.equal(redis.ttls.has(key), false)
  index.calls = []; const result = await packet(p)
  assert.deepEqual(index.calls, ['mem']); assert.match(result.prefetchOutcome!, /memory:lsn_behind/)
  const fresh = start()!; await settle(fresh)
  assert.equal((await rag.reusableVectorPrefetch(fresh, inputs)).outcome, 'reused')
  await store.vectorStore.upsert({ kind: 'mem', instanceId: iid }, [record('busy', 'Busy')])
  assert.equal(redis.flights.get(`${key}:flight`)!.has('crashed'), false)
  redis.data.get(key)!.unknown = '1'
  await redis.del(`${key}:flight`)
  assert.equal(redis.data.get(key)!.unknown, '1')
  assert.equal((await rag.reusableVectorPrefetch(fresh, inputs)).responses.memory, undefined)
})
await check('(floor-f) namespaced and dual never start or reuse prefetch; writes remain tracked', async () => {
  const p = start()!; await settle(p)
  for (const layout of ['namespaced', 'dual']) {
    env.VECTOR_LAYOUT = layout
    const reads = redis.reads
    assert.equal(start(), undefined)
    assert.deepEqual((await rag.reusableVectorPrefetch(p, inputs)).responses, {})
    assert.equal(redis.reads, reads)
    const writer = store.createVectorStore({ layout: layout as 'namespaced' | 'dual', sharedNamespace: 'shared', getIndex: () => index.native() })
    await writer.upsert({ kind: 'mem', instanceId: iid }, [record('tracked', 'Tracked')])
    assert.ok(redis.data.get(`vecf:v1:mem_${iid}:mem:${iid}`)?.lsn)
  }
})
await check('(floor-g) operator dry run, layout/header refusal, cleanup and monotonic floor', async () => {
  const output: string[] = [], calls = [...index.calls], lsns = [...index.lsns], rows = structuredClone(index.data), proof = structuredClone(redis.data)
  const before = redis.strings.get(floorKey), reads = redis.reads
  await runFreshnessFloor([], floorRuntime((line) => output.push(line)))
  assert.match(output.join('\n'), /DRY RUN.*would upsert/s)
  assert.deepEqual(index.calls, calls); assert.deepEqual([...index.lsns], lsns); assert.deepEqual(index.data, rows)
  assert.deepEqual(redis.data, proof); assert.equal(redis.reads, reads); assert.equal(redis.strings.get(floorKey), before)
  for (const layout of ['namespaced', 'dual'] as const) {
    for (const args of [[], ['--execute']]) await assert.rejects(runFreshnessFloor(args, { ...floorRuntime(), layout }), /requires VECTOR_LAYOUT=shared/)
  }
  await assert.rejects(runFreshnessFloor(['--bogus'], floorRuntime()), /Unknown argument/)
  for (const missing of ['upsert', 'deleteIds'] as const) {
    const runtime = floorRuntime(), real = runtime.store
    const withoutHeader = async (call: () => Promise<string | undefined>) => {
      index.missingWriteLsn = true
      try { return await call() }
      finally { index.missingWriteLsn = false }
    }
    runtime.store = {
      upsert: (...args) => missing === 'upsert' ? withoutHeader(() => real.upsert(...args)) : real.upsert(...args),
      deleteIds: (...args) => missing === 'deleteIds' ? withoutHeader(() => real.deleteIds(...args)) : real.deleteIds(...args),
    }
    await assert.rejects(runFreshnessFloor(['--execute'], runtime), /missing or malformed acknowledged LSN header/)
    assert.equal(redis.strings.get(floorKey), before)
    assert.ok(![...index.data.get('shared')!.keys()].some((id) => id.includes('vector-freshness-floor-sentinel')))
  }
  const raised = await runFreshnessFloor(['--execute'], floorRuntime())
  assert.ok(BigInt(store.parseVectorFreshnessFloor(raised)!.lsn) > BigInt(store.parseVectorFreshnessFloor(before)!.lsn))
  await store.raiseVectorFreshnessFloor('9007199254740999')
  assert.equal(await runFreshnessFloor(['--execute'], floorRuntime()), `${runA}:9007199254740999`)
  assert.equal(redis.ttls.has(floorKey), false)
})
await check('(floor-h) deleteScope removes durable scope state and registrations only after success', async () => {
  for (const kind of ['mem', 'sum', 'lore'] as const) {
    const scope = kind === 'lore' ? { kind, templateId: tid } : { kind, instanceId: iid }
    await store.vectorStore.deleteScope(scope)
    assert.equal(redis.data.has(keyFor(kind)), false)
    assert.equal(redis.flights.has(`${keyFor(kind)}:flight`), false)
    assert.equal((await store.readVectorWriteStates(iid, tid))[kind]?.absent, true)
    await store.vectorStore.deleteScope(scope) // Already empty still clears proof.
    assert.equal(redis.data.has(keyFor(kind)), false)
  }
})
await check('(restart-a) restored floor and missing post-snapshot state cannot authorize reuse', async () => {
  const p = start()!; await settle(p)
  identity = { runId: runB }
  await redis.del(keyFor('lore'), keyFor('mem'), keyFor('sum'))
  const result = await packet(p)
  assert.equal(result.prefetchOutcome, 'rerun:lore:no_floor,memory:no_floor,summary:no_floor')
  assert.deepEqual(index.calls.slice(-3).sort(), ['lore', 'mem', 'sum'])
  // The new process replaces even a much higher old-process floor, exactly.
  redis.strings.set(floorKey, `${runA}:9007199254740999`)
  assert.equal(await store.raiseVectorFreshnessFloor('1'), `${runB}:1`)
  assert.equal(await store.raiseVectorFreshnessFloor('9007199254740998'), `${runB}:9007199254740998`)
  assert.equal(await store.raiseVectorFreshnessFloor('2'), `${runB}:9007199254740998`)
  for (const bad of ['5', `${runB}:01`, `${runB}:1\n`, `${runB.toUpperCase()}:1`, `${runB}:`, `${runB}:1:2`]) {
    assert.equal(store.parseVectorFreshnessFloor(bad), undefined)
    redis.strings.set(floorKey, bad)
    assert.deepEqual((await rag.reusableVectorPrefetch(p, inputs)).responses, {})
  }
  // Old scalar and corrupt values carry no proof; a new sentinel can repair them.
  assert.equal(await runFreshnessFloor(['--execute'], floorRuntime()), `${runB}:${index.lsns.get('shared')}`)
})
await check('(restart-b) ready refreshes identity once; reconnect re-floors once and reuse resumes', async () => {
  const worker = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
  assert.match(worker, /await connectRedis\(\)[\s\S]*?const stopFloorRecovery = startVectorFreshnessFloorRecovery\(\)/)
  assert.doesNotMatch(worker, /await startVectorFreshnessFloorRecovery/)
  assert.match(worker, /stopFloorRecovery\(\)/)
  const connection = attachConnection()
  connection.emit('ready'); await eventually(() => !!currentProcess())
  assert.equal(currentProcess()?.runId, runA); assert.equal(connection.infos, 1)
  const stop = store.startVectorFreshnessFloorRecovery()
  try {
    await Bun.sleep(5)
    const before = index.writeCalls.length
    const p = start()!; await settle(p)
    connection.emit('close')
    assert.equal(currentProcess(), undefined)
    assert.deepEqual((await rag.reusableVectorPrefetch(p, inputs)).responses, {})
    const gate = index.writeGate = deferred<void>()
    connection.runId = runB; connection.emit('ready')
    await eventually(() => index.writeCalls.length === before + 1)
    for (const listener of readyListeners) { listener(); listener(); listener() }
    assert.equal(index.writeCalls.length, before + 1, 'only one sentinel can be in flight')
    assert.deepEqual((await rag.reusableVectorPrefetch(p, inputs)).responses, {})
    gate.resolve(); index.writeGate = undefined
    await eventually(() => store.parseVectorFreshnessFloor(redis.strings.get(floorKey))?.runId === runB)
    await Bun.sleep(5)
    assert.equal(index.writeCalls.length, before + 2, 'one upsert/delete sentinel per new process')
    assert.match((await rag.reusableVectorPrefetch(p, inputs)).outcome, /below_floor/)
    const fresh = start()!; await settle(fresh)
    const reads = redis.reads, infos = connection.infos
    assert.equal((await rag.reusableVectorPrefetch(fresh, inputs)).outcome, 'reused')
    assert.equal(redis.reads - reads, 4, 'validation stays one bounded parallel phase')
    assert.equal(connection.infos, infos, 'validation never fetches INFO')
    for (const listener of readyListeners) listener()
    await Bun.sleep(5); assert.equal(index.writeCalls.length, before + 2)
    // A reconnect while scope reads are pending loses proof even on the same run.
    redis.readHook = async () => { connection.emit('close'); connection.emit('ready') }
    assert.deepEqual((await rag.reusableVectorPrefetch(fresh, inputs)).responses, {})
    redis.readHook = undefined
  } finally { stop() }
})
await check('(restart-c) absent identity, dropped connections and late INFO never authorize reuse', async () => {
  const p = start()!; await settle(p)
  identity = undefined
  assert.deepEqual((await rag.reusableVectorPrefetch(p, inputs)).responses, {})
  await assert.rejects(store.raiseVectorFreshnessFloor('9'), /identity/)
  const before = index.writeCalls.length, stop = store.startVectorFreshnessFloorRecovery()
  await Bun.sleep(5); assert.equal(index.writeCalls.length, before); stop()
  const connection = attachConnection()
  const late = deferred<string>(); connection.infoGate = late.promise
  connection.emit('ready'); connection.emit('close')
  late.resolve(`run_id:${runA}\r\n`); await Bun.sleep(5)
  assert.equal(currentProcess(), undefined, 'old INFO must not restore a dropped connection')
  connection.infoGate = undefined
  for (const event of ['close', 'end', 'reconnecting']) {
    connection.emit('ready'); await eventually(() => !!currentProcess())
    connection.emit(event); assert.equal(currentProcess(), undefined, `${event} must clear cache`)
  }
  connection.infoGate = Promise.resolve('run_id:malformed\r\n')
  connection.emit('ready'); await Bun.sleep(5); assert.equal(currentProcess(), undefined)
  connection.infoGate = Promise.reject(new Error('injected INFO failure'))
  connection.emit('ready'); await Bun.sleep(5); assert.equal(currentProcess(), undefined)
})
await check('(restart-d) re-floor failures and reconnect during sentinel never block startup or turns', async () => {
  const warnings: string[] = [], warn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }
  let stop = () => {}
  try {
    for (const failure of ['read', 'sentinel'] as const) {
      identity = { runId: runB }
      const oldFloor = redis.strings.get(floorKey)
      redis.failFloorRead = failure === 'read'; index.throwWrite = failure === 'sentinel'
      const p = start()!; await settle(p)
      const at = Date.now(), count = warnings.length
      stop = store.startVectorFreshnessFloorRecovery()
      assert.equal(typeof stop, 'function', 'startup receives cleanup immediately')
      const turn = await packet(p)
      assert.ok(Date.now() - at < 1000, 'failed recovery cannot hold up a turn')
      assert.match(turn.prefetchOutcome!, /no_floor/)
      await eventually(() => warnings.length > count)
      assert.equal(redis.strings.get(floorKey), oldFloor)
      stop(); redis.failFloorRead = false; index.throwWrite = false
    }
    // A sentinel started on B cannot publish using C's identity after reconnect.
    identity = { runId: runB }
    const before = index.writeCalls.length, gate = index.writeGate = deferred<void>()
    stop = store.startVectorFreshnessFloorRecovery()
    await eventually(() => index.writeCalls.length === before + 1)
    identity = { runId: runC }
    for (const listener of readyListeners) listener()
    assert.equal(index.writeCalls.length, before + 1)
    gate.resolve(); index.writeGate = undefined
    await eventually(() => store.parseVectorFreshnessFloor(redis.strings.get(floorKey))?.runId === runC)
    assert.equal(index.writeCalls.length, before + 4, 'new process gets its own sentinel after the old attempt settles')
    const fresh = start()!; await settle(fresh)
    assert.equal((await rag.reusableVectorPrefetch(fresh, inputs)).outcome, 'reused')
    assert.ok(warnings.some((line) => line.includes('automatic re-floor failed')))
  } finally { stop(); console.warn = warn }
  assert.deepEqual(unhandled, [])
})
await check('(restart-e) off flag and nonshared layouts never auto-write at startup or ready', async () => {
  identity = { runId: runB }
  for (const [layout, flag] of [['shared', 'off'], ['namespaced', 'on'], ['dual', 'on']]) {
    env.VECTOR_LAYOUT = layout; env.OVERLAP_PREFETCH = flag
    const writes = index.writeCalls.length, reads = redis.reads
    const stop = store.startVectorFreshnessFloorRecovery()
    for (const listener of readyListeners) listener()
    await Bun.sleep(5)
    assert.equal(index.writeCalls.length, writes); assert.equal(redis.reads, reads)
    stop()
  }
})
await check('(restart-start) startup repairs missing and legacy scalar floors with a tracked sentinel', async () => {
  for (const old of [undefined, '5']) {
    if (old === undefined) redis.strings.delete(floorKey)
    else redis.strings.set(floorKey, old)
    const before = index.writeCalls.length, stop = store.startVectorFreshnessFloorRecovery()
    try {
      await eventually(() => !!store.parseVectorFreshnessFloor(redis.strings.get(floorKey)))
      assert.equal(index.writeCalls.length, before + 2)
      const fresh = start()!; await settle(fresh)
      assert.equal((await rag.reusableVectorPrefetch(fresh, inputs)).outcome, 'reused')
    } finally { stop() }
  }
})
console.log(`${passed} passed, ${failed} failed`)
if (failed) process.exit(1)

if (!mutant && !process.argv.includes('--checks-only')) {
  const scratch = mkdtempSync(join(tmpdir(), 'overlap-prefetch-'))
  const originals = { store: readFileSync(storeUrl, 'utf8'), rag: readFileSync(ragUrl, 'utf8'), packet: readFileSync(packetUrl, 'utf8'), transport: readFileSync(transportUrl, 'utf8'), floor: readFileSync(floorUrl, 'utf8'), redisConfig: readFileSync(redisConfigUrl, 'utf8') }
  const mutations = [
    ['(a) discard successful lore', 'rag', 'else responses[name] = settled[name]', "else if (name !== 'lore') responses[name] = settled[name]", '(a)'],
    ['(b2) ignore indexed LSN lag', 'rag', 'state.highestLsn !== undefined && BigInt(indexedLsn) < BigInt(state.highestLsn)', 'false', '(b2)'],
    ['(i) ignore in-flight write', 'rag', 'else if (state?.inFlight)', 'else if (false)', '(i)'],
    ['(unknown) reuse unknown write LSN', 'rag', "(!state.absent && state.highestLsn === undefined)", "false", '(unknown)'],
    ['(d) authorize reuse on Redis failure', 'store', 'catch { /* Every malformed, failed or timed-out read loses proof. */ }', "catch { states[scope.kind] = { inFlight: 0, absent: true } }", '(d)'],
    ['(d) default missing query LSN', 'rag', 'const state = states[kind], indexedLsn = settled[name]?.indexedLsn', "const state = states[kind], indexedLsn = settled[name]?.indexedLsn ?? '999999'", '(d)'],
    ['(e) skip input equality', 'rag', 'if (mismatch) return', 'if (false) return', '(e)'],
    ['(f) allow head-slot prefetch', 'rag', '!params.priorTurnId || ', '', '(f)'],
    ['(flag) ignore off flag', 'rag', "env.OVERLAP_PREFETCH !== 'on' || ", '', '(flag)'],
    ['(flag) packet ignores off flag', 'packet', "env.OVERLAP_PREFETCH === 'on' && ", '', '(flag)'],
    ['(g) supply failed memory as empty success', 'rag', 'catch { /* A speculative failure leaves this search to the packet. */ }', "catch { prefetch.responses[name] = { matches: [], namespace: '', indexedLsn: '99999' } }", '(g)'],
    ['(h) drop abandoned rejection handler', 'rag', '})().catch(() => {}).finally', '})().finally', '(h)'],
    ['(i) omit write registration', 'store', 'await boundedStateCall(getRedisClient().eval(BEGIN_WRITE, 2, key, `${key}:flight`, registration,\n    String(now), String(now + 3600_000)))', "Promise.resolve(['absent', '0'])", '(i)'],
    ['(redis-write) erase registrations after failed settlement', 'store', "console.warn('Vector write state settle failed')", "console.warn('Vector write state settle failed'); await getRedisClient().del(key, `${key}:flight`)", '(redis-write)'],
    ['(headers) shared transport header state crosses calls', 'transport', 'const headers: LsnHeaders = {}\n  const value', 'const headers: LsnHeaders = sharedHeaders\n  const value', '(headers)'],
    ['(headers) queries lose their own header', 'store', '{ indexedLsn }), matches:', "{ indexedLsn: '1' }), matches:", '(headers)'],
    ['(snapshot) include late query result', 'rag', 'const settled = { ...prefetch.responses }', 'const settled = prefetch.responses', '(snapshot)'],
    ['lore omit write registration', 'store', 'const key = stateKey(scope, namespace)\n  const registration', "if (scope.kind === 'lore') return call()\n  const key = stateKey(scope, namespace)\n  const registration", 'lore'],
    ['(floor-a) reject absent pre-floor history', 'store', "states[scope.kind] = { inFlight: 0, absent: true }", "states[scope.kind] = { inFlight: 0 }", '(a)'],
    ['(floor-g) accept nonshared floor', 'floor', "if (layout !== 'shared')", 'if (false)', '(floor-g)'],
    ['(floor-b) assume missing floor is zero', 'rag', 'floor === undefined', 'false', '(floor-b)'],
    ['(floor-c) ignore floor coverage', 'rag', 'indexedLsn !== undefined && BigInt(indexedLsn) < BigInt(floor)', 'false', '(floor-c)'],
    ['(floor-e) expire durable proof', 'store', 'redis.call("persist", KEYS[1])', 'redis.call("expire", KEYS[1], 3600)', '(floor-e)'],
    ['(floor-f) permit nonshared reuse', 'rag', "if (env.VECTOR_LAYOUT !== 'shared') return", 'if (false) return', '(floor-f)'],
    ['(floor-f) permit nonshared prefetch', 'rag', "env.VECTOR_LAYOUT !== 'shared' || ", '', '(floor-f)'],
    ['(floor-g) execute by default', 'floor', "if (!args.includes('--execute'))", 'if (false)', '(floor-g)'],
    ['(floor-g) ignore missing write header', 'store', 'if (pineconeTransport.parsePineconeLsn(upsertLsn) === undefined || pineconeTransport.parsePineconeLsn(deleteLsn) === undefined)', 'if (false)', '(floor-g)'],
    ['(floor-g) allow lowering floor', 'store', 'if not canonical or previousRun ~= run or #lsn > #previousLsn', 'if true or #lsn > #previousLsn', '(floor-g)'],
    ['(floor-h) retain deleted scope state', 'store', 'redis.call("del", KEYS[1], KEYS[2])', '-- cleanup omitted', '(floor-h)'],
    ['(restart-a) authorize an old-process floor', 'store', 'floor?.runId === process.runId ? floor.lsn', 'floor ? floor.lsn', '(restart-a)'],
    ['(restart-a) retain old-process maximum', 'store', 'previousRun ~= run or ', '', '(restart-a)'],
    ['(restart-a) accept noncanonical leading zeros', 'store', '/^([0-9a-f]{40}):(0|[1-9][0-9]*)$/', '/^([0-9a-f]{40}):([0-9]+)$/', '(restart-a)'],
    ['(restart-b) omit ready recovery', 'store', 'redisProcess.onRedisProcessReady(trigger)', '() => {}', '(restart-b)'],
    ['(restart-b) permit concurrent re-floor writes', 'store', 'if (active) { pending = true; return }', 'if (active) { pending = true }', '(restart-b)'],
    ['(restart-c) authorize reuse without cached identity', 'store', 'process && process === redisProcess.getRedisProcess() && floor?.runId === process.runId', 'floor !== undefined', '(restart-c)'],
    ['(restart-c) keep identity on disconnect', 'redisConfig', 'processes.delete(connection)', 'void connection', '(restart-c)'],
    ['(restart-c) accept late INFO after disconnect', 'redisConfig', 'if (current !== generation) return', '', '(restart-c)'],
    ['(restart-d) gate startup on pending recovery', 'store', 'trigger()\n  return () =>', "trigger()\n  if (active) throw new Error('re-floor blocks startup')\n  return () =>", '(restart-d)'],
    ['(restart-d) publish pre-reconnect sentinel under new identity', 'store', 'deleteLsn!, process)', 'deleteLsn!, redisProcess.getRedisProcess())', '(restart-d)'],
    ['(restart-d) hide re-floor failure', 'store', "console.warn('Vector freshness automatic re-floor failed')", 'void 0', '(restart-d)'],
    ['(restart-e) auto-write with flag off', 'store', "stopped || env.VECTOR_LAYOUT !== 'shared' || env.OVERLAP_PREFETCH !== 'on'", "stopped || env.VECTOR_LAYOUT !== 'shared'", '(restart-e)'],
    ['(restart-e) auto-write in nonshared layout', 'store', "stopped || env.VECTOR_LAYOUT !== 'shared' || env.OVERLAP_PREFETCH !== 'on'", "stopped || env.OVERLAP_PREFETCH !== 'on'", '(restart-e)'],
    ['(restart-start) omit startup recovery', 'store', 'trigger()\n  return () =>', 'return () =>', '(restart-start)'],
  ] as const
  try {
    for (const [label, target, before, after, expected] of mutations) {
      assert.ok(originals[target].includes(before), `mutation anchor missing: ${label}`)
      for (const name of ['store', 'rag', 'packet', 'transport', 'floor', 'redisConfig'] as const) {
        let source = name === target ? originals[name].replaceAll(before, after) : originals[name]
        const url = name === 'store' ? storeUrl : name === 'rag' ? ragUrl : name === 'packet' ? packetUrl : name === 'floor' ? floorUrl : name === 'redisConfig' ? redisConfigUrl : transportUrl
        if (target === 'transport' && name === 'transport') source = source.replace('const callHeaders =', 'const sharedHeaders: LsnHeaders = {}\nconst callHeaders =')
        if (name === 'redisConfig') source = source.replace("from 'ioredis'", `from '${import.meta.resolve('ioredis')}'`)
        if (name === 'transport') source = source.replace("from '@pinecone-database/pinecone'", `from '${import.meta.resolve('@pinecone-database/pinecone')}'`)
        source = source.replace(/from '(\.\.?\/[^']+)'/g, (_m, path: string) => {
          const resolved = new URL(path, url).pathname
          const redirect = resolved === `${root}/src/services/vector-store` ? join(scratch, 'store.ts') : resolved === `${root}/src/providers/rag.provider` ? join(scratch, 'rag.ts') : resolved
          return `from '${redirect}'`
        })
        writeFileSync(join(scratch, `${name}.ts`), source)
      }
      const child = Bun.spawn(['bun', '--no-env-file', 'run', import.meta.path, scratch], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
      const timer = setTimeout(() => child.kill(), 15000)
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      clearTimeout(timer)
      assert.notEqual(code, 0, `mutation survived: ${label}`)
      assert.ok(`${stdout}${stderr}`.includes(`FAIL ${expected}`), `wrong failure for ${label}: ${stdout}${stderr}`)
      console.log(`BITE ${label}: exit ${code}, FAIL ${expected}`)
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
