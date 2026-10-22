import type { ScoredPineconeRecord } from '@pinecone-database/pinecone'
import { ragVectorQueries, summaryVectorQuery } from '../src/providers/rag.provider'
import { scopeId, vectorStoreForLayout, type VectorScope, type VectorQuery, type VectorStore } from '../src/services/vector-store'

export type RecallCase = { label: string; texts: string[]; requests: (vector: number[]) => Array<{ scope: VectorScope; query: VectorQuery }> }

export function parseCompareOptions(args: string[]) {
  let limit = Infinity, queries = 5, price: number | undefined, maxP50Ms = 30, maxP95Ms = 60
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') continue
    if (!['--limit', '--queries', '--price-per-million', '--max-p50-ms', '--max-p95-ms'].includes(arg)) throw new Error(`Unknown argument: ${arg}`)
    const value = args[++i]
    const n = Number(value)
    const timing = arg === '--max-p50-ms' || arg === '--max-p95-ms'
    if (!value?.trim() || !Number.isFinite(n) || (timing ? n < 0 : n <= 0) || (['--limit', '--queries'].includes(arg) && !Number.isInteger(n))) throw new Error(`Invalid ${arg}`)
    if (arg === '--limit') limit = n
    else if (arg === '--queries') queries = n
    else if (arg === '--max-p50-ms') maxP50Ms = n
    else if (arg === '--max-p95-ms') maxP95Ms = n
    else price = n
  }
  return { limit, queries, price, maxP50Ms, maxP95Ms }
}

/** Only exact-score ties may permute; ids, scores and the order of unequal scores must match. */
export function sameHits(a: ScoredPineconeRecord[], b: ScoredPineconeRecord[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length;) {
    const score = a[i].score
    if (!Number.isFinite(score) || score !== b[i].score) return false
    let end = i + 1
    while (end < a.length && a[end].score === score) end++
    const left = a.slice(i, end).map((r) => r.id).sort()
    const right = b.slice(i, end)
    if (right.some((r) => r.score !== score) || left.join('\0') !== right.map((r) => r.id).sort().join('\0')) return false
    i = end
  }
  return true
}

/**
 * How two result lists differ, for the breakdown: the layouts score through
 * different index paths, so a gap in the fourth decimal is expected and is
 * reported separately from a different memory or a different order.
 */
export function hitDifference(a: ScoredPineconeRecord[], b: ScoredPineconeRecord[]) {
  const ids = (r: ScoredPineconeRecord[]) => r.map((x) => x.id)
  const sameOrder = ids(a).join('\0') === ids(b).join('\0')
  const inB = new Set(ids(b))
  const missing = a.filter((x) => !inB.has(x.id))
  const byId = new Map(b.map((x) => [x.id, x.score ?? 0]))
  const maxDelta = Math.max(0, ...a.filter((x) => byId.has(x.id)).map((x) => Math.abs((x.score ?? 0) - byId.get(x.id)!)))
  // Rank of the first position that differs, 1-based; 0 when the order is identical.
  const firstRank = sameOrder ? 0 : ids(a).findIndex((id, i) => id !== ids(b)[i]) + 1
  return { sameOrder, missing: missing.length, maxDelta, firstRank, size: a.length }
}

export function saveRecallCase(params: { instanceId: string; templateId: string; texts: string[]; loreTopK: number; memoryTopK: number; timelineId: string }): RecallCase {
  const { instanceId, templateId, texts, loreTopK, memoryTopK, timelineId } = params
  return { label: `save/${instanceId}`, texts, requests: (vector) => {
    const normal = ragVectorQueries(vector, loreTopK, memoryTopK, timelineId)
    const replay = ragVectorQueries(vector, loreTopK, memoryTopK)
    const requests = [
      { scope: { kind: 'lore' as const, templateId }, query: normal.lore },
      { scope: { kind: 'mem' as const, instanceId }, query: normal.memory },
      { scope: { kind: 'mem' as const, instanceId }, query: replay.memory },
      // The context packet asks for 3, while querySummaries' public default is 4.
      { scope: { kind: 'sum' as const, instanceId }, query: summaryVectorQuery(vector, 3) },
      { scope: { kind: 'sum' as const, instanceId }, query: summaryVectorQuery(vector) },
    ]
    // Replay recall widens by 0.35 per variant and caps at 40 lore / 80 memory.
    for (let depth = 1; depth <= 5; depth++) {
      const factor = Math.min(1 + depth * 0.35, 2.5)
      const widened = ragVectorQueries(vector, Math.min(Math.max(Math.round(loreTopK * factor), loreTopK), 40),
        Math.min(Math.max(Math.round(memoryTopK * factor), memoryTopK), 80))
      requests.push({ scope: { kind: 'lore', templateId }, query: widened.lore },
        { scope: { kind: 'mem', instanceId }, query: widened.memory })
    }
    return requests
  } }
}

export async function compareRecall(cases: RecallCase[], runtime: {
  old: VectorStore; shared: VectorStore
  embed: (text: string) => Promise<number[]>
  log: (line: string) => void
  maxP50Ms?: number; maxP95Ms?: number
}) {
  if (!cases.length) throw new Error('No recall cases; refusing an empty PASS')
  const maxP50Ms = runtime.maxP50Ms ?? 30, maxP95Ms = runtime.maxP95Ms ?? 60
  if (![maxP50Ms, maxP95Ms].every((n) => Number.isFinite(n) && n >= 0)) throw new Error('Invalid latency thresholds')
  const timings = new Map<VectorScope['kind'], { old: number[]; shared: number[] }>()
  let failures = 0, queries = 0, pairs = 0
  const breakdown = { checks: 0, reordered: 0, differentSet: 0, missing: 0, maxDelta: 0, firstRanks: [] as number[] }
  const pair = async (scope: VectorScope, query: VectorQuery, measured: boolean) => {
    const results: Partial<Record<'old' | 'shared', Awaited<ReturnType<VectorStore['query']>>>> = {}
    // Sequential pairs avoid contention; alternate which layout goes first, including warm-ups.
    const order = pairs++ % 2 ? ['shared', 'old'] as const : ['old', 'shared'] as const
    for (const layout of order) {
      let duration: number | undefined
      results[layout] = await runtime[layout].query(scope, query, (ms) => { duration = ms })
      if (duration === undefined || !Number.isFinite(duration) || duration < 0) throw new Error('Missing SDK query timing')
      if (measured) timings.get(scope.kind)![layout].push(duration)
    }
    return [results.old!, results.shared!] as const
  }
  runtime.log('scope | embedded queries | vector checks | result')
  for (const test of cases) {
    let checks = 0, differences = 0
    if (!test.texts.length) throw new Error(`No query texts for ${test.label}`)
    for (const text of test.texts) {
      const vector = await runtime.embed(text)
      queries++
      for (const { scope, query } of test.requests(vector)) {
        if (!timings.has(scope.kind)) {
          timings.set(scope.kind, { old: [], shared: [] })
          await pair(scope, query, false)
        }
        const [a, b] = await pair(scope, query, true)
        checks++
        const d = hitDifference(a.matches, b.matches)
        breakdown.checks++
        breakdown.maxDelta = Math.max(breakdown.maxDelta, d.maxDelta)
        if (!d.sameOrder) {
          breakdown.reordered++
          breakdown.firstRanks.push(d.firstRank)
          if (d.missing) { breakdown.differentSet++; breakdown.missing += d.missing }
          runtime.log(`ORDER ${test.label} ${scope.kind} topK=${query.topK} size=${d.size} first-diff-rank=${d.firstRank} missing=${d.missing}`)
        }
        if (!sameHits(a.matches, b.matches)) {
          differences++
          runtime.log(`DIFF ${test.label} query=${queries} ${scope.kind}/${scopeId(scope)} topK=${query.topK}`)
        }
      }
    }
    failures += differences
    runtime.log(`${test.label} | ${test.texts.length} | ${checks} | ${differences ? `FAIL (${differences})` : 'PASS'}`)
  }
  if (!timings.size) throw new Error('No vector checks; refusing an empty PASS')
  const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
  let slowKinds = 0
  runtime.log(`kind | samples/layout | old p50 ms | shared p50 ms | old p95 ms | shared p95 ms | speed (max delta ${maxP50Ms}/${maxP95Ms} ms)`)
  for (const [kind, samples] of timings) {
    const old50 = percentile(samples.old, 0.5), shared50 = percentile(samples.shared, 0.5)
    const old95 = percentile(samples.old, 0.95), shared95 = percentile(samples.shared, 0.95)
    const slow = shared50 - old50 > maxP50Ms || shared95 - old95 > maxP95Ms
    if (slow) slowKinds++
    runtime.log(`${kind} | ${samples.old.length} | ${old50.toFixed(2)} | ${shared50.toFixed(2)} | ${old95.toFixed(2)} | ${shared95.toFixed(2)} | ${slow ? 'FAIL' : 'PASS'}`)
  }
  const ranks = breakdown.firstRanks.sort((x, y) => x - y)
  runtime.log(`BREAKDOWN: ${breakdown.checks} searches; same memories in the same order ${breakdown.checks - breakdown.reordered}; ` +
    `order differs ${breakdown.reordered} (of which a different memory set ${breakdown.differentSet}, ${breakdown.missing} memories swapped); ` +
    `largest score gap ${breakdown.maxDelta.toFixed(6)}; first differing rank min ${ranks[0] ?? '-'} median ${ranks[Math.floor(ranks.length / 2)] ?? '-'}`)
  runtime.log(`${failures || slowKinds ? 'FAIL' : 'PASS'}: ${cases.length} scopes, ${queries} query vectors, ${failures} differences, ${slowKinds} slow kinds`)
  return failures === 0 && slowKinds === 0
}

export async function liveCases(options: ReturnType<typeof parseCompareOptions>): Promise<RecallCase[]> {
  const { MongoClient } = await import('mongodb')
  const { env } = await import('../src/config/env')
  const { COLLECTIONS } = await import('../src/models/collections')
  // The app's connectMongo creates indexes; this gate must perform reads only.
  const client = new MongoClient(env.MONGODB_URI)
  await client.connect()
  const db = client.db()
  const mongoColl = {
    memories: () => db.collection<import('../src/models/memory.model').MemoryDoc>(COLLECTIONS.memories),
    worldInstances: () => db.collection<import('../src/models/world-instance.model').WorldInstanceDoc>(COLLECTIONS.world_instances),
    worldTemplates: () => db.collection<import('../src/models/world-template.model').WorldTemplateDoc>(COLLECTIONS.world_templates),
    events: () => db.collection<import('../src/models/world-event.model').WorldEventDoc>(COLLECTIONS.events),
  }
  const { idString } = await import('../src/utils/mongo-id')
  try {
    const cases: RecallCase[] = []
    const instanceIds = await mongoColl.memories().distinct('instance_id')
    instanceIds.sort((a, b) => idString(a).localeCompare(idString(b)))
    for (const iid of instanceIds.slice(0, options.limit)) {
      const instance = await mongoColl.worldInstances().findOne({ _id: iid })
      // Leftover rows of a deleted save have no vectors to compare.
      if (!instance) { console.log(`skip save ${idString(iid)}: save deleted`); continue }
      // A save whose world was deleted keeps its memories; compare them at recall's defaults.
      const template = await mongoColl.worldTemplates().findOne({ _id: instance.template_id })
      if (!template) console.log(`save ${idString(iid)}: world deleted, comparing at default sizes`)
      const events = await mongoColl.events().find({ instance_id: iid, 'data.player_input': { $type: 'string', $ne: '' } })
        .sort({ sequence: -1 }).limit(options.queries).toArray()
      const texts = events.map((e) => e.data.player_input).filter((s) => s.trim())
      if (texts.length < options.queries) {
        const memories = await mongoColl.memories().find({ instance_id: iid }).sort({ created_at: -1 }).limit(options.queries).toArray()
        texts.push(...memories.map((m) => m.text).filter((s) => s.trim()).slice(0, options.queries - texts.length))
      }
      cases.push(saveRecallCase({ instanceId: idString(iid), templateId: idString(instance.template_id), texts,
        loreTopK: template?.max_lore_results || 10, memoryTopK: template?.max_context_memories || 25,
        timelineId: instance.active_timeline_id || 'main' }))
    }
    // --limit caps saves only. Every authored world with lore is always checked.
    const worlds = await mongoColl.worldTemplates().find({ global_lore: { $type: 'string', $ne: '' } }).toArray()
    for (const world of worlds) {
      if (!world.global_lore.trim()) continue
      const templateId = idString(world._id)
      const texts = world.global_lore.split(/(?<=[.!?])\s+/).filter((s) => s.trim()).slice(0, options.queries)
      cases.push({ label: `world/${templateId}`, texts, requests: (vector) => [
        { scope: { kind: 'lore', templateId }, query: ragVectorQueries(vector, world.max_lore_results || 10, 25).lore },
      ] })
    }
    return cases
  } finally { await client.close() }
}

if (import.meta.main) {
  let tokens = 0, price = 0
  try {
    const options = parseCompareOptions(process.argv.slice(2))
    const { AI_MODELS } = await import('../src/ai/models')
    const { getOpenAI } = await import('../src/config/openai')
    // Standard price: https://developers.openai.com/api/docs/models/text-embedding-3-small
    // Override explicitly if the configured model/price changes.
    if (options.price === undefined && AI_MODELS.embedding !== 'text-embedding-3-small') throw new Error('Configured embedding model requires --price-per-million')
    price = options.price ?? 0.02
    const passed = await compareRecall(await liveCases(options), {
      old: vectorStoreForLayout('namespaced'), shared: vectorStoreForLayout('shared'), log: console.log,
      maxP50Ms: options.maxP50Ms, maxP95Ms: options.maxP95Ms,
      embed: async (text) => {
        const response = await getOpenAI().embeddings.create({ model: AI_MODELS.embedding, input: text, dimensions: 1024 })
        tokens += response.usage.total_tokens
        return response.data[0].embedding
      },
    })
    if (!passed) process.exitCode = 1
  } catch (err) { console.error((err as Error).message); process.exitCode = 1 }
  finally {
    console.log(`Embedding spend: ${tokens} tokens × $${price}/1M = $${(tokens * price / 1e6).toFixed(8)} (USD; convert at the run's USD/INR rate)`)
  }
}
