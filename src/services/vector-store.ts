import type { Index, PineconeRecord, QueryResponse, FetchResponse } from '@pinecone-database/pinecone'
import { getPineconeIndex } from '../config/pinecone'
import * as pineconeTransport from '../config/pinecone'
import { env } from '../config/env'
import { getRedisClient } from '../config/redis'
import * as redisProcess from '../config/redis'
import { randomUUID } from 'node:crypto'

export type VectorWriteState = { inFlight: number; highestLsn?: string; absent?: true }
export type VectorWriteStates = Partial<Record<VectorScope['kind'], VectorWriteState>>
export type VectorQueryResponse = QueryResponse & { indexedLsn?: string }

async function boundedStateCall<T>(call: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([call, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Vector state deadline')), 250)
    })])
  } finally { if (timer) clearTimeout(timer) }
}
const namespaceFor = (scope: VectorScope, layout: VectorLayout, sharedNamespace: string) =>
  layout === 'namespaced' ? `${scope.kind}_${scopeId(scope)}` : sharedNamespace
const stateKey = (scope: VectorScope, namespace: string) => `vecf:v1:${namespace}:${scope.kind}:${scopeId(scope)}`

// Durable proof and expiring registrations have separate lifetimes. Each writer
// leases its own member, so busy scopes cannot keep a crashed writer alive.
const BEGIN_WRITE = `
if not redis.call("hget", KEYS[1], "epoch") then
  redis.call("hset", KEYS[1], "epoch", ARGV[1], "unknown", "1", "version", "0")
end
redis.call("persist", KEYS[1])
redis.call("zremrangebyscore", KEYS[2], "-inf", ARGV[2])
redis.call("zadd", KEYS[2], ARGV[3], ARGV[1])
redis.call("expire", KEYS[2], 3600)
return {redis.call("hget", KEYS[1], "epoch"), redis.call("hget", KEYS[1], "version")}`
const SETTLE_WRITE = `
local epoch = redis.call("hget", KEYS[1], "epoch")
local deadline = redis.call("zscore", KEYS[2], ARGV[5])
local same = epoch and epoch == ARGV[1] and deadline and tonumber(deadline) > tonumber(ARGV[6])
redis.call("zrem", KEYS[2], ARGV[5])
if not epoch then
  redis.call("hset", KEYS[1], "epoch", ARGV[4], "version", "0", "unknown", "1")
end
local previous = redis.call("hget", KEYS[1], "lsn")
local lsn = ARGV[3]
local newer = lsn ~= "" and (not previous or #lsn > #previous or (#lsn == #previous and lsn > previous))
if newer then redis.call("hset", KEYS[1], "lsn", lsn) end
if not same or lsn == "" then
  redis.call("hset", KEYS[1], "unknown", "1")
  redis.call("hincrby", KEYS[1], "version", 1)
elseif newer and redis.call("hget", KEYS[1], "version") == ARGV[2] then
  redis.call("hset", KEYS[1], "unknown", "0")
end
redis.call("persist", KEYS[1])
-- Only successful scope deletion without competing registrations forgets proof.
-- Deleted saves/templates cannot be used again by the packet lifecycle.
if ARGV[7] == "deleted" and same and redis.call("zcard", KEYS[2]) == 0 then
  redis.call("del", KEYS[1], KEYS[2])
end
return 1`
const READ_STATE = `
return {tostring(redis.call("exists", KEYS[1])),
  tostring(redis.call("zcount", KEYS[2], "(" .. ARGV[1], "+inf")),
  redis.call("hget", KEYS[1], "epoch") or "",
  redis.call("hget", KEYS[1], "unknown") or "",
  redis.call("hget", KEYS[1], "version") or "",
  redis.call("hget", KEYS[1], "lsn") or ""}`
const RAISE_FLOOR = `
local previous = redis.call("get", KEYS[1])
local lsn = ARGV[1]
local run = ARGV[2]
local previousRun, previousLsn
if previous then previousRun, previousLsn = string.match(previous, "^([0-9a-f]+):([0-9]+)$") end
local canonical = previousRun and #previousRun == 40 and (previousLsn == "0" or string.match(previousLsn, "^[1-9][0-9]*$"))
if not canonical or previousRun ~= run or #lsn > #previousLsn or (#lsn == #previousLsn and lsn > previousLsn) then
  redis.call("set", KEYS[1], run .. ":" .. lsn)
end
redis.call("persist", KEYS[1])
return redis.call("get", KEYS[1])`
export const vectorFreshnessFloorKey = (namespace: string) => `vecf:v1:${namespace}:floor`

export function parseVectorFreshnessFloor(value: unknown): { runId: string; lsn: string } | undefined {
  if (typeof value !== 'string') return
  const match = /^([0-9a-f]{40}):(0|[1-9][0-9]*)$/.exec(value)
  if (match) return { runId: match[1], lsn: match[2] }
}

export async function raiseVectorFreshnessFloor(lsn: string, process = redisProcess.getRedisProcess()): Promise<string> {
  if (env.VECTOR_LAYOUT !== 'shared') throw new Error('Freshness floor requires VECTOR_LAYOUT=shared')
  if (pineconeTransport.parsePineconeLsn(lsn) === undefined) throw new Error('Missing or malformed acknowledged LSN')
  if (!process || process !== redisProcess.getRedisProcess()) throw new Error('Redis process identity changed or unavailable')
  const floor = await boundedStateCall(getRedisClient().eval(RAISE_FLOOR, 1,
    vectorFreshnessFloorKey(env.PINECONE_SHARED_NAMESPACE), lsn, process.runId)) as string
  if (process !== redisProcess.getRedisProcess()) throw new Error('Redis process identity changed')
  return floor
}

export async function establishVectorFreshnessFloor(store: Pick<VectorStore, 'upsert' | 'deleteIds'> = vectorStore,
  raise: typeof raiseVectorFreshnessFloor = raiseVectorFreshnessFloor): Promise<string> {
  const process = redisProcess.getRedisProcess()
  if (!process) throw new Error('Redis process identity unavailable')
  // All writers must run tracked-write code BEFORE the flag is enabled (rollout
  // guarantee). The sentinel covers acknowledged writes whose state a restart lost.
  const id = randomUUID(), values = new Array<number>(1024).fill(0); values[0] = 1
  let upsertLsn: string | undefined, deleteLsn: string | undefined
  try { upsertLsn = await store.upsert(FRESHNESS_FLOOR_SCOPE, [{ id, values }]) }
  finally { deleteLsn = await store.deleteIds(FRESHNESS_FLOOR_SCOPE, [id]) }
  if (pineconeTransport.parsePineconeLsn(upsertLsn) === undefined || pineconeTransport.parsePineconeLsn(deleteLsn) === undefined) {
    throw new Error('REFUSED: missing or malformed acknowledged LSN header; floor unchanged')
  }
  return raise(BigInt(upsertLsn!) > BigInt(deleteLsn!) ? upsertLsn! : deleteLsn!, process)
}

export function startVectorFreshnessFloorRecovery(): () => void {
  let active = false, pending = false, stopped = false
  const trigger = () => {
    if (stopped || env.VECTOR_LAYOUT !== 'shared' || env.OVERLAP_PREFETCH !== 'on') return
    if (active) { pending = true; return }
    const process = redisProcess.getRedisProcess()
    if (!process) return
    active = true
    void (async () => {
      const floor = parseVectorFreshnessFloor(await boundedStateCall(getRedisClient().get(
        vectorFreshnessFloorKey(env.PINECONE_SHARED_NAMESPACE))))
      if (process !== redisProcess.getRedisProcess() || floor?.runId === process.runId) return
      await establishVectorFreshnessFloor()
    })().catch(() => { console.warn('Vector freshness automatic re-floor failed') }).finally(() => {
      active = false
      if (pending) { pending = false; trigger() }
    })
  }
  const unsubscribe = redisProcess.onRedisProcessReady(trigger)
  trigger()
  return () => { stopped = true; unsubscribe() }
}

export async function readVectorWriteStates(instanceId: string, templateId: string): Promise<VectorWriteStates> {
  const scopes: VectorScope[] = [{ kind: 'lore', templateId }, { kind: 'mem', instanceId }, { kind: 'sum', instanceId }]
  const states: VectorWriteStates = {}
  await Promise.all(scopes.map(async (scope) => {
    try {
      const key = stateKey(scope, namespaceFor(scope, env.VECTOR_LAYOUT, env.PINECONE_SHARED_NAMESPACE))
      const [exists, count, epoch, unknown, version, lsn] = await boundedStateCall(getRedisClient().eval(
        READ_STATE, 2, key, `${key}:flight`, String(Date.now()))) as string[]
      if (!/^(0|[1-9][0-9]*)$/.test(count) || !Number.isSafeInteger(Number(count))) return
      if (exists === '0' && count === '0') { states[scope.kind] = { inFlight: 0, absent: true }; return }
      if (exists !== '1' || !epoch || !/^(0|[1-9][0-9]*)$/.test(version) || !['0', '1'].includes(unknown) ||
          (lsn !== '' && pineconeTransport.parsePineconeLsn(lsn) === undefined)) return
      states[scope.kind] = { inFlight: Number(count),
        ...(unknown === '0' && lsn !== '' ? { highestLsn: lsn } : {}) }
    } catch { /* Every malformed, failed or timed-out read loses proof. */ }
  }))
  return states
}

export async function readVectorFreshness(instanceId: string, templateId: string) {
  const process = redisProcess.getRedisProcess()
  const [states, floor] = await Promise.all([
    readVectorWriteStates(instanceId, templateId),
    (async () => {
      try { return parseVectorFreshnessFloor(await boundedStateCall(
        getRedisClient().get(vectorFreshnessFloorKey(env.PINECONE_SHARED_NAMESPACE)))) }
      catch { return undefined }
    })(),
  ])
  // A reconnect during this parallel read phase invalidates every collected read.
  return { states, floor: process && process === redisProcess.getRedisProcess() && floor?.runId === process.runId ? floor.lsn : undefined }
}

async function trackedWrite(scope: VectorScope, namespace: string, call: () => Promise<string | undefined>, deleteState = false): Promise<string | undefined> {
  const key = stateKey(scope, namespace)
  const registration = randomUUID(), now = Date.now()
  let token: [string, string] | undefined
  try { token = await boundedStateCall(getRedisClient().eval(BEGIN_WRITE, 2, key, `${key}:flight`, registration,
    String(now), String(now + 3600_000))) as [string, string] }
  catch { console.warn('Vector write state begin failed') }
  let lsn: string | undefined, completed = false
  try { lsn = await call(); completed = true; return lsn }
  finally {
    try { await boundedStateCall(getRedisClient().eval(SETTLE_WRITE, 2, key, `${key}:flight`,
      token?.[0] ?? '', token?.[1] ?? '', lsn ?? '', randomUUID(), registration, String(Date.now()),
      deleteState && completed ? 'deleted' : '')) }
    catch {
      // Keep registrations on failure. A writer-only Redis outage remains the
      // accepted residual case; individual leases still recover after a crash.
      console.warn('Vector write state settle failed')
    }
  }
}

// Older audit fixtures inject only the SDK index. Such calls have no transport
// headers, and therefore can never provide freshness proof.
const captureLsn = <T>(call: () => Promise<T>): Promise<{ value: T; writeLsn?: string; indexedLsn?: string }> =>
  pineconeTransport.withPineconeLsn ? pineconeTransport.withPineconeLsn(call) : call().then((value) => ({ value }))
const maxLsn = (a: string, b: string) => BigInt(a) >= BigInt(b) ? a : b

export type VectorScope = { kind: 'lore'; templateId: string } | { kind: 'mem' | 'sum'; instanceId: string }
export type VectorLayout = 'namespaced' | 'shared' | 'dual'
export type VectorQuery = {
  vector: number[]
  topK: number
  filter?: object
  includeMetadata?: boolean
  includeValues?: boolean
}
export type VectorIndex = Pick<Index, 'namespace' | 'describeIndexStats'>
export type PineconePingMode = 'stats' | 'query'
export type VectorStore = {
  upsert(scope: VectorScope, records: PineconeRecord[]): Promise<string | undefined>
  query(scope: VectorScope, query: VectorQuery, onDuration?: (ms: number) => void): Promise<VectorQueryResponse>
  fetch(scope: VectorScope, ids: string[]): Promise<FetchResponse>
  deleteIds(scope: VectorScope, ids: string[]): Promise<string | undefined>
  listIds(scope: VectorScope): Promise<string[]>
  deleteScope(scope: VectorScope): Promise<string | undefined>
  replaceLore(scope: Extract<VectorScope, { kind: 'lore' }>, records: PineconeRecord[]): Promise<string | undefined>
  /**
   * A keep-warm ping: `width` requests at once, because each concurrent request
   * a turn makes needs its own connection. `stats` asks for the index stats,
   * which Pinecone does not bill in read units; `query` is a topK-1 search
   * scoped to a scope that cannot exist, so it returns nothing and costs
   * width × 0.25 read units.
   */
  ping(mode: PineconePingMode, width?: number): Promise<void>
}

/** A keep-warm ping where some of its requests failed. Carries the count so the
 *  pinger's single warn line can say how many did. */
export class WarmPingError extends Error {
  readonly failed: number
  readonly total: number

  constructor(failed: number, total: number, cause: unknown) {
    super(`keep-warm ping: ${failed} of ${total} requests failed: ${(cause as Error)?.message ?? String(cause)}`)
    this.name = 'WarmPingError'
    this.failed = failed
    this.total = total
  }
}

/** Reported to the keep-warm pinger on every call that reaches the index. A
 *  listener rather than a direct import: keep-warm pulls this module in lazily,
 *  so an import back from here would be a cycle. */
let indexUsed: (() => void) | null = null

export function setVectorIndexUseListener(listener: (() => void) | null): void {
  indexUsed = listener
}

/** Pinecone validates a query vector's dimension against the index's, which is
 *  the same 1024 `EMBEDDING_DIMENSIONS` in `src/ai/embedding.ts` uses. */
const PING_VECTOR = (() => {
  const vector = new Array<number>(1024).fill(0)
  vector[0] = 1
  return vector
})()

/** Real scope ids are ObjectId hex strings, so this scope can never be authored. */
const PING_SCOPE: VectorScope = { kind: 'mem', instanceId: 'keep-warm-ping' }
const FRESHNESS_FLOOR_SCOPE: VectorScope = { kind: 'mem', instanceId: 'vector-freshness-floor-sentinel' }

export function scopeId(scope: VectorScope): string {
  if (!scope || !['lore', 'mem', 'sum'].includes(scope.kind)) throw new Error('A complete vector scope is required')
  const id = scope.kind === 'lore' ? scope.templateId : scope.instanceId
  // A delimiter in the scope id would make two scopes share an id prefix.
  if (typeof id !== 'string' || !id.trim() || id.includes('#')) throw new Error('A complete vector scope is required')
  return id
}

export function scopeFromLegacyNamespace(name: string): VectorScope {
  const match = /^(lore|mem|sum)_(.+)$/.exec(name)
  if (!match) throw new Error(`Unrecognized vector namespace: ${name}`)
  const kind = match[1] as VectorScope['kind']
  const scope: VectorScope = kind === 'lore' ? { kind, templateId: match[2] } : { kind, instanceId: match[2] }
  scopeId(scope)
  return scope
}

export function createVectorStore(options: {
  layout: VectorLayout
  sharedNamespace: string
  getIndex: () => VectorIndex
}): VectorStore {
  if (!['namespaced', 'shared', 'dual'].includes(options.layout)) throw new Error('Invalid VECTOR_LAYOUT')
  if (!options.sharedNamespace.trim() || /^(lore|mem|sum)_/.test(options.sharedNamespace)) {
    throw new Error('Shared namespace must be nonempty and distinct from legacy namespaces')
  }
  if (options.layout === 'dual') {
    const sharedStore = createVectorStore({ ...options, layout: 'shared' })
    const oldStore = createVectorStore({ ...options, layout: 'namespaced' })
    // Finish the shared mutation before touching legacy data; either failure propagates.
    return {
      query: sharedStore.query, fetch: sharedStore.fetch, listIds: sharedStore.listIds,
      // The shared namespace is the one prod reads, so it is the one to keep warm;
      // the legacy side is drained and deleted by the migration.
      ping: sharedStore.ping,
      async upsert(scope, records) { const lsn = await sharedStore.upsert(scope, records); await oldStore.upsert(scope, records); return lsn },
      async deleteIds(scope, ids) { const lsn = await sharedStore.deleteIds(scope, ids); await oldStore.deleteIds(scope, ids); return lsn },
      async deleteScope(scope) { const lsn = await sharedStore.deleteScope(scope); await oldStore.deleteScope(scope); return lsn },
      async replaceLore(scope, records) { const lsn = await sharedStore.replaceLore(scope, records); await oldStore.replaceLore(scope, records); return lsn },
    }
  }
  const shared = options.layout === 'shared'
  const address = (scope: VectorScope) => {
    const id = scopeId(scope)
    return { id, prefix: `${scope.kind}#${id}#`, name: shared ? options.sharedNamespace : `${scope.kind}_${id}` }
  }
  const idsFor = (scope: VectorScope, ids: string[]) => {
    const a = address(scope)
    if (ids.some((id) => typeof id !== 'string' || !id)) throw new Error('Vector ids must be nonempty strings')
    return { ...a, ids: ids.map((id) => shared ? a.prefix + id : id) }
  }
  const strip = (prefix: string, id: string) => {
    if (!shared) return id
    if (!id.startsWith(prefix)) throw new Error('Vector response escaped its scope')
    return id.slice(prefix.length)
  }
  /** Every call that reaches Pinecone goes through here, so the keep-warm pinger
   *  sees exactly the calls that touched the index and nothing that was rejected
   *  or short-circuited first. */
  const index = () => {
    indexUsed?.()
    return options.getIndex()
  }

  const raw = {
    async upsert(scope: VectorScope, records: PineconeRecord[]): Promise<string | undefined> {
      const a = idsFor(scope, records.map((r) => r.id))
      if (!records.length) return
      let highest = '0', known = true
      const target = index().namespace(a.name)
      for (let i = 0; i < records.length; i += 100) {
        const result = await captureLsn(() => target.upsert({ records: records.slice(i, i + 100).map((r) => ({
          ...r,
          id: shared ? a.prefix + r.id : r.id,
          ...(shared ? { metadata: { ...r.metadata, scope_kind: scope.kind, scope_id: a.id } } : {}),
        })) }))
        if (result.writeLsn === undefined) known = false
        else highest = maxLsn(highest, result.writeLsn)
      }
      return known ? highest : undefined
    },
    async query(scope: VectorScope, query: VectorQuery, onDuration?: (ms: number) => void): Promise<VectorQueryResponse> {
      const a = address(scope)
      const scopedFilter = { scope_kind: { $eq: scope.kind }, scope_id: { $eq: a.id } }
      // Build the request explicitly so a runtime caller cannot override the namespace.
      const target = index().namespace(a.name)
      const request = {
        vector: query.vector, topK: query.topK,
        includeMetadata: query.includeMetadata, includeValues: query.includeValues,
        ...(shared ? { filter: query.filter ? { $and: [scopedFilter, query.filter] } : scopedFilter }
          : query.filter ? { filter: query.filter } : {}),
      }
      const started = performance.now()
      const { value: res, indexedLsn } = await captureLsn(() => target.query(request))
      onDuration?.(performance.now() - started)
      return { ...res, ...(indexedLsn === undefined ? {} : { indexedLsn }), matches: res.matches.map((r) => ({ ...r, id: strip(a.prefix, r.id) })) }
    },
    async fetch(scope: VectorScope, ids: string[]): Promise<FetchResponse> {
      const a = idsFor(scope, ids)
      const records: FetchResponse['records'] = {}
      for (let i = 0; i < a.ids.length; i += 200) {
        const res = await index().namespace(a.name).fetch({ ids: a.ids.slice(i, i + 200) })
        for (const r of Object.values(res.records)) {
          const id = strip(a.prefix, r.id)
          records[id] = { ...r, id }
        }
      }
      return { records, namespace: a.name }
    },
    async deleteIds(scope: VectorScope, ids: string[]): Promise<string | undefined> {
      const a = idsFor(scope, ids)
      if (!a.ids.length) return
      let highest = '0', known = true
      for (let i = 0; i < a.ids.length; i += 1000) {
        const result = await captureLsn(() => index().namespace(a.name).deleteMany({ ids: a.ids.slice(i, i + 1000) }))
        if (result.writeLsn === undefined) known = false
        else highest = maxLsn(highest, result.writeLsn)
      }
      return known ? highest : undefined
    },
    async listIds(scope: VectorScope): Promise<string[]> {
      const a = address(scope)
      const target = index().namespace(a.name)
      const ids: string[] = []
      let paginationToken: string | undefined
      do {
        const page = await target.listPaginated({ ...(shared ? { prefix: a.prefix } : {}), limit: 100, paginationToken })
        for (const r of page.vectors || []) {
          if (r.id) ids.push(strip(a.prefix, r.id))
        }
        paginationToken = page.pagination?.next
      } while (paginationToken)
      return ids
    },
    async deleteScope(scope: VectorScope): Promise<string | undefined> {
      const a = address(scope)
      if (!shared) return (await captureLsn(() => index().namespace(a.name).deleteAll())).writeLsn
      // Snapshot the full listing before deleting: mutation during pagination can skip ids.
      return raw.deleteIds(scope, await raw.listIds(scope))
    },
    async ping(mode: PineconePingMode, width: number = env.KEEP_WARM_PINECONE_WIDTH): Promise<void> {
      const count = Math.max(1, Math.floor(width))
      // Resolved once, so the pinger hears about this ping once however many
      // requests it sends.
      const target = index()
      // A search with everything off, scoped to a scope that cannot exist: it
      // cannot return a record, and at topK 1 each request bills 0.25 read units.
      const scope = mode === 'stats' ? null : address(PING_SCOPE)
      const namespaced = scope ? target.namespace(scope.name) : null
      const send = (): Promise<unknown> => {
        if (!scope || !namespaced) return target.describeIndexStats()
        return namespaced.query({
          vector: PING_VECTOR,
          topK: 1,
          includeMetadata: false,
          includeValues: false,
          ...(shared ? { filter: { scope_kind: { $eq: PING_SCOPE.kind }, scope_id: { $eq: scope.id } } } : {}),
        })
      }
      // Every request is started before any is awaited: this is a fan-out, and a
      // serial loop would leave the other connections cold, which is exactly what
      // the ping exists to prevent.
      const settled = await Promise.allSettled(Array.from({ length: count }, send))
      const failed = settled.filter((result) => result.status === 'rejected')
      // Settle them all before reporting: one failure must not leave the other
      // requests' outcome unknown, and the caller logs one line per ping.
      if (failed.length > 0) throw new WarmPingError(failed.length, count, (failed[0] as PromiseRejectedResult).reason)
    },
    async replaceLore(scope: Extract<VectorScope, { kind: 'lore' }>, records: PineconeRecord[]): Promise<string | undefined> {
      if (scope?.kind !== 'lore') throw new Error('Lore scope required')
      const existing = await raw.listIds(scope)
      const upsertLsn = await raw.upsert(scope, records)
      const keep = new Set(records.map((r) => r.id))
      const removed = existing.filter((id) => !keep.has(id))
      const deleteLsn = await raw.deleteIds(scope, removed)
      if ((records.length && upsertLsn === undefined) || (removed.length && deleteLsn === undefined)) return
      return upsertLsn === undefined ? deleteLsn : deleteLsn === undefined ? upsertLsn : maxLsn(upsertLsn, deleteLsn)
    },
  }
  const track = (scope: VectorScope, call: () => Promise<string | undefined>, deleteState = false) => trackedWrite(scope, address(scope).name, call, deleteState)
  const store: VectorStore = {
    ...raw,
    upsert: async (scope, records) => records.length ? track(scope, () => raw.upsert(scope, records)) : raw.upsert(scope, records),
    deleteIds: async (scope, ids) => ids.length ? track(scope, () => raw.deleteIds(scope, ids)) : raw.deleteIds(scope, ids),
    deleteScope: async (scope) => track(scope, () => raw.deleteScope(scope), true),
    replaceLore: async (scope, records) => track(scope, () => raw.replaceLore(scope, records)),
  }
  return store
}

export function vectorStoreForLayout(layout: VectorLayout): VectorStore {
  return createVectorStore({ layout, sharedNamespace: env.PINECONE_SHARED_NAMESPACE, getIndex: getPineconeIndex })
}

// Lazy initialization keeps imports network-free and lets audits inject an isolated index.
let defaultStore: VectorStore | undefined
export const vectorStore = new Proxy({} as VectorStore, {
  get: (_target, key: keyof VectorStore) => {
    defaultStore ??= vectorStoreForLayout(env.VECTOR_LAYOUT)
    return defaultStore[key]
  },
  set: (_target, key: keyof VectorStore, value: unknown) => {
    defaultStore ??= vectorStoreForLayout(env.VECTOR_LAYOUT)
    return Reflect.set(defaultStore, key, value)
  },
})

export async function listLegacyScopes(): Promise<VectorScope[]> {
  const stats = await getPineconeIndex().describeIndexStats()
  return Object.keys(stats.namespaces || {}).filter((name) => /^(lore|mem|sum)_/.test(name)).sort().map(scopeFromLegacyNamespace)
}

/** Destructive migration-only operation; the migration verifies every scope first. */
export async function deleteLegacyNamespace(scope: VectorScope): Promise<void> {
  const id = scopeId(scope)
  await trackedWrite(scope, `${scope.kind}_${id}`, async () =>
    (await captureLsn(() => getPineconeIndex().deleteNamespace(`${scope.kind}_${id}`))).writeLsn, true)
}
