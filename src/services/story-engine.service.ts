import { ObjectId, type Document } from 'mongodb'
import { coll } from '../config/mongo'
import type { GenerationLogDoc } from '../models/generation-log.model'
import type { LLMCallDoc } from '../models/llm-call.model'
import { traceStore, BODY_TTL_SECONDS, ensureStoryEngineLogIndexes } from './llm-trace.service'
import { explainStoryTurn, storyLabel, winningNarrator } from './story-engine-explain'

export interface StoryTurnQuery {
  page?: number; limit?: number; instance_id?: string; world_id?: string; model?: string
  slow?: 'first_word' | 'after_reply'; failed?: 'true' | 'false'; min_cost_usd?: number; from?: string; to?: string
}
type TurnRow = GenerationLogDoc & { calls?: LLMCallDoc[]; world?: { template_id?: ObjectId }; template?: { title?: string } }
const logs = () => coll<GenerationLogDoc>('generation_logs')
const pairLookup = (model?: string): Document => ({ $lookup: {
  from: 'llm_calls', let: { instance: '$instance_id', sequence: '$sequence' },
  pipeline: [{ $match: { ...(model ? { model } : {}), $expr: { $and: [
    { $eq: ['$instance_id', '$$instance'] }, { $eq: ['$sequence', '$$sequence'] },
  ] } } }], as: 'calls',
} })
function turnItem(row: TurnRow) {
  const calls = row.calls ?? []
  const slowest = [...calls].sort((a, b) => b.duration_ms - a.duration_ms)[0]
  return { id: row._id.toHexString(), instance_id: row.instance_id.toHexString(),
    ...(row.world?.template_id ? { world_id: row.world.template_id.toHexString() } : {}),
    ...(row.template?.title ? { world_title: row.template.title } : {}),
    sequence: row.sequence, created_at: row.created_at, narrator_model: row.model_used,
    ...(row.provider ? { provider: row.provider } : {}),
    first_word_ms: row.end_to_end_ttft_ms, reply_ms: row.stream_ms, after_reply_ms: row.post_stream_ms,
    turn_cost_usd: row.turn_cost_usd, call_count: row.call_count ?? row.llm_calls?.length ?? 0,
    failed_call_count: row.failed_call_count ?? 0, hedged: row.hedged ?? false,
    ...(slowest ? { slowest: { label: storyLabel(slowest.purpose), ms: slowest.duration_ms } }
      : row.tail_slowest_call ? { slowest: { label: storyLabel(row.tail_slowest_call), ms: row.tail_stages?.[row.tail_slowest_call] ?? 0 } } : {}),
  }
}
export async function listStoryTurns(query: StoryTurnQuery) {
  await ensureStoryEngineLogIndexes()
  const page = query.page ?? 1, limit = query.limit ?? 25
  const match: Document = {}
  if (query.instance_id) match.instance_id = new ObjectId(query.instance_id)
  if (query.slow === 'first_word') match.end_to_end_ttft_ms = { $gte: 3000 }
  if (query.slow === 'after_reply') match.post_stream_ms = { $gte: 4000 }
  if (query.failed === 'true') match.failed_call_count = { $gt: 0 }
  if (query.min_cost_usd !== undefined) match.turn_cost_usd = { $gte: query.min_cost_usd }
  if (query.from || query.to) match.created_at = { ...(query.from ? { $gte: new Date(query.from) } : {}), ...(query.to ? { $lte: new Date(query.to) } : {}) }
  const worldLookup: Document[] = [
    { $lookup: { from: 'world_instances', localField: 'instance_id', foreignField: '_id', as: 'world' } },
    { $set: { world: { $first: '$world' } } },
  ]
  const pipeline: Document[] = [{ $match: match }, { $sort: { created_at: -1, _id: -1 } }]
  if (query.model) {
    // Filter through the model index once, rather than joining call rows for
    // every log before pagination. The page's full calls are fetched below.
    const pairs = await traceStore().calls.aggregate<{ _id: { instance_id: ObjectId; sequence: number } }>([
      { $match: { model: query.model, instance_id: { $exists: true }, sequence: { $exists: true } } },
      { $group: { _id: { instance_id: '$instance_id', sequence: '$sequence' } } },
    ]).toArray()
    match.$or = pairs.length ? pairs.map(({ _id }) => _id) : [{ _id: { $in: [] } }]
  }
  if (query.world_id) pipeline.push(...worldLookup, { $match: { 'world.template_id': new ObjectId(query.world_id) } })
  pipeline.push({ $facet: {
    total: [{ $count: 'count' }], items: [
      { $skip: (page - 1) * limit }, { $limit: limit },
      pairLookup(),
      ...(!query.world_id ? worldLookup : []),
      { $lookup: { from: 'world_templates', localField: 'world.template_id', foreignField: '_id', as: 'template' } },
      { $set: { template: { $first: '$template' } } },
      // Exclude existing generation_logs diagnostics from the list response.
    ],
  } })
  const [result] = await logs().aggregate<{ items: TurnRow[]; total: Array<{ count: number }> }>(pipeline).toArray()
  return { items: (result?.items ?? []).map(turnItem), total: result?.total[0]?.count ?? 0, page, limit }
}
function costBreakdown(calls: LLMCallDoc[]) {
  const phases = { before_reply: 0, reply: 0, after_reply: 0, background: 0 }
  const models = new Map<string, number>(), purposes = new Map<string, number>()
  for (const call of calls) {
    const usd = call.cost_usd ?? 0
    phases[call.phase] += usd
    models.set(call.model, (models.get(call.model) ?? 0) + usd)
    purposes.set(call.purpose, (purposes.get(call.purpose) ?? 0) + usd)
  }
  return { ...phases, total: Object.values(phases).reduce((a, b) => a + b, 0),
    by_model: [...models].map(([model, usd]) => ({ model, usd })),
    by_purpose: [...purposes].map(([purpose, usd]) => ({ label: storyLabel(purpose), usd })) }
}
export async function storyTurnDetail(id: string) {
  const row = await logs().findOne({ _id: new ObjectId(id) })
  if (!row) return null
  const calls = await traceStore().calls.find({ instance_id: row.instance_id, sequence: row.sequence }).sort({ started_at: 1, _id: 1 }).toArray()
  const dispatched = row.dispatched_at ?? new Date(row.created_at.getTime() - (row.post_stream_ms ?? 0) - row.latency_ms - (row.context_latency_ms ?? 0))
  const instance = await coll<{ _id: ObjectId; template_id: ObjectId }>('world_instances').findOne({ _id: row.instance_id }, { projection: { template_id: 1 } })
  const template = instance?.template_id ? await coll<{ _id: ObjectId; title: string }>('world_templates').findOne({ _id: instance.template_id }, { projection: { title: 1 } }) : null
  // Only timings are spread from the old log: prose hygiene diagnostics may
  // include text and belong to the older admin surface, not this contract.
  const timings = Object.fromEntries(Object.entries(row).filter(([key]) => key.endsWith('_ms') || ['prep_stages', 'tail_stages', 'pre_narrator_stages', 'tail_slowest_call'].includes(key)))
  const narrator = winningNarrator(calls)
  return { turn: { ...turnItem({ ...row, calls, world: instance ?? undefined, template: template ?? undefined }), ...timings },
    anchors: { dispatched_at: dispatched, narrator_started_at: row.narrator_started_at, first_word_at: row.first_word_at,
      reply_ended_at: row.reply_ended_at, done_at: row.created_at },
    calls: calls.map(call => ({ ...call, label: storyLabel(call.purpose), phase_label: storyLabel(call.phase), offset_ms: call.started_at.getTime() - dispatched.getTime() })),
    ...(!calls.length ? { legacy: true } : {}), explanation: explainStoryTurn(row, calls), cost: costBreakdown(calls),
    tokens: { prompt: calls.reduce((n, c) => n + c.prompt_tokens, 0), completion: calls.reduce((n, c) => n + c.completion_tokens, 0),
      cached: calls.reduce((n, c) => n + (c.cached_tokens ?? 0), 0), reasoning: calls.reduce((n, c) => n + (c.reasoning_tokens ?? 0), 0) },
    prompt_sections: (narrator?.prompt_sections ?? []).map(section => ({ ...section, label: storyLabel(section.name) })),
  }
}
export async function storyCallBody(id: string) {
  const body = await traceStore().bodies.findOne({ _id: new ObjectId(id) })
  // TTL deletion is asynchronous in Mongo; do not serve an already-expired row.
  if (!body || body.created_at.getTime() + BODY_TTL_SECONDS * 1000 <= Date.now()) return null
  return { request: body.request, response: body.response, expires_at: new Date(body.created_at.getTime() + BODY_TTL_SECONDS * 1000) }
}
const percentile = (values: number[], q: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const at = (sorted.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)
}
function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const name = key(row), group = groups.get(name)
    if (group) group.push(row)
    else groups.set(name, [row])
  }
  return groups
}
export async function storySummary(days: number) {
  await ensureStoryEngineLogIndexes()
  const since = new Date(Date.now() - days * 86400000)
  const [turns, calls] = await Promise.all([
    logs().find({ created_at: { $gte: since } }, { projection: { instance_id: 1, sequence: 1, created_at: 1, end_to_end_ttft_ms: 1, post_stream_ms: 1, turn_cost_usd: 1 } }).toArray(),
    traceStore().calls.find({ created_at: { $gte: since } }).toArray(),
  ])
  const daily = [...groupBy(turns, row => row.created_at.toISOString().slice(0, 10))].sort(([a], [b]) => a.localeCompare(b))
  const backgroundCost = new Map<string, number>()
  const turnKey = (instance: ObjectId | undefined, sequence: number | undefined) => `${instance?.toHexString()}:${sequence}`
  for (const call of calls) if (call.phase === 'background') {
    const key = turnKey(call.instance_id, call.sequence)
    backgroundCost.set(key, (backgroundCost.get(key) ?? 0) + (call.cost_usd ?? 0))
  }
  const costs = turns.flatMap(turn => turn.turn_cost_usd === undefined ? []
    : [turn.turn_cost_usd + (backgroundCost.get(turnKey(turn.instance_id, turn.sequence)) ?? 0)])
  const sumCost = (rows: LLMCallDoc[]) => rows.reduce((n, c) => n + (c.cost_usd ?? 0), 0)
  const breakdown = (key: (call: LLMCallDoc) => string, field: string) => [...groupBy(calls, key)].map(([name, rows]) => ({ [field]: name, usd: sumCost(rows), calls: rows.length }))
  const hedges = calls.filter(c => c.role === 'hedge')
  const raced = calls.filter(c => c.won !== undefined)
  const errors = calls.filter(c => c.status === 'error' || c.status === 'timeout')
  return {
    first_word_daily: daily.map(([day, rows]) => { const ms = rows.flatMap(r => r.end_to_end_ttft_ms === undefined ? [] : [r.end_to_end_ttft_ms]); return { day, p50_ms: percentile(ms, .5), p90_ms: percentile(ms, .9), turns: rows.length } }),
    after_reply_daily: daily.map(([day, rows]) => { const ms = rows.flatMap(r => r.post_stream_ms === undefined ? [] : [r.post_stream_ms]); return { day, p50_ms: percentile(ms, .5), p90_ms: percentile(ms, .9) } }),
    slowest_call_types: [...groupBy(calls, c => c.purpose)].map(([purpose, rows]) => ({ purpose, label: storyLabel(purpose), p50_ms: percentile(rows.map(c => c.duration_ms), .5), p90_ms: percentile(rows.map(c => c.duration_ms), .9), calls: rows.length })).sort((a, b) => b.p90_ms - a.p90_ms).slice(0, 10),
    cost: { per_turn_p50_usd: percentile(costs, .5), per_turn_avg_usd: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0,
      total_usd: sumCost(calls), by_model: breakdown(c => c.model, 'model'), by_provider: breakdown(c => c.provider ?? 'Unknown', 'provider'), by_purpose: breakdown(c => storyLabel(c.purpose), 'label') },
    reliability: { calls: calls.length, error_rate: calls.length ? errors.length / calls.length : 0,
      retry_rate: calls.length ? calls.filter(c => c.attempts > 1).length / calls.length : 0,
      hedge_rate: calls.length ? hedges.length / calls.length : 0, hedge_win_rate: raced.length ? hedges.filter(c => c.won).length / (raced.length / 2) : 0,
      by_kind: [...groupBy(errors, c => c.error?.kind ?? 'other')].map(([kind, rows]) => ({ kind, count: rows.length })) },
  }
}
