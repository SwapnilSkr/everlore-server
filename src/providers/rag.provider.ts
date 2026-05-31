import { getPineconeIndex } from '../config/pinecone'
import { embed } from '../ai'
import { mongoColl } from '../config/mongo'
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
    (m) => (m.metadata as { text?: string })?.text || '',
  )
  const memoryTexts = (memoryResults.matches || []).map(
    (m) => (m.metadata as { text?: string })?.text || '',
  )
  const retrievedMemoryMongoIds = (memoryResults.matches || [])
    .map((m) => (m.metadata as { mongo_id?: string })?.mongo_id)
    .filter(Boolean) as string[]

  if (retrievedMemoryMongoIds.length > 0) {
    const oids = retrievedMemoryMongoIds.map((id) => parseObjectId(String(id)))
    await mongoColl.memories().updateMany(
      { _id: { $in: oids } },
      { $inc: { access_count: 1 }, $set: { last_accessed_at: new Date() } },
    )
  }

  return { loreTexts, memoryTexts, retrievedMemoryMongoIds }
}
