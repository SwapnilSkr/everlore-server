import { Pinecone } from '@pinecone-database/pinecone'
import { env } from './env'

let pineconeClient: Pinecone | null = null

export function getPinecone(): Pinecone {
  if (!pineconeClient) {
    if (!env.PINECONE_API_KEY) {
      console.warn('Pinecone API key not set. Vector operations will fail.')
    }
    pineconeClient = new Pinecone({ apiKey: env.PINECONE_API_KEY })
  }
  return pineconeClient
}

export function getPineconeIndex() {
  return getPinecone().index(env.PINECONE_INDEX)
}
