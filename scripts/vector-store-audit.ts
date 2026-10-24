import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'
import type { PineconeRecord, QueryResponse, FetchResponse } from '@pinecone-database/pinecone'
import type { VectorScope, VectorStore, VectorIndex, VectorQuery } from '../src/services/vector-store'

const unavailable = (): never => { throw new Error('External dependency reached in vector audit') }
// No environment file, client, model endpoint, storage service or queue is used.
const env = { VECTOR_LAYOUT: 'shared', PINECONE_SHARED_NAMESPACE: 'everlore', RAG_RERANK_ENABLED: false }
mock.module('../src/config/env', () => ({ env }))
mock.module('../src/ai', () => ({ embed: async () => [1, 0], embedQuery: async () => [1, 0], isEmbedTimeout: () => false, callLLM: unavailable, AI_MODELS: {} }))

function matches(meta: Record<string, unknown>, filter?: object): boolean {
  if (!filter) return true
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$and') return (condition as object[]).every((part) => matches(meta, part))
    if (key === '$or') return (condition as object[]).some((part) => matches(meta, part))
    if (typeof condition === 'object' && condition && '$eq' in condition) return meta[key] === condition.$eq
    return meta[key] === condition
  })
}
class FakeIndex {
  data = new Map<string, Map<string, PineconeRecord>>()
  touches = 0
  writes = 0
  deletedNamespaces: string[] = []
  requests: Array<{ name: string; query: VectorQuery }> = []
  mutations: Array<{ name: string; method: string }> = []
  failMutation?: { name: string; method: string }
  sharedQueryDelayMs = 0
  mutate(name: string, method: string) {
    this.mutations.push({ name, method })
    if (this.failMutation?.name === name && this.failMutation.method === method) throw new Error(`Injected ${name}/${method} failure`)
  }
  namespace(name: string) {
    this.touches++
    const rows = () => this.data.get(name) || new Map<string, PineconeRecord>()
    const writable = () => {
      if (!this.data.has(name)) this.data.set(name, new Map())
      return this.data.get(name)!
    }
    return {
      upsert: async ({ records }: { records: PineconeRecord[] }) => {
        this.mutate(name, 'upsert')
        this.writes += records.length
        for (const record of records) writable().set(record.id, structuredClone(record))
      },
      query: async (query: VectorQuery): Promise<QueryResponse> => {
        this.requests.push({ name, query: structuredClone(query) })
        if (name === 'everlore' && this.sharedQueryDelayMs) await Bun.sleep(this.sharedQueryDelayMs)
        const norm = (v: number[]) => Math.sqrt(v.reduce((n, x) => n + x * x, 0))
        const found = [...rows().values()].filter((r) => matches(r.metadata || {}, query.filter))
          .map((r) => ({ id: r.id,
            score: (r.values || []).reduce((n, x, i) => n + x * query.vector[i], 0) / (norm(r.values || []) * norm(query.vector)),
            ...(query.includeMetadata ? { metadata: structuredClone(r.metadata) } : {}),
            ...(query.includeValues ? { values: [...(r.values || [])] } : { values: [] }),
          }))
          .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id)).slice(0, query.topK)
        return { matches: found, namespace: name }
      },
      fetch: async ({ ids }: { ids: string[] }): Promise<FetchResponse> => ({
        namespace: name, records: Object.fromEntries(ids.filter((id) => rows().has(id)).map((id) => [id, structuredClone(rows().get(id)!)])),
      }),
      deleteMany: async ({ ids }: { ids: string[] }) => { this.mutate(name, 'deleteMany'); this.writes++; for (const id of ids) writable().delete(id) },
      deleteAll: async () => { this.mutate(name, 'deleteAll'); this.writes++; this.data.delete(name) },
      listPaginated: async (options: { prefix?: string; paginationToken?: string }) => {
        const ids = [...rows().keys()].filter((id) => id.startsWith(options.prefix || '')).sort()
        const start = Number(options.paginationToken || 0), end = start + 2
        return { vectors: ids.slice(start, end).map((id) => ({ id })),
          pagination: end < ids.length ? { next: String(end) } : {} }
      },
    }
  }
  async describeIndexStats() { return { namespaces: Object.fromEntries([...this.data].map(([name, rows]) => [name, { recordCount: rows.size }])) } }
  async deleteNamespace(name: string) { this.deletedNamespaces.push(name); this.data.delete(name) }
  native(): VectorIndex {
    // The fake implements only the operations used here; SDK Index also has private transport fields.
    return this as unknown as VectorIndex
  }
}
let activeIndex = new FakeIndex()
mock.module('../src/config/pinecone', () => ({ getPineconeIndex: () => activeIndex.native() }))

const tid = '000000000000000000000010', aid = '000000000000000000000011', bid = '000000000000000000000012'
const creator = '000000000000000000000013'
let world = { _id: new ObjectId(tid), creator_id: new ObjectId(creator), global_lore: '', opening_line: '', base_stats_template: {}, flag_definitions: {} }
const instances = new Map([aid, bid].map((id) => [id, { _id: new ObjectId(id), player_id: new ObjectId(creator), template_id: world._id }]))
const emptyCursor = { sort: () => emptyCursor, limit: () => emptyCursor, project: () => emptyCursor, toArray: async () => [] }
const collections = new Proxy({}, { get: (_target, name) => () => ({
  find: () => name === 'worldInstances' ? { toArray: async () => [...instances.values()] } : emptyCursor,
  findOne: async (query: { _id?: ObjectId }) => name === 'worldTemplates' ? world
    : name === 'worldInstances' ? instances.get(String(query._id)) || null : null,
  updateOne: async () => ({ matchedCount: 1 }),
  deleteMany: async () => ({}),
  deleteOne: async (query: { _id?: ObjectId }) => { if (name === 'worldInstances') instances.delete(String(query._id)); return {} },
}) })
// The trace purge reaches its collections by name (`coll`), not through mongoColl.
mock.module('../src/config/mongo', () => ({ mongoColl: collections, coll: (name: string) => (collections as Record<string, () => unknown>)[name]() }))
mock.module('../src/utils/protagonist', () => ({ deriveProtagonist: unavailable }))
mock.module('../src/constants/default-cover', () => ({ isDefaultCoverUrl: () => true, resolveTemplateImageUrl: unavailable }))
mock.module('../src/services/storage.service', () => ({ storageService: {} }))
mock.module('../worker/lib/template-cast-extractor', () => ({ extractTemplateCast: unavailable }))
mock.module('../src/services/moderation.service', () => ({ moderationService: {} }))
mock.module('../src/config/redis', () => ({ getRedisClient: () => ({ del: async () => 0 }) }))
mock.module('../src/queues', () => ({ removeQueuedJobsForInstance: async () => 0 }))
mock.module('../src/services/character-codex.service', () => ({ characterCodexService: {} }))
mock.module('../src/services/kinship-graph.service', () => ({ kinshipGraphService: {} }))
mock.module('../src/services/opening-place.service', () => ({ extractOpeningPlace: unavailable }))
mock.module('../src/services/time.service', () => ({ timeService: { initialAnchor: async () => ({ timeline_id: 'main' }) } }))
mock.module('../src/services/media/deletion', () => ({ purgeCardPortraits: async () => {}, purgeMedia: async () => {}, purgeTemplatePortraits: async () => {} }))

const actual = await import('../src/services/vector-store')
const { runMigration, parseMigrationOptions } = await import('./vector-migrate')
const { compareRecall, saveRecallCase, sameHits, parseCompareOptions } = await import('./vector-recall-compare')
const { templateService } = await import('../src/services/template.service')
const { deletionService } = await import('../src/services/deletion.service')
const { queryRag, querySummaries } = await import('../src/providers/rag.provider')
type Factory = typeof actual.createVectorStore
const A: VectorScope = { kind: 'mem', instanceId: aid }, B: VectorScope = { kind: 'mem', instanceId: bid }
const L = { kind: 'lore' as const, templateId: tid }, S: VectorScope = { kind: 'sum', instanceId: aid }
const record = (id: string, values = [0.8, 0.6]): PineconeRecord => ({ id, values, metadata: { text: id, type: 'fact', importance: 3 } })
function stores(factory: Factory = actual.createVectorStore) {
  const index = new FakeIndex()
  const getIndex = () => index.native()
  return { index,
    old: factory({ layout: 'namespaced', sharedNamespace: 'everlore', getIndex }),
    shared: factory({ layout: 'shared', sharedNamespace: 'everlore', getIndex }),
    dual: factory({ layout: 'dual', sharedNamespace: 'everlore', getIndex }) }
}
const query: VectorQuery = { vector: [1, 0], topK: 1, includeMetadata: true }
let passes = 0
async function check(name: string, run: () => Promise<void> | void) {
  await run(); passes++; console.log(`PASS ${name}`)
}
async function sourceFiles(dir: string): Promise<Array<[string, string]>> {
  const files: Array<[string, string]> = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (entry.name.endsWith('.ts')) files.push([relative(resolve('.'), path), await readFile(path, 'utf8')])
  }
  return files
}
function ownership(files: Array<[string, string]>) {
  for (const [path, contents] of files) {
    if (path === 'src/services/vector-store.ts') continue
    const source = path === 'src/config/pinecone.ts' ? contents.replace('function getPineconeIndex()', 'function indexFactory()') : contents
    assert(!/getPineconeIndex|\.\s*namespace\s*\(/.test(source), `Unscoped index access: ${path}`)
  }
}
const source = await readFile('src/services/vector-store.ts', 'utf8')
async function mutant(before: string, after: string): Promise<Factory> {
  assert(source.includes(before), `Mutation target missing: ${before}`)
  const changed = source.replace(before, after)
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(changed)
    .replace(/^import .*$/gm, '').replace(/\bexport /g, '')
  // Evaluate only our own mutated source in memory; never rewrite working-tree files.
  return new Function('env', 'getPineconeIndex', `${js}\nreturn createVectorStore`)(env, () => activeIndex.native()) as Factory
}
async function bite(name: string, test: (factory: Factory) => Promise<void>, before: string, after: string) {
  const broken = await mutant(before, after)
  await assert.rejects(() => test(broken))
  await test(actual.createVectorStore)
  console.log(`BITE ${name}: broken implementation failed; original restored and passed`)
}

async function completeScope(factory: Factory) {
  const { index, shared } = stores(factory)
  for (const method of ['query', 'fetch', 'upsert', 'deleteIds', 'deleteScope', 'listIds', 'replaceLore'] as const) {
    // Invalid runtime inputs intentionally bypass the public TypeScript union.
    for (const scope of [undefined, {}, { kind: 'mem' }, { kind: 'lore', templateId: '' }, { kind: 'mem', instanceId: 'a#b' }]) {
      const fn = shared[method] as unknown as (scope: unknown, value?: unknown) => Promise<unknown>
      await assert.rejects(() => fn(scope, method === 'query' ? query : []))
    }
  }
  assert.equal(index.touches, 0)
}
async function isolation(factory: Factory) {
  const { shared } = stores(factory)
  await shared.upsert(A, [{ ...record('a'), metadata: { text: 'a', type: 'fact', scope_kind: 'sum', scope_id: bid } }])
  await shared.upsert(B, [record('b', [1, 0])])
  const stored = (await shared.fetch(A, ['a'])).records.a
  assert.equal(stored.metadata?.scope_id, aid); assert.equal(stored.metadata?.scope_kind, 'mem')
  assert.deepEqual((await shared.query(A, query)).matches.map((r) => r.id), ['a'])
  assert.deepEqual((await shared.query(B, query)).matches.map((r) => r.id), ['b'])
  assert.equal((await shared.query(A, { ...query, filter: { type: { $eq: 'other' } } })).matches.length, 0)
  assert.equal((await shared.query(A, { ...query, filter: { scope_id: { $eq: bid } } })).matches.length, 0)
}
async function deletion(factory: Factory) {
  const { shared } = stores(factory)
  const many = Array.from({ length: 7 }, (_, i) => record(`id${i}`))
  await shared.upsert(A, many); await shared.upsert(B, many); await shared.upsert(S, many)
  await shared.deleteScope(A)
  assert.deepEqual(await shared.listIds(A), [])
  assert.equal((await shared.listIds(B)).length, 7)
  assert.equal((await shared.listIds(S)).length, 7)
}
async function shortenedLore(factory: Factory) {
  const { old, shared } = stores(factory)
  for (const store of [old, shared]) {
    await store.replaceLore(L, Array.from({ length: 5 }, (_, i) => record(`lore_${tid}_${i}`)))
    await store.replaceLore(L, [record(`lore_${tid}_0`)])
    assert.deepEqual(await store.listIds(L), [`lore_${tid}_0`])
    await store.replaceLore(L, [])
    assert.deepEqual(await store.listIds(L), [])
  }
}
async function parity(factory: Factory) {
  const { old, shared } = stores(factory)
  for (const scope of [A, B, L, S]) {
    const records = [record('same'), record('two', [0.6, 0.8])]
    await old.upsert(scope, records); await shared.upsert(scope, records)
    const q = { ...query, topK: 5, includeValues: true }
    assert(sameHits((await old.query(scope, q)).matches, (await shared.query(scope, q)).matches))
    const fetched = await shared.fetch(scope, ['same'])
    assert.deepEqual(fetched.records.same.values, records[0].values)
    assert.equal(fetched.records.same.id, 'same')
    await shared.deleteIds(scope, ['same'])
    assert.deepEqual(await shared.listIds(scope), ['two'])
  }
}

async function dualWrites(factory: Factory) {
  const { index, old, shared, dual } = stores(factory)
  for (const scope of [A, B, L, S]) {
    await dual.upsert(scope, [record('new')])
    for (const store of [old, shared]) assert.deepEqual((await store.fetch(scope, ['new'])).records.new.values, record('new').values)
  }
  assert.deepEqual(index.mutations.map((m) => m.name), [
    'everlore', `mem_${aid}`, 'everlore', `mem_${bid}`, 'everlore', `lore_${tid}`, 'everlore', `sum_${aid}`,
  ])
  index.mutations = []
  await dual.replaceLore(L, [record('replacement')])
  for (const store of [old, shared]) assert.deepEqual(await store.listIds(L), ['replacement'])
  assert.deepEqual(index.mutations.map((m) => m.name), ['everlore', 'everlore', `lore_${tid}`, `lore_${tid}`])
}
async function dualDeletes(factory: Factory) {
  const { old, shared, dual } = stores(factory)
  for (const store of [old, shared]) {
    for (const scope of [A, B, L, S]) await store.upsert(scope, Array.from({ length: 7 }, (_, i) => record(`id${i}`)))
  }
  await dual.deleteIds(A, ['id0'])
  for (const store of [old, shared]) assert.equal((await store.fetch(A, ['id0'])).records.id0, undefined)
  await dual.deleteScope(A)
  await dual.deleteScope(S)
  await dual.replaceLore(L, [record('id0')])
  for (const store of [old, shared]) {
    assert.deepEqual(await store.listIds(A), []); assert.deepEqual(await store.listIds(S), [])
    assert.equal((await store.listIds(B)).length, 7)
    assert.deepEqual(await store.listIds(L), ['id0'])
  }
  await dual.replaceLore(L, [])
  for (const store of [old, shared]) assert.deepEqual(await store.listIds(L), [])
}
async function dualReads(factory: Factory) {
  const { old, shared, dual } = stores(factory)
  for (const scope of [A, L, S]) {
    await old.upsert(scope, [record('old-only', [1, 0])])
    await shared.upsert(scope, [record('shared-only')])
    assert.deepEqual((await dual.query(scope, query)).matches.map((r) => r.id), ['shared-only'])
    assert.deepEqual(Object.keys((await dual.fetch(scope, ['old-only', 'shared-only'])).records), ['shared-only'])
    assert.deepEqual(await dual.listIds(scope), ['shared-only'])
  }
}
async function dualCleanup(factory: Factory, migrate = runMigration) {
  const { index, old, shared, dual } = stores(factory)
  const scopes = [A, B, L, S]
  for (const scope of scopes) await dual.upsert(scope, [record('keep'), record('delete')])
  await dual.deleteIds(A, ['delete']); await dual.deleteScope(S)
  await dual.replaceLore(L, [record('new-lore')])
  const runtime = { old, shared, scopes: async () => scopes, layout: 'dual' as const,
    cleanup: async (scope: VectorScope) => index.deleteNamespace(`${scope.kind}_${actual.scopeId(scope)}`),
    log: () => {}, settle: async () => {}, attempts: 1 }
  // Verification must reject tampering on EITHER side before deleting ANY namespace.
  for (const store of [old, shared]) {
    await store.upsert(B, [record('keep', [-1, 0])])
    await assert.rejects(() => migrate({ apply: false, cleanupOld: true }, runtime), /differs|verification failed/)
    assert.deepEqual(index.deletedNamespaces, [])
    await store.upsert(B, [record('keep')])
  }
  const rows = await migrate({ apply: false, cleanupOld: true }, runtime)
  assert(rows.every((r) => r.verified)); assert.equal(index.deletedNamespaces.length, 4)
  assert.deepEqual(await shared.listIds(A), ['keep'])
  assert.deepEqual(await shared.listIds(L), ['new-lore'])
}

try {
  const files = [...await sourceFiles('src'), ...await sourceFiles('worker')]
  await check('a. single index owner in src/ and worker/', () => ownership(files))
  assert.throws(() => ownership([...files, ['worker/escaped.ts', 'getPineconeIndex().namespace("unscoped")']]))
  console.log('BITE ownership: injected unscoped worker rejected; original source passed')
  await check('b. incomplete scopes rejected before network', () => completeScope(actual.createVectorStore))
  await bite('scope validation', completeScope,
    "if (typeof id !== 'string' || !id.trim() || id.includes('#')) throw new Error('A complete vector scope is required')", '')
  await check('c. scope filter isolation, including closer foreign vector and AND filter', () => isolation(actual.createVectorStore))
  await bite('scope filter', isolation, 'scope_id: { $eq: a.id }', 'scope_id: { $eq: bid }'.replace('bid', JSON.stringify(bid)))
  await check('d. paginated deleteScope leaves other save and kind intact', () => deletion(actual.createVectorStore))
  await bite('delete prefix', deletion, 'prefix: a.prefix', "prefix: 'mem#'")
  await check('e. shortened and empty lore leave no stale passages in both layouts', () => shortenedLore(actual.createVectorStore))
  await bite('lore cleanup', shortenedLore, 'existing.filter((id) => !keep.has(id))', '[]')
  await check('f. layouts preserve ranking, scores, values and original fetch/delete ids', () => parity(actual.createVectorStore))
  await bite('id stripping', parity, 'return id.slice(prefix.length)', 'return id')
  await check('g. dual writes and lore replacement land in both layouts, shared first', () => dualWrites(actual.createVectorStore))
  await bite('dual upsert mirror', dualWrites, 'await oldStore.upsert(scope, records)', '')
  await bite('dual lore mirror', dualWrites, 'await oldStore.replaceLore(scope, records)', '')
  await check('h. dual id/scope deletion and shortened/empty lore remove from both layouts', () => dualDeletes(actual.createVectorStore))
  await bite('dual id deletion', dualDeletes, 'await oldStore.deleteIds(scope, ids)', '')
  await bite('dual scope deletion', dualDeletes, 'await oldStore.deleteScope(scope)', '')
  await check('i. dual query/fetch/list ignore vectors existing only in old', () => dualReads(actual.createVectorStore))
  for (const method of ['query', 'fetch', 'listIds']) {
    await bite(`dual ${method} reads`, dualReads, `${method}: sharedStore.${method}`, `${method}: oldStore.${method}`)
  }
  await check('j. dual mutations pass strict cleanup equality; either-side tampering blocks all cleanup', () => dualCleanup(actual.createVectorStore))
  await bite('dual cleanup equality', dualCleanup, 'await oldStore.deleteIds(scope, ids)', '')
  const migrationSource = (await readFile('scripts/vector-migrate.ts', 'utf8')).replace(/\nif \(import.meta.main\)[\s\S]*$/, '')
  const migrationJs = new Bun.Transpiler({ loader: 'ts' }).transformSync(migrationSource)
    .replace(/^import .*$/gm, '').replace(/\bexport /g, '')
  // Disable only content equality in an in-memory migration copy; the audit must reject it.
  const brokenMigration = new Function('isDeepStrictEqual', 'scopeId', `${migrationJs}\nreturn runMigration`)(
    () => true, actual.scopeId) as typeof runMigration
  await assert.rejects(() => dualCleanup(actual.createVectorStore, brokenMigration))
  await dualCleanup(actual.createVectorStore)
  console.log('BITE cleanup content equality: disabled comparison failed the tamper assertion; original restored and passed')
  await check('dual mutations surface shared and legacy failures in shared-first order', async () => {
    for (const method of ['upsert', 'deleteIds', 'deleteScope', 'replaceLore'] as const) {
      for (const failShared of [true, false]) {
        const { index, dual } = stores()
        const scope: VectorScope = method === 'replaceLore' ? L : A
        await dual.upsert(scope, [record('existing')])
        const oldName: string = `${scope.kind}_${actual.scopeId(scope)}`
        const sdkMethod = method === 'upsert' || method === 'replaceLore' ? 'upsert'
          : method === 'deleteScope' && !failShared ? 'deleteAll' : 'deleteMany'
        index.mutations = []; index.failMutation = { name: failShared ? 'everlore' : oldName, method: sdkMethod }
        await assert.rejects(() => method === 'replaceLore' ? dual.replaceLore(L, [record('new')])
          : method === 'upsert' ? dual.upsert(A, [record('new')])
          : method === 'deleteIds' ? dual.deleteIds(A, ['existing']) : dual.deleteScope(A), /Injected/)
        assert.equal(index.mutations[0].name, 'everlore')
        if (failShared) assert(index.mutations.every((m) => m.name === 'everlore'))
        else assert.equal(index.mutations.at(-1)?.name, oldName)
      }
    }
  })

  await check('real publish path shrinks lore and handles empty lore', async () => {
    activeIndex = new FakeIndex()
    world.global_lore = Array.from({ length: 5 }, () => `${'a'.repeat(450)}.`).join(' ')
    await templateService.publish(tid, creator)
    assert.equal((await actual.vectorStore.listIds(L)).length, 5)
    world.global_lore = 'A short passage.'
    await templateService.publish(tid, creator)
    assert.equal((await actual.vectorStore.listIds(L)).length, 1)
    world.global_lore = ''
    await templateService.publish(tid, creator)
    assert.equal((await actual.vectorStore.listIds(L)).length, 0)
  })
  await check('real RAG requests retain topK and original ids for summary Mongo checks', async () => {
    await actual.vectorStore.upsert(L, [record('lore')])
    await actual.vectorStore.upsert(A, [record('memory')])
    const rag = await queryRag(tid, aid, 'question', 10, 25)
    assert.deepEqual(rag.loreTexts, ['lore']); assert.deepEqual(rag.memoryTexts, ['memory'])
    assert.equal(activeIndex.requests.at(-2)?.query.topK, 10)
    assert.equal(activeIndex.requests.at(-1)?.query.topK, 25)
    await queryRag(tid, aid, 'question', 10, 25, [], 'main')
    assert.equal(activeIndex.requests.at(-1)?.query.topK, 50)
    await querySummaries(aid, 'question', 3)
    assert.equal(activeIndex.requests.at(-1)?.query.topK, 6)
  })
  await check('real reset/save/world deletion entry points purge mem and sum; world also purges lore', async () => {
    activeIndex = new FakeIndex()
    const fill = async () => { for (const scope of [A, B, S, L]) await actual.vectorStore.upsert(scope, [record('same')]) }
    await fill(); await deletionService.resetInstance(aid, creator)
    assert.deepEqual(await actual.vectorStore.listIds(A), []); assert.deepEqual(await actual.vectorStore.listIds(S), [])
    assert.equal((await actual.vectorStore.listIds(B)).length, 1); assert.equal((await actual.vectorStore.listIds(L)).length, 1)
    await fill(); await deletionService.deleteInstance(aid, creator)
    assert.deepEqual(await actual.vectorStore.listIds(A), []); assert.deepEqual(await actual.vectorStore.listIds(S), [])
    instances.set(aid, { _id: new ObjectId(aid), player_id: new ObjectId(creator), template_id: world._id })
    await fill(); await deletionService.deleteTemplate(tid, creator)
    for (const scope of [A, B, S, L]) assert.deepEqual(await actual.vectorStore.listIds(scope), [])
  })
  await check('migration dry/apply/idempotence, comparison PASS and tampered-vector FAIL, cleanup guards', async () => {
    const { index, old, shared } = stores()
    const scopes = [A, B, L, S]
    for (const scope of scopes) await old.upsert(scope, [record('same'), record('two', [0.2, 0.98]), record('three', [-1, 0])])
    const runtime = { old, shared, scopes: async () => scopes, layout: 'namespaced' as const,
      cleanup: async (scope: VectorScope) => index.deleteNamespace(`${scope.kind}_${actual.scopeId(scope)}`),
      log: console.log, settle: async () => {}, attempts: 1 }
    const before = index.writes
    await runMigration({ apply: false, cleanupOld: false }, runtime)
    assert.equal(index.writes, before); assert.equal((await shared.listIds(A)).length, 0)
    await runMigration({ apply: true, cleanupOld: false }, runtime)
    const copied = index.writes
    const rerun = await runMigration({ apply: true, cleanupOld: false }, runtime)
    assert.equal(index.writes, copied); assert(rerun.every((r) => r.copied === 0 && r.verified))
    const cases = [saveRecallCase({ instanceId: aid, templateId: tid, texts: ['real fixture query'], loreTopK: 10, memoryTopK: 25, timelineId: 'main' })]
    const compareRuntime = { old, shared, embed: async () => [1, 0], log: console.log }
    const writes = index.writes
    assert(await compareRecall(cases, compareRuntime)); assert.equal(index.writes, writes)
    await shared.upsert(A, [record('same', [-1, 0])])
    assert.equal(await compareRecall(cases, compareRuntime), false)
    console.log('BITE recall gate: one tampered vector produced FAIL')
    await assert.rejects(() => runMigration({ apply: true, cleanupOld: false }, runtime), /refusing to overwrite/)
    await assert.rejects(() => runMigration({ apply: false, cleanupOld: true }, runtime), /VECTOR_LAYOUT=shared/)
    await assert.rejects(() => runMigration({ apply: false, cleanupOld: true }, { ...runtime, layout: 'shared' }), /Shared vector differs/)
    assert.deepEqual(index.deletedNamespaces, [])
    await shared.upsert(A, [(await old.fetch(A, ['same'])).records.same])
    assert(await compareRecall(cases, compareRuntime))
    await runMigration({ apply: false, cleanupOld: true }, { ...runtime, layout: 'shared' })
    assert.equal(index.deletedNamespaces.length, 4)
    assert.equal((await shared.listIds(A)).length, 3)
  })
  await check('migration default wiring discovers every legacy namespace and deletes only verified legacy namespaces', async () => {
    activeIndex = new FakeIndex()
    const old = actual.vectorStoreForLayout('namespaced')
    for (const scope of [A, B, L, S]) await old.upsert(scope, [record('same')])
    assert.equal((await actual.listLegacyScopes()).length, 4)
    await runMigration({ apply: true, cleanupOld: false })
    for (const scope of [A, B, L, S]) assert.equal((await old.listIds(scope)).length, 1)
    await runMigration({ apply: false, cleanupOld: true })
    assert.equal(activeIndex.deletedNamespaces.length, 4)
    assert.equal((await actual.vectorStore.listIds(A)).length, 1)
    console.log('Fake run paid embedding spend: 0 tokens; $0 / ₹0')
  })
  await check('SDK timing warm-ups, alternating order, p50/p95 gates and threshold overrides', async () => {
    const { index, old, shared } = stores()
    for (const scope of [A, L, S]) {
      await old.upsert(scope, [record('same')]); await shared.upsert(scope, [record('same')])
    }
    const cases = [saveRecallCase({ instanceId: aid, templateId: tid, texts: ['timing fixture'], loreTopK: 10, memoryTopK: 25, timelineId: 'main' })]
    const runtime = { old, shared, embed: async () => [1, 0], log: console.log }
    assert(await compareRecall(cases, runtime))
    assert.equal(index.requests.length, 36) // 15 measured pairs plus one warm-up pair per kind.
    for (let pair = 0; pair < 18; pair++) {
      const names = index.requests.slice(pair * 2, pair * 2 + 2).map((r) => r.name === 'everlore' ? 'shared' : 'old')
      assert.deepEqual(names, pair % 2 ? ['shared', 'old'] : ['old', 'shared'])
    }
    index.sharedQueryDelayMs = 45
    assert.equal(await compareRecall(cases, { ...runtime, maxP95Ms: 1000 }), false)
    console.log('BITE speed p50: shared fake +45 ms produced FAIL with identical results; p95 gate relaxed')
    index.sharedQueryDelayMs = 85
    assert.equal(await compareRecall(cases, { ...runtime, maxP50Ms: 1000 }), false)
    console.log('BITE speed p95: shared fake +85 ms produced FAIL with identical results; p50 gate relaxed')
    assert(await compareRecall(cases, { ...runtime, maxP50Ms: 1000, maxP95Ms: 1000 }))
    index.sharedQueryDelayMs = 0
    assert(await compareRecall(cases, runtime))
    console.log('RESTORED speed: delay removed; default thresholds PASS')
  })
  await check('comparison honors exact-score ties and rejects score/order/id drift; CLI validation', () => {
    const a = [{ ...record('a'), score: 1 }, { ...record('b'), score: 1 }]
    assert(sameHits(a, [...a].reverse()))
    assert(!sameHits(a, [a[0], { ...a[1], score: 0.99 }]))
    assert(!sameHits(a, [a[0], { ...a[1], id: 'foreign' }]))
    assert(!sameHits([{ ...a[0], score: 0.9 }, a[1]], [a[1], { ...a[0], score: 0.9 }]))
    assert.throws(() => parseMigrationOptions(['--unknown']))
    assert.throws(() => parseMigrationOptions(['--apply', '--cleanup-old']))
    assert.throws(() => parseCompareOptions(['--queries', '0']))
    assert.equal(parseCompareOptions([]).queries, 5)
    assert.equal(parseCompareOptions([]).limit, Infinity)
    assert.equal(parseCompareOptions([]).maxP50Ms, 30)
    assert.equal(parseCompareOptions([]).maxP95Ms, 60)
    assert.equal(parseCompareOptions(['--max-p50-ms', '0', '--max-p95-ms', '60.5']).maxP95Ms, 60.5)
    for (const value of ['-1', 'NaN', 'Infinity', '']) assert.throws(() => parseCompareOptions(['--max-p50-ms', value]))
    assert.throws(() => parseCompareOptions(['--max-p95-ms']))
  })
  console.log(`VECTOR STORE AUDIT PASS: ${passes} checks; a–j ownership/storage bites plus recall and p50/p95 speed bites; no external services`)
} catch (err) { console.error('VECTOR STORE AUDIT FAIL', err); process.exitCode = 1 }
