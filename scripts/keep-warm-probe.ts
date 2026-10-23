/**
 * KEEP-WARM PROBE — for the orchestrator to run on the box, one process.
 *
 * Answers two questions, which set two env values:
 *   1. Which idle gap makes a Pinecone search go cold? (→ KEEP_WARM_IDLE_MS)
 *   2. Does a `stats` ping keep search fast, or is a `query` ping needed?
 *      (→ KEEP_WARM_PINECONE)
 *
 * Phases, in one process:
 *   (a) the cold first search and embedding, then four warm ones of each;
 *   (b) for each gap: idle that long, then time a search and an embedding;
 *   (c) the same gaps, sending a `stats` ping every --ping-ms while idle;
 *   (d) the same as (c) with a `query` ping.
 *
 * What it measures: a scoped topK-10 query that cannot match anything (the same
 * wire path a retrieval takes, no records transferred) and the background
 * `embed` path for OpenAI. `embed` is deliberately the unbounded path so a cold
 * connection shows its real cost instead of the query path's deadline.
 *
 * What it does NOT do: no Mongo, no Redis, no upserts, no deletes. It writes
 * nothing anywhere. Its only paid calls are ~10 embeddings of three-word texts
 * and ~20 scoped searches, so a full run is well under $0.01.
 *
 *   bun run scripts/keep-warm-probe.ts
 *   bun run scripts/keep-warm-probe.ts --gaps 15,20,30,45,60 --ping-ms 10000
 */
import { embed } from '../src/ai/embedding'
import { vectorStore, type VectorScope, type VectorQuery } from '../src/services/vector-store'

const args = process.argv.slice(2)
function option(name: string, fallback: string): string {
  const at = args.indexOf(`--${name}`)
  const value = at >= 0 ? args[at + 1] : undefined
  return value && !value.startsWith('--') ? value : fallback
}

const gaps = option('gaps', '15,20,30,45,60').split(',').map((part) => Number(part.trim()))
if (gaps.length === 0 || gaps.some((seconds) => !Number.isFinite(seconds) || seconds <= 0)) {
  throw new Error('--gaps must be a comma-separated list of positive seconds, e.g. 15,20,30')
}
const pingMs = Number(option('ping-ms', '10000'))
if (!Number.isFinite(pingMs) || pingMs <= 0) throw new Error('--ping-ms must be positive milliseconds')

/** A scope no authored id can equal, so the search cannot match a record. */
const PROBE_SCOPE: VectorScope = { kind: 'mem', instanceId: 'keep-warm-probe' }
/** Pinecone validates the query vector against the index dimension (1024). */
const PROBE_VECTOR = (() => {
  const vector = new Array<number>(1024).fill(0)
  vector[0] = 1
  return vector
})()
const SEARCH: VectorQuery = { vector: PROBE_VECTOR, topK: 10, includeMetadata: true }

let embeddingSeq = 0
/** A fresh three-word text each time: `embed` is single-flight by text, and a
 *  repeat would share a flight instead of opening a socket. */
function probeEmbedding(): Promise<number[]> {
  return embed(`warm up probe ${++embeddingSeq}`)
}

const measurements: Array<{ key: string; label: string; ms: number }> = []

async function measured(key: string, label: string, run: () => Promise<unknown>): Promise<number> {
  const started = performance.now()
  let note = ''
  try {
    await run()
  } catch (error) {
    note = `  <-- error: ${(error as Error).message}`
  }
  const ms = performance.now() - started
  measurements.push({ key, label, ms })
  console.log(`${label.padEnd(34)} ${ms.toFixed(0).padStart(6)} ms${note}`)
  return ms
}

const search = () => vectorStore.query(PROBE_SCOPE, SEARCH)

async function idle(seconds: number): Promise<void> {
  console.log(`  … idle ${seconds}s`)
  await Bun.sleep(seconds * 1000)
}

/** Idle for `seconds`, pinging the index every `pingMs` so it never goes quiet. */
async function idleWithPings(seconds: number, mode: 'stats' | 'query'): Promise<void> {
  const endsAt = Date.now() + seconds * 1000
  let pings = 0
  while (Date.now() + pingMs <= endsAt) {
    await Bun.sleep(pingMs)
    await vectorStore.ping(mode)
    pings++
  }
  const rest = endsAt - Date.now()
  if (rest > 0) await Bun.sleep(rest)
  console.log(`  … idle ${seconds}s with ${pings} ${mode} ping(s)`)
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

const startedAt = new Date()
console.log(`keep-warm probe · ${startedAt.toISOString()}`)
console.log(`gaps: ${gaps.join(', ')}s · ping every ${pingMs}ms · writes: none`)
console.log(`Pinecone: ${process.env.PINECONE_INDEX || '(default index)'} · layout: ${process.env.VECTOR_LAYOUT || 'shared'}\n`)

console.log('(a) cold first calls, then warm:')
await measured('a-search-cold', 'first search (cold)', search)
await measured('a-embed-cold', 'first embedding (cold)', probeEmbedding)
for (let i = 1; i <= 4; i++) {
  await measured(`a-search-${i}`, `search (warm ${i})`, search)
  await measured(`a-embed-${i}`, `embedding (warm ${i})`, probeEmbedding)
}

const warmSearch = median(measurements.filter((m) => m.key.startsWith('a-search-') && m.key !== 'a-search-cold').map((m) => m.ms))
const warmEmbed = median(measurements.filter((m) => m.key.startsWith('a-embed-') && m.key !== 'a-embed-cold').map((m) => m.ms))
console.log(`\nwarm baseline: search ${warmSearch.toFixed(0)}ms · embedding ${warmEmbed.toFixed(0)}ms\n`)

console.log('(b) idle, no pings:')
for (const gap of gaps) {
  await idle(gap)
  await measured(`b-search-${gap}`, `gap ${gap}s: search`, search)
  await measured(`b-embed-${gap}`, `gap ${gap}s: embedding`, probeEmbedding)
}

console.log('\n(c) idle with a stats ping:')
for (const gap of gaps) {
  await idleWithPings(gap, 'stats')
  await measured(`c-search-${gap}`, `gap ${gap}s: search after stats`, search)
}

console.log('\n(d) idle with a query ping:')
for (const gap of gaps) {
  await idleWithPings(gap, 'query')
  await measured(`d-search-${gap}`, `gap ${gap}s: search after query`, search)
}

// A measurement is "cold" when it is clearly above the same client's warm
// baseline — 1.6× is well outside the noise seen on the box (±5%).
const COLD_RATIO = 1.6
const verdict = (ms: number, baseline: number) => (baseline > 0 && ms > baseline * COLD_RATIO ? 'COLD' : 'warm')

console.log('\nSUMMARY (COLD = more than 1.6× the warm baseline)')
for (const gap of gaps) {
  const pick = (key: string) => measurements.find((m) => m.key === key)?.ms ?? Number.NaN
  const plain = pick(`b-search-${gap}`)
  const stats = pick(`c-search-${gap}`)
  const query = pick(`d-search-${gap}`)
  const plainEmbed = pick(`b-embed-${gap}`)
  console.log(
    `  gap ${String(gap).padStart(3)}s │ search plain ${plain.toFixed(0).padStart(5)}ms ${verdict(plain, warmSearch).padEnd(4)}` +
      ` │ stats ${stats.toFixed(0).padStart(5)}ms ${verdict(stats, warmSearch).padEnd(4)}` +
      ` │ query ${query.toFixed(0).padStart(5)}ms ${verdict(query, warmSearch).padEnd(4)}` +
      ` │ embedding plain ${plainEmbed.toFixed(0).padStart(5)}ms ${verdict(plainEmbed, warmEmbed)}`,
  )
}
console.log(
  '\nRead it this way: the smallest gap where the plain search turns COLD is the window\n' +
    'KEEP_WARM_IDLE_MS must stay under. If the stats ping holds that gap warm, keep\n' +
    'KEEP_WARM_PINECONE=stats (free); if it does not and the query ping does, set query\n' +
    '(0.25 read units per ping). Check the embedding column too: it has its own connection.',
)
