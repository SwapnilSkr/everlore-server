import { AsyncLocalStorage } from 'node:async_hooks'
import { Pinecone } from '@pinecone-database/pinecone'
import { env } from './env'

/** Decimal strings keep comparisons exact beyond JavaScript's safe integers. */
export function parsePineconeLsn(value: unknown): string | undefined {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? value : undefined
}
type LsnHeaders = { writeLsn?: string; indexedLsn?: string }
const callHeaders = new AsyncLocalStorage<LsnHeaders>()

export function pineconeFetchApi(fetchApi: typeof globalThis.fetch): typeof globalThis.fetch {
  const wrapped = async (...args: Parameters<typeof globalThis.fetch>) => {
    const response = await fetchApi(...args)
    const headers = callHeaders.getStore()
    if (headers) {
      // Overwrite on every response: SDK retries must use their final response.
      headers.writeLsn = response.ok ? parsePineconeLsn(response.headers.get('x-pinecone-request-lsn')) : undefined
      headers.indexedLsn = response.ok ? parsePineconeLsn(response.headers.get('x-pinecone-max-indexed-lsn')) : undefined
    }
    return response
  }
  return Object.assign(wrapped, { preconnect: fetchApi.preconnect })
}

export async function withPineconeLsn<T>(call: () => Promise<T>): Promise<LsnHeaders & { value: T }> {
  const headers: LsnHeaders = {}
  const value = await callHeaders.run(headers, call)
  return { value, ...headers }
}

let pineconeClient: Pinecone | null = null

export function getPinecone(): Pinecone {
  if (!pineconeClient) {
    if (!env.PINECONE_API_KEY) {
      console.warn('Pinecone API key not set. Vector operations will fail.')
    }
    pineconeClient = new Pinecone({ apiKey: env.PINECONE_API_KEY, fetchApi: pineconeFetchApi(globalThis.fetch) })
  }
  return pineconeClient
}

export function getPineconeIndex() {
  return getPinecone().index(env.PINECONE_INDEX)
}
