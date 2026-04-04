import { getPineconeIndex } from '../config/pinecone'
import { embed } from '../utils/embedding'
import { coll } from '../config/mongo'
import { parseObjectId } from '../utils/mongo-id'

interface RagResult {
  loreTexts: string[]
  memoryTexts: string[]
  retrievedMemoryMongoIds: string[]
}

export async function queryRag(
  templateId: string,
  instanceId: string,
  queryText: string,
  maxLoreResults: number,
  maxMemoryResults: number,
): Promise<RagResult> {
  const queryEmbedding = await embed(queryText)
  const index = getPineconeIndex()

  // Query lore and memory namespaces in parallel
  const [loreResults, memoryResults] = await Promise.all([
    index.namespace(`lore_${templateId}`).query({
      vector: queryEmbedding,
      topK: maxLoreResults,
      includeMetadata: true,
    }),
    index.namespace(`mem_${instanceId}`).query({
      vector: queryEmbedding,
      topK: maxMemoryResults,
      includeMetadata: true,
    }),
  ])

  const loreTexts = (loreResults.matches || []).map(
    (m) => (m.metadata as any)?.text || '',
  )
  const memoryTexts = (memoryResults.matches || []).map(
    (m) => (m.metadata as any)?.text || '',
  )
  const retrievedMemoryMongoIds = (memoryResults.matches || [])
    .map((m) => (m.metadata as any)?.mongo_id)
    .filter(Boolean)

  // Update access counts for retrieved memories
  if (retrievedMemoryMongoIds.length > 0) {
    const oids = retrievedMemoryMongoIds.map((id) => parseObjectId(String(id)))
    await coll('memories').updateMany(
      { _id: { $in: oids } },
      { $inc: { access_count: 1 }, $set: { last_accessed_at: new Date() } },
    )
  }

  return { loreTexts, memoryTexts, retrievedMemoryMongoIds }
}
