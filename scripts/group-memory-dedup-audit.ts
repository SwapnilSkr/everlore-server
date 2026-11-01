import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'

type Row = Record<string, unknown>
const unavailable = (): never => { throw new Error('Unexpected dependency in memory dedup audit') }
globalThis.fetch = Object.assign(async () => unavailable(), { preconnect: unavailable })
let memories: Row[] = [], group = true
mock.module('../src/config/env', () => ({ env: {} }))
mock.module('../src/config/redis', () => ({ getRedisClient: unavailable, getQueueRedisClient: unavailable }))
mock.module('../src/config/mongo', () => ({ mongoColl: {
  worldInstances: () => ({ findOne: async () => group ? { group_state: {} } : null }),
  memories: () => ({ find: () => ({ toArray: async () => memories }), updateOne: async (filter: Row, update: Row) => {
    const row = memories.find(row => row._id === filter._id)!
    Object.assign(row, update.$set); for (const key of Object.keys(update.$unset || {})) delete row[key]
  } }),
} }))
mock.module('../src/services/vector-store', () => ({ vectorStore: {
  fetch: async (_scope: Row, ids: string[]) => ({ records: Object.fromEntries(ids.map(id => [id, { values: [1, 0] }])) }), deleteIds: async () => {},
} }))
mock.module('../src/ai', () => ({ embedBatch: unavailable }))
mock.module('../src/queues', () => ({ getMaintenanceQueue: unavailable, QUEUE_RETENTION: {} }))
mock.module('../src/services/media/service', () => ({ repairMediaReservations: unavailable }))
mock.module('../src/services/queue-hygiene.service', () => ({ MANAGED_QUEUES: [], pruneExpiredCompletedQueueJobs: unavailable }))
mock.module('../src/services/post-process-outbox.service', () => ({ dispatchPostProcessOutbox: unavailable }))
mock.module('../src/services/web-traffic-rollup.service', () => ({ webTrafficRollupService: {} }))
mock.module('../src/services/telemetry/rollup.service', () => ({ appDailyRollupService: {} }))
mock.module('../src/services/telemetry/triage.service', () => ({ triageService: {} }))
mock.module('../worker/processors/character-projection.processor', () => ({ characterProjectionProcessor: unavailable }))
const { maintenanceProcessor } = await import('../worker/processors/maintenance.processor')
const source = new ObjectId()
function fixture(subjects = ['Fixture Person'], event = source) {
  memories = [0, 1].map(i => ({ _id: new ObjectId(), instance_id: new ObjectId(), source_event_ids: [i ? event : source],
    subjects: i ? subjects : ['Fixture Person'], objects: [], text: `Paraphrase ${i}`, pinecone_id: `vec-${i}`, importance: 4, is_archived: false }))
}
try {
  for (const [subjects, event] of [[['Different Person'], source], [['Fixture Person'], new ObjectId()]] as const) {
    group = true; fixture([...subjects], event)
    assert.deepEqual(await maintenanceProcessor({ data: { task: 'dedup_memories', instanceId: String(new ObjectId()) } } as never), { merged: 0 })
    assert(memories.every(memory => memory.is_archived === false))
  }
  fixture(); assert.deepEqual(await maintenanceProcessor({ data: { task: 'dedup_memories', instanceId: String(new ObjectId()) } } as never), { merged: 1 })
  group = false; fixture(['Different Person'], new ObjectId())
  assert.deepEqual(await maintenanceProcessor({ data: { task: 'dedup_memories', instanceId: String(new ObjectId()) } } as never), { merged: 1 })
  console.log('PASS memory scheduled dedup protects group owners and provenance while ordinary worlds retain existing behavior')
} catch (error) { throw new Error('FAIL memory scheduled dedup', { cause: error }) }
