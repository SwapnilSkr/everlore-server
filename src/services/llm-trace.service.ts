import { ObjectId, type Collection } from 'mongodb'
import * as mongo from '../config/mongo'
import type { LLMCallDoc, LLMCallBodyDoc, LLMTraceRecord } from '../models/llm-call.model'
import { runWithLLMTrace, snapshotLLMTrace, type LLMTraceScope } from '../ai/usage'
import { log } from '../utils/logger'

export const BODY_TTL_SECONDS = 604800
export const TRACE_COLLECTION = 'llm_calls'
export const BODY_COLLECTION = 'llm_call_bodies'
export interface TraceStore {
  calls: Collection<LLMCallDoc>
  bodies: Collection<LLMCallBodyDoc>
}
export function traceStore(): TraceStore {
  return { calls: mongo.coll<LLMCallDoc>(TRACE_COLLECTION), bodies: mongo.coll<LLMCallBodyDoc>(BODY_COLLECTION) }
}
let logIndexes: Promise<unknown> | undefined
export function ensureStoryEngineLogIndexes(): Promise<unknown> {
  return logIndexes ??= Promise.all([
    mongo.coll('generation_logs').createIndex({ created_at: -1, _id: -1 }),
    mongo.coll('generation_logs').createIndex({ instance_id: 1, sequence: 1 }),
  ]).catch(error => { logIndexes = undefined; throw error })
}
let indexes: Promise<unknown> | undefined
function ensureIndexes(store: TraceStore): Promise<unknown> {
  return indexes ??= Promise.all([
    ensureStoryEngineLogIndexes(),
    store.calls.createIndex({ instance_id: 1, sequence: 1 }),
    store.calls.createIndex({ created_at: -1 }),
    store.calls.createIndex({ purpose: 1, created_at: -1 }),
    store.calls.createIndex({ model: 1, created_at: -1 }),
    store.bodies.createIndex({ created_at: 1 }, { expireAfterSeconds: BODY_TTL_SECONDS }),
  ]).catch(error => { indexes = undefined; throw error })
}

/** The marker is inside the cap. Head and tail share its small overhead. */
export function truncateTraceText(text: string, cap = 8000): { content: string; truncated_chars?: number } {
  if (text.length <= cap) return { content: text }
  let cut = text.length - cap
  let marker = `[… ${cut} chars cut …]`
  // Marker length depends on the count; converge before slicing.
  for (let i = 0; i < 4; i++) { cut = text.length - cap + marker.length; marker = `[… ${cut} chars cut …]` }
  const tail = Math.min(2000, cap - marker.length)
  return { content: text.slice(0, cap - marker.length - tail) + marker + text.slice(-tail), truncated_chars: cut }
}
export function buildTraceBody(record: LLMTraceRecord, sequence?: number): LLMCallBodyDoc {
  const request: LLMCallBodyDoc['request'] = []
  const omitted = '[… remaining request messages omitted …]'
  let remaining = 48000
  for (let i = 0; i < record.request.length; i++) {
    const message = record.request[i]
    const text = truncateTraceText(message.content)
    const reserve = i < record.request.length - 1 ? omitted.length : 0
    if (text.content.length > remaining - reserve) {
      request.push({ role: 'system', content: omitted })
      break
    }
    request.push({ role: message.role, ...text })
    remaining -= text.content.length
  }
  return { _id: record.call._id,
    ...(record.call.instance_id ? { instance_id: record.call.instance_id } : {}),
    ...(sequence !== undefined ? { sequence } : record.call.sequence !== undefined ? { sequence: record.call.sequence } : {}),
    request, response: truncateTraceText(record.response).content, created_at: record.call.created_at }
}
export function prepareTraceFlush(records: LLMTraceRecord[], sequence?: number, narratorStartedAt?: Date) {
  const narratorStart = narratorStartedAt?.getTime()
    ?? records.find(r => r.call.purpose === 'narration')?.call.started_at.getTime()
  return records.map(record => {
    const call: LLMCallDoc = { ...record.call,
      ...(sequence !== undefined ? { sequence } : {}),
      phase: record.call.phase === 'background' ? 'background' : record.call.purpose === 'narration' ? 'reply'
        : narratorStart === undefined || record.call.started_at.getTime() < narratorStart ? 'before_reply' : 'after_reply',
    }
    return { call, body: buildTraceBody({ ...record, call }, sequence) }
  })
}
export function traceLogFields(records: LLMTraceRecord[]) {
  const calls = records.filter(r => r.call.phase !== 'background').map(r => r.call)
  return { turn_cost_usd: calls.reduce((sum, call) => sum + (call.cost_usd ?? 0), 0), call_count: calls.length,
    failed_call_count: calls.filter(call => call.status === 'error' || call.status === 'timeout').length }
}
export async function flushLLMTraces(records: LLMTraceRecord[], sequence?: number, narratorStartedAt?: Date, providedStore?: TraceStore): Promise<void> {
  if (!records.length) return
  const store = providedStore ?? traceStore()
  await ensureIndexes(store)
  const rows = prepareTraceFlush(records, sequence, narratorStartedAt)
  // has_body means a body really was written, even if its TTL has since expired.
  await store.bodies.insertMany(rows.map(row => row.body), { ordered: false })
  await store.calls.insertMany(rows.map(row => row.call), { ordered: false })
}
const scheduled = new WeakSet<LLMTraceRecord>()
export function flushLLMTracesLater(records: LLMTraceRecord[], sequence?: number, narratorStartedAt?: Date, store?: TraceStore): void {
  const pending = records.filter(record => !scheduled.has(record))
  if (!pending.length) return
  pending.forEach(record => scheduled.add(record))
  void flushLLMTraces(pending, sequence, narratorStartedAt, store).catch(() => log.warn('llm_trace.flush_failed'))
}

/** Jobs resolve the triggering event once, off the player's path. Detached
 * projection invocations also enter here so they cannot leak into a turn scope. */
export async function runBackgroundLLMTrace<T>(scope: LLMTraceScope & { event_id?: string }, fn: () => Promise<T>): Promise<T> {
  let sequence = scope.sequence
  let player = scope.player_id
  if (scope.event_id && ObjectId.isValid(scope.event_id)) {
    try {
      const event = await mongo.mongoColl.events().findOne({ _id: new ObjectId(scope.event_id) }, { projection: { sequence: 1, player_id: 1 } })
      sequence ??= event?.sequence
      player ??= event?.player_id
    } catch {
      log.warn('llm_trace.scope_lookup_failed')
    }
  }
  return runWithLLMTrace({ ...scope, player_id: player, sequence, background: true }, async () => {
    try { return await fn() } finally { flushLLMTracesLater(snapshotLLMTrace()) }
  })
}
