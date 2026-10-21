import { isDeepStrictEqual } from 'node:util'
import type { PineconeRecord } from '@pinecone-database/pinecone'
import { env } from '../src/config/env'
import { listLegacyScopes, deleteLegacyNamespace, scopeId, vectorStoreForLayout, type VectorScope, type VectorStore } from '../src/services/vector-store'

export function parseMigrationOptions(args: string[]) {
  for (const arg of args) if (!['--', '--apply', '--cleanup-old'].includes(arg)) throw new Error(`Unknown argument: ${arg}`)
  if (args.includes('--apply') && args.includes('--cleanup-old')) throw new Error('Copy and cleanup must be separate runs')
  return { apply: args.includes('--apply'), cleanupOld: args.includes('--cleanup-old') }
}

export async function readScope(store: VectorStore, scope: VectorScope): Promise<Map<string, PineconeRecord>> {
  const ids = await store.listIds(scope)
  const rows = new Map<string, PineconeRecord>()
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200)
    const { records } = await store.fetch(scope, batch)
    for (const id of batch) {
      if (!records[id]) throw new Error(`Listed vector missing on fetch: ${scope.kind}/${scopeId(scope)}/${id}; retry after consistency settles`)
      rows.set(id, records[id])
    }
  }
  return rows
}

function expectedShared(scope: VectorScope, record: PineconeRecord): PineconeRecord {
  return { ...record, metadata: { ...record.metadata, scope_kind: scope.kind, scope_id: scopeId(scope) } }
}

function verify(scope: VectorScope, old: Map<string, PineconeRecord>, shared: Map<string, PineconeRecord>): boolean {
  return old.size === shared.size && [...old].every(([id, r]) => isDeepStrictEqual(expectedShared(scope, r), shared.get(id)))
}

export async function runMigration(options: { apply: boolean; cleanupOld: boolean }, runtime = {
  old: vectorStoreForLayout('namespaced'), shared: vectorStoreForLayout('shared'),
  scopes: listLegacyScopes, layout: env.VECTOR_LAYOUT,
  cleanup: deleteLegacyNamespace, log: console.log,
  settle: () => Bun.sleep(1000), attempts: 10,
}) {
  if (options.cleanupOld && runtime.layout !== 'shared' && runtime.layout !== 'dual') throw new Error('--cleanup-old requires VECTOR_LAYOUT=shared or dual')
  const scopes = await runtime.scopes()
  if (!scopes.length) throw new Error('No legacy scopes found; refusing an empty verification')
  const results: Array<{ scope: string; old: number; shared: number; copied: number; verified: boolean }> = []
  for (const scope of scopes) {
    const old = await readScope(runtime.old, scope)
    let shared = await readScope(runtime.shared, scope)
    const missing: PineconeRecord[] = []
    for (const [id, record] of old) {
      if (!shared.has(id)) missing.push(record)
      else if (!isDeepStrictEqual(expectedShared(scope, record), shared.get(id))) {
        throw new Error(`Shared vector differs: ${scope.kind}/${scopeId(scope)}/${id}; refusing to overwrite it`)
      }
    }
    if (options.apply) {
      await runtime.shared.upsert(scope, missing)
      // Serverless reads are eventually consistent. Never turn a pending copy into a cleanup approval.
      for (let attempt = 0; attempt < runtime.attempts; attempt++) {
        shared = await readScope(runtime.shared, scope)
        if (verify(scope, old, shared)) break
        await runtime.settle()
      }
    }
    const row = { scope: `${scope.kind}/${scopeId(scope)}`, old: old.size, shared: shared.size,
      copied: options.apply ? missing.length : 0, verified: verify(scope, old, shared) }
    results.push(row)
    runtime.log(`${row.scope}: old=${row.old} shared=${row.shared} ${options.apply ? 'copied' : 'would-copy'}=${missing.length} ${row.verified ? 'VERIFIED' : 'PENDING/MISMATCH'}`)
  }
  const verified = results.every((r) => r.verified)
  if ((options.apply || options.cleanupOld) && !verified) throw new Error('Scope count/content verification failed; no old namespaces deleted')
  if (options.cleanupOld) {
    // Recheck EVERY scope before the first destructive call. Writers must remain quiesced.
    for (const scope of scopes) {
      if (!verify(scope, await readScope(runtime.old, scope), await readScope(runtime.shared, scope))) {
        throw new Error('Scope changed during verification; no old namespaces deleted')
      }
    }
    for (const scope of scopes) await runtime.cleanup(scope)
  }
  runtime.log(`${options.cleanupOld ? 'CLEANUP' : options.apply ? 'COPY' : 'DRY RUN'}: ${results.length} scopes; ${verified ? 'all verified' : 'copy/verification required'}`)
  return results
}

if (import.meta.main) {
  try { await runMigration(parseMigrationOptions(process.argv.slice(2))) }
  catch (err) { console.error((err as Error).message); process.exitCode = 1 }
}
