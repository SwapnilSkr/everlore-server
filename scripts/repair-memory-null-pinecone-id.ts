/**
 * Remove explicit `pinecone_id: null` from memories.
 *
 * `idx_memories_pinecone_id` is unique + sparse. A sparse index skips documents
 * that LACK the key, but an explicit null is indexed like any other value, so
 * only one memory in the whole collection may carry it. The maintenance job's
 * archive paths (`importance_decay`, `dedup_memories`) used to `$set` the key
 * to null when they dropped a memory's vector: the first archive succeeded, and
 * every later one failed the job with E11000.
 *
 * The writers now `$unset` the key. This clears the nulls already stored, so
 * the stored shape matches the one the writers produce. It touches nothing but
 * that key; a memory with a real vector id is never matched.
 *
 * Dry run by default (read-only: counts and samples). Run:
 *   bun run repair:memory-null-pinecone-id [--execute]
 */
import { MongoClient } from 'mongodb'

const execute = process.argv.includes('--execute')
const uri = process.env.MONGODB_URI
if (!uri) {
  console.error('MONGODB_URI is required')
  process.exit(1)
}
const client = new MongoClient(uri)
await client.connect()
const memories = client.db().collection('memories')

// `{ pinecone_id: null }` would also match a missing key; `$type: 'null'` is the
// explicit null only.
const explicitNull = { pinecone_id: { $type: 'null' } }

const [total, nulls, missing] = await Promise.all([
  memories.estimatedDocumentCount(),
  memories.countDocuments(explicitNull),
  memories.countDocuments({ pinecone_id: { $exists: false } }),
])
console.log(`memories: ${total} total, ${nulls} explicit null pinecone_id, ${missing} without the key`)

const samples = await memories
  .find(explicitNull, { projection: { instance_id: 1, status: 1, is_archived: 1, updated_at: 1 } })
  .limit(10)
  .toArray()
for (const m of samples) {
  console.log(`  ${String(m._id)} instance ${String(m.instance_id)} status ${m.status} archived ${m.is_archived} updated ${m.updated_at?.toISOString?.() ?? '-'}`)
}

if (!execute) {
  console.log(`\nDry run. ${nulls} document(s) would have pinecone_id unset. Re-run with --execute to apply.`)
} else {
  const res = await memories.updateMany(explicitNull, { $unset: { pinecone_id: '' } })
  console.log(`\nUnset pinecone_id on ${res.modifiedCount} document(s).`)
}

await client.close()
