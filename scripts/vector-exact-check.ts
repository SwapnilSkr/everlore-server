import type { ScoredPineconeRecord } from '@pinecone-database/pinecone'
import { liveCases, parseCompareOptions, type RecallCase } from './vector-recall-compare'
import { scopeId, vectorStoreForLayout, type VectorScope, type VectorStore } from '../src/services/vector-store'

/**
 * Read-only referee for the layout comparison: scores every stored vector of a
 * scope by exact cosine, with no index involved, and measures how far each
 * layout's search result is from that true ranking.
 */

// Two exact scores closer than this are a tie: either order is correct.
const TIE = 1e-6

type Exact = { id: string; score: number }
export type LayoutTally = { searches: number; trueOrder: number; trueSet: number; missing: number; slots: number; maxScoreError: number; sumScoreError: number; scored: number }

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / Math.sqrt(na * nb)
}

export function exactTopK(records: Map<string, number[]>, vector: number[], topK: number): Exact[] {
  return [...records].map(([id, values]) => ({ id, score: cosine(values, vector) }))
    .sort((a, b) => b.score - a.score).slice(0, topK)
}

/** Grades one layout's result against the exact ranking, treating exact ties as interchangeable. */
export function grade(truth: Exact[], all: Map<string, number[]>, vector: number[], got: ScoredPineconeRecord[], tally: LayoutTally) {
  tally.searches++
  tally.slots += truth.length
  const exact = (id: string) => all.has(id) ? cosine(all.get(id)!, vector) : -Infinity
  // A result is in the true order when each slot holds a memory whose exact score equals the true score of that slot.
  const inOrder = got.length === truth.length && got.every((r, i) => Math.abs(exact(r.id) - truth[i].score) <= TIE)
  if (inOrder) tally.trueOrder++
  // A memory left out only counts when it scores clearly above the last returned slot.
  const cut = truth.at(-1)?.score ?? Infinity
  const gotIds = new Set(got.map((r) => r.id))
  const missing = truth.filter((t) => !gotIds.has(t.id) && t.score - cut > TIE).length
  tally.missing += missing
  if (!missing && got.length === truth.length) tally.trueSet++
  for (const r of got) {
    if (!all.has(r.id) || r.score === undefined) continue
    const error = Math.abs(r.score - exact(r.id))
    tally.maxScoreError = Math.max(tally.maxScoreError, error)
    tally.sumScoreError += error
    tally.scored++
  }
}

async function loadScope(store: VectorStore, scope: VectorScope) {
  const ids = await store.listIds(scope)
  const res = await store.fetch(scope, ids)
  return new Map(Object.values(res.records).map((r) => [r.id, r.values]))
}

export async function exactCheck(cases: RecallCase[], runtime: {
  old: VectorStore; shared: VectorStore
  embed: (text: string) => Promise<number[]>
  log: (line: string) => void
}) {
  const blank = (): LayoutTally => ({ searches: 0, trueOrder: 0, trueSet: 0, missing: 0, slots: 0, maxScoreError: 0, sumScoreError: 0, scored: 0 })
  const tallies = { old: blank(), shared: blank() }
  const cache = new Map<string, Map<string, number[]>>()
  let valueMismatches = 0
  // The exact ranking is computed from the original layout's vectors; the copy must hold the same numbers.
  const vectorsOf = async (scope: VectorScope) => {
    const key = `${scope.kind}#${scopeId(scope)}`
    if (!cache.has(key)) {
      const [old, shared] = await Promise.all([loadScope(runtime.old, scope), loadScope(runtime.shared, scope)])
      const same = old.size === shared.size && [...old].every(([id, v]) => shared.get(id)?.every((x, i) => x === v[i]) && shared.get(id)!.length === v.length)
      if (!same) { valueMismatches++; runtime.log(`VALUES DIFFER ${key}: old ${old.size}, shared ${shared.size}`) }
      cache.set(key, old)
    }
    return cache.get(key)!
  }
  for (const test of cases) {
    for (const text of test.texts) {
      const vector = await runtime.embed(text)
      for (const { scope, query } of test.requests(vector)) {
        const all = await vectorsOf(scope)
        const truth = exactTopK(all, vector, query.topK)
        for (const layout of ['old', 'shared'] as const) {
          const res = await runtime[layout].query(scope, query)
          grade(truth, all, vector, res.matches, tallies[layout])
        }
      }
    }
  }
  runtime.log('layout | searches | true order | true set | memories left out | worst score error | mean score error')
  for (const layout of ['old', 'shared'] as const) {
    const t = tallies[layout]
    runtime.log(`${layout} | ${t.searches} | ${t.trueOrder} | ${t.trueSet} | ${t.missing} of ${t.slots} | ${t.maxScoreError.toFixed(6)} | ${(t.sumScoreError / Math.max(t.scored, 1)).toFixed(6)}`)
  }
  runtime.log(`Stored vectors identical in both layouts: ${valueMismatches ? `NO (${valueMismatches} scopes differ)` : `yes (${cache.size} scopes)`}`)
  return { tallies, valueMismatches }
}

if (import.meta.main) {
  let tokens = 0
  try {
    const options = parseCompareOptions(process.argv.slice(2))
    const { AI_MODELS } = await import('../src/ai/models')
    const { getOpenAI } = await import('../src/config/openai')
    if (AI_MODELS.embedding !== 'text-embedding-3-small') throw new Error('Unexpected embedding model; check its price first')
    const result = await exactCheck(await liveCases(options), {
      old: vectorStoreForLayout('namespaced'), shared: vectorStoreForLayout('shared'), log: console.log,
      embed: async (text) => {
        const response = await getOpenAI().embeddings.create({ model: AI_MODELS.embedding, input: text, dimensions: 1024 })
        tokens += response.usage.total_tokens
        return response.data[0].embedding
      },
    })
    if (result.valueMismatches) process.exitCode = 1
  } catch (err) { console.error((err as Error).message); process.exitCode = 1 }
  finally { console.log(`Embedding spend: ${tokens} tokens × $0.02/1M = $${(tokens * 0.02 / 1e6).toFixed(8)}`) }
}
