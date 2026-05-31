import { getOpenAI } from '../config/openai'
import { AI_MODELS } from './models'

/** Must match the Pinecone index vector dimension (serverless indexes use 1024). */
const EMBEDDING_DIMENSIONS = 1024

export async function embed(text: string): Promise<number[]> {
  const openai = getOpenAI()
  const response = await openai.embeddings.create({
    model: AI_MODELS.embedding,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  })
  return response.data[0].embedding
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const openai = getOpenAI()
  const response = await openai.embeddings.create({
    model: AI_MODELS.embedding,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  })
  return response.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}
