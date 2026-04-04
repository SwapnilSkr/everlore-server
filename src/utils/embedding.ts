import { getOpenAI } from '../config/openai'

/** Must match the Pinecone index vector dimension (e.g. serverless indexes often use 1024). */
const EMBEDDING_DIMENSIONS = 1024

export async function embed(text: string): Promise<number[]> {
  const openai = getOpenAI()
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  })
  return response.data[0].embedding
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const openai = getOpenAI()
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  })
  return response.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding)
}
