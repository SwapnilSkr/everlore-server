/**
 * Pure audit: archiving a memory never writes an explicit `pinecone_id: null`.
 *
 * `idx_memories_pinecone_id` is unique + sparse. Sparse skips a document that
 * LACKS the key, but indexes an explicit null like any value, so only one
 * memory may ever hold it. The maintenance job's `importance_decay` and
 * `dedup_memories` used to `$set` the key to null when they dropped a vector:
 * the second archive failed the whole job with E11000 (prod, Oct 24 2026).
 *
 * Runs the real `maintenanceProcessor` against an in-memory `memories`
 * collection that enforces the index the way Mongo does, then runs the same
 * file with each writer reverted to the old null write and requires that each
 * mutant FAILS, so the audit proves it still bites every time it runs. Also
 * scans src/ and worker/ for any literal `pinecone_id: null` write.
 */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ObjectId } from 'mongodb'

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const forbidden = (): never => { throw new Error('Not reachable in the pure memory-archive audit') }

type Doc = Record<string, any>
let docs: Doc[] = []

class DuplicateKeyError extends Error {}

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    const value = doc[key]
    if (cond && typeof cond === 'object' && !(cond instanceof ObjectId) && !(cond instanceof Date)) {
      if ('$lt' in cond) return value !== undefined && value < cond.$lt
      throw new Error(`Unsupported filter on ${key}`)
    }
    return String(value) === String(cond)
  })
}

// Mongo's unique + sparse semantics: a document without the key is skipped,
// an explicit null is indexed and collides with the next one.
function assertIndex(candidate: Doc[]) {
  const seen = new Set<string>()
  for (const doc of candidate) {
    if (!Object.hasOwn(doc, 'pinecone_id')) continue
    const key = JSON.stringify(doc.pinecone_id)
    if (seen.has(key)) {
      throw new DuplicateKeyError(`E11000 duplicate key error collection: everlore.memories index: idx_memories_pinecone_id dup key: { pinecone_id: ${key} }`)
    }
    seen.add(key)
  }
}

const memoriesColl = {
  find: (filter: Doc) => ({ toArray: async () => docs.filter((d) => matches(d, filter)).map((d) => ({ ...d })) }),
  updateOne: async (filter: Doc, update: Doc) => {
    if (Object.keys(update).some((op) => op !== '$set' && op !== '$unset')) throw new Error('Unsupported update operator')
    const next = docs.map((doc) => {
      if (!matches(doc, filter)) return doc
      const copy = { ...doc, ...(update.$set ?? {}) }
      for (const key of Object.keys(update.$unset ?? {})) delete copy[key]
      return copy
    })
    assertIndex(next)
    docs = next
    return { matchedCount: 1, modifiedCount: 1 }
  },
}

mock.module('../src/config/env', () => ({ env: {} }))
mock.module('../src/config/mongo', () => ({ mongoColl: { memories: () => memoriesColl, events: forbidden, worldInstances: forbidden } }))
mock.module('../src/services/media/service', () => ({ repairMediaReservations: forbidden }))
mock.module('../src/services/vector-store', () => ({
  vectorStore: {
    deleteIds: async () => {},
    // Every stored vector is the same, so every pair in the dedup fixture is a
    // near-duplicate.
    fetch: async (_scope: unknown, ids: string[]) => ({ records: Object.fromEntries(ids.map((id) => [id, { values: [1, 0, 0] }])) }),
  },
}))
mock.module('../src/ai', () => ({ embedBatch: forbidden }))
mock.module('../src/queues', () => ({ getMaintenanceQueue: forbidden, QUEUE_RETENTION: { maintenance: {} } }))
mock.module('../src/services/queue-hygiene.service', () => ({ MANAGED_QUEUES: [], pruneExpiredCompletedQueueJobs: forbidden }))
mock.module('../src/utils/logger', () => ({ log: { info() {}, warn() {}, error() {} } }))
mock.module('../src/services/post-process-outbox.service', () => ({ dispatchPostProcessOutbox: forbidden }))
mock.module('../src/services/web-traffic-rollup.service', () => ({ webTrafficRollupService: {} }))
mock.module('../worker/processors/character-projection.processor', () => ({ characterProjectionProcessor: forbidden }))
mock.module('../worker/lib/character-projection-lease', () => ({ CHARACTER_PROJECTION_CLAIM_LEASE_MS: 60_000 }))

const instanceId = new ObjectId()
const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
function memory(n: number, extra: Doc = {}): Doc {
  return {
    _id: new ObjectId(), instance_id: instanceId, player_id: new ObjectId(), text: `memory ${n}`, type: 'event',
    importance: 2, source_event_ids: [new ObjectId()], pinecone_id: `vec-${n}`, last_accessed_at: longAgo,
    is_archived: false, status: 'active', subjects: [], objects: [], ...extra,
  }
}

type Processor = (job: any) => Promise<any>

async function runCase(processor: Processor, task: 'importance_decay' | 'dedup_memories') {
  docs = [memory(1), memory(2), memory(3), memory(4, { importance: 5, last_accessed_at: new Date() })]
  const result = await processor({ data: { task, instanceId: String(instanceId) } })
  const explicitNull = docs.filter((d) => Object.hasOwn(d, 'pinecone_id') && d.pinecone_id === null)
  assert.equal(explicitNull.length, 0, `${task}: ${explicitNull.length} memory/memories left with an explicit pinecone_id: null`)
  const archived = docs.filter((d) => d.is_archived)
  assert.equal(archived.length, 3, `${task}: expected 3 archived memories, got ${archived.length}`)
  for (const d of archived) assert.ok(!Object.hasOwn(d, 'pinecone_id'), `${task}: an archived memory kept a pinecone_id key`)
  assert.equal(docs.filter((d) => !d.is_archived && d.pinecone_id).length, 1, `${task}: the surviving memory lost its vector id`)
  return result
}

let failures = 0
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (err) {
    failures++
    console.log(`FAIL ${name}: ${(err as Error).message}`)
  }
}

const sourcePath = join(root, 'worker/processors/maintenance.processor.ts')
const { maintenanceProcessor } = await import(sourcePath) as { maintenanceProcessor: Processor }

await check('importance_decay archives three memories without a null vector id', async () => {
  assert.deepEqual(await runCase(maintenanceProcessor, 'importance_decay'), { archived: 3 })
})
// Memory 1 supersedes 2 and 3, then the more important memory 4 supersedes 1.
await check('dedup_memories supersedes three duplicates without a null vector id', async () => {
  assert.deepEqual(await runCase(maintenanceProcessor, 'dedup_memories'), { merged: 3 })
})

// Each mutant is the writer exactly as it was before the fix. Imports are made
// absolute so the copy, which lives in a temp dir, resolves to the same mocks.
const source = readFileSync(sourcePath, 'utf8')
  .replaceAll("from '../../src/", `from '${root}/src/`)
  .replaceAll("from '../lib/", `from '${root}/worker/lib/`)
  .replaceAll("from './", `from '${root}/worker/processors/`)
const mutants: Array<{ task: 'importance_decay' | 'dedup_memories'; from: string; to: string }> = [
  {
    task: 'importance_decay',
    from: "status: 'archived',\n              updated_at: new Date(),\n            },\n            $unset: { pinecone_id: '' },",
    to: "status: 'archived',\n              pinecone_id: null,\n              updated_at: new Date(),\n            },",
  },
  {
    task: 'dedup_memories',
    from: "{ $set: { is_archived: true, status: 'superseded' }, $unset: { pinecone_id: '' } }",
    to: "{ $set: { is_archived: true, status: 'superseded', pinecone_id: null } }",
  },
]
const dir = mkdtempSync(join(tmpdir(), 'memory-archive-null-'))
try {
  for (const [i, m] of mutants.entries()) {
    await check(`bites: ${m.task} reverted to pinecone_id: null fails`, async () => {
      assert.equal(source.split(m.from).length, 2, `mutation anchor for ${m.task} not found exactly once; update this audit with the writer`)
      const file = join(dir, `mutant-${i}.ts`)
      writeFileSync(file, source.replace(m.from, m.to))
      const { maintenanceProcessor: mutant } = await import(file) as { maintenanceProcessor: Processor }
      await assert.rejects(runCase(mutant, m.task), (err: Error) => err instanceof DuplicateKeyError || /explicit pinecone_id: null/.test(err.message))
    })
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// Any other writer: a literal `pinecone_id: null` in code (not a type, not a
// comment) is the same bug waiting for its second document.
function* tsFiles(dirPath: string): Generator<string> {
  for (const name of readdirSync(dirPath)) {
    const full = join(dirPath, name)
    if (statSync(full).isDirectory()) yield* tsFiles(full)
    else if (full.endsWith('.ts')) yield full
  }
}
await check('no literal pinecone_id: null write in src/ or worker/', () => {
  const hits: string[] = []
  for (const dirName of ['src', 'worker']) {
    for (const file of tsFiles(join(root, dirName))) {
      readFileSync(file, 'utf8').split('\n').forEach((line, n) => {
        const code = line.trim()
        if (code.startsWith('//') || code.startsWith('*')) return
        if (/pinecone_id\s*:\s*null\b/.test(code)) hits.push(`${file.slice(root.length + 1)}:${n + 1}`)
      })
    }
  }
  assert.deepEqual(hits, [], `explicit null vector id written at ${hits.join(', ')}`)
})

console.log(failures === 0 ? '\nmemory-archive-null: ALL GREEN' : `\nmemory-archive-null: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
