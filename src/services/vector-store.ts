import type { Index, PineconeRecord, QueryResponse, FetchResponse } from '@pinecone-database/pinecone'
import { getPineconeIndex } from '../config/pinecone'
import { env } from '../config/env'

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
  upsert(scope: VectorScope, records: PineconeRecord[]): Promise<void>
  query(scope: VectorScope, query: VectorQuery, onDuration?: (ms: number) => void): Promise<QueryResponse>
  fetch(scope: VectorScope, ids: string[]): Promise<FetchResponse>
  deleteIds(scope: VectorScope, ids: string[]): Promise<void>
  listIds(scope: VectorScope): Promise<string[]>
  deleteScope(scope: VectorScope): Promise<void>
  replaceLore(scope: Extract<VectorScope, { kind: 'lore' }>, records: PineconeRecord[]): Promise<void>
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
      async upsert(scope, records) { await sharedStore.upsert(scope, records); await oldStore.upsert(scope, records) },
      async deleteIds(scope, ids) { await sharedStore.deleteIds(scope, ids); await oldStore.deleteIds(scope, ids) },
      async deleteScope(scope) { await sharedStore.deleteScope(scope); await oldStore.deleteScope(scope) },
      async replaceLore(scope, records) { await sharedStore.replaceLore(scope, records); await oldStore.replaceLore(scope, records) },
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

  const store = {
    async upsert(scope: VectorScope, records: PineconeRecord[]): Promise<void> {
      const a = idsFor(scope, records.map((r) => r.id))
      if (!records.length) return
      const target = index().namespace(a.name)
      for (let i = 0; i < records.length; i += 100) {
        await target.upsert({ records: records.slice(i, i + 100).map((r) => ({
          ...r,
          id: shared ? a.prefix + r.id : r.id,
          ...(shared ? { metadata: { ...r.metadata, scope_kind: scope.kind, scope_id: a.id } } : {}),
        })) })
      }
    },
    async query(scope: VectorScope, query: VectorQuery, onDuration?: (ms: number) => void): Promise<QueryResponse> {
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
      const res = await target.query(request)
      onDuration?.(performance.now() - started)
      return { ...res, matches: res.matches.map((r) => ({ ...r, id: strip(a.prefix, r.id) })) }
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
    async deleteIds(scope: VectorScope, ids: string[]): Promise<void> {
      const a = idsFor(scope, ids)
      for (let i = 0; i < a.ids.length; i += 1000) {
        await index().namespace(a.name).deleteMany({ ids: a.ids.slice(i, i + 1000) })
      }
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
    async deleteScope(scope: VectorScope): Promise<void> {
      const a = address(scope)
      if (!shared) {
        await index().namespace(a.name).deleteAll()
        return
      }
      // Snapshot the full listing before deleting: mutation during pagination can skip ids.
      await store.deleteIds(scope, await store.listIds(scope))
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
    async replaceLore(scope: Extract<VectorScope, { kind: 'lore' }>, records: PineconeRecord[]): Promise<void> {
      if (scope?.kind !== 'lore') throw new Error('Lore scope required')
      const existing = await store.listIds(scope)
      await store.upsert(scope, records)
      const keep = new Set(records.map((r) => r.id))
      await store.deleteIds(scope, existing.filter((id) => !keep.has(id)))
    },
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
  await getPineconeIndex().deleteNamespace(`${scope.kind}_${id}`)
}
