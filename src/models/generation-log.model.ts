import type { ObjectId } from 'mongodb'
import type { ProseHygieneIssue } from '../utils/prose-hygiene'
import type { LLMCallUsage } from '../ai/usage'

/**
 * Every step a turn's prep waits on, in the order the player waits for it.
 * `context_latency_ms` says a turn spent 3.6 s before the narrator; these say
 * where. All are wall-clock ms from the step's start to its settle, so
 * concurrent steps (`summaries`, mostly) can overlap each other and the sum can
 * exceed the elapsed time by that overlap.
 */
export const PREP_STAGE_KEYS = [
  'live_check',
  'fence',
  'recent_events',
  'mentions',
  'stub_wake',
  'embed_wait',
  'vector',
  'rag_mongo',
  'summaries',
  'codex',
  'packet_tail',
  'post_packet',
] as const

export type PrepStage = (typeof PREP_STAGE_KEYS)[number]
export type PrepStages = Partial<Record<PrepStage, number>>

/**
 * The post-reply tail's five concurrent model calls. Each is measured on its
 * own even though they run at the same time, so a slow `extraction_join` can
 * name the call that set its pace instead of only reporting that it was slow.
 */
export const TAIL_MODEL_CALL_STAGES = [
  'scene_witness',
  'choice_metadata',
  'entity_adjudication',
  'scene_endpoint',
  'deaths',
] as const

export type TailModelCallStage = (typeof TAIL_MODEL_CALL_STAGES)[number]

/**
 * Every step the tail takes after the last streamed token, in the order the
 * player waits for it. `post_stream_ms` says a turn spent 3.6 s after the prose;
 * these say where. Steps are wall-clock ms from start to settle, so the five
 * model calls overlap each other and `extraction_join` is their batch: the serial
 * steps plus the join are what add up, never the five individually.
 */
export const TAIL_STAGE_KEYS = [
  ...TAIL_MODEL_CALL_STAGES,
  'extraction_join',
  'interaction_signal_wait',
  'content_intent',
  'choice_audit',
  'location',
  'time',
  'presence_scene',
  'stubs',
  'event_insert',
  'post_insert',
  'session_write',
] as const

export type TailStage = (typeof TAIL_STAGE_KEYS)[number]
export type TailStages = Partial<Record<TailStage, number>>

/**
 * The gaps between the player's message and the narrator's request, which
 * `end_to_end_ttft_ms` spans but neither `context_latency_ms` (the packet) nor
 * `ttft_ms` (the host) covers. Add these to `context_latency_ms`, `ttft_ms` and
 * the prep stages outside it (`live_check`) and the whole first-word wait is
 * accounted for.
 */
export const PRE_NARRATOR_STAGE_KEYS = ['dispatch', 'queue_wait', 'job_setup', 'prompt_build'] as const

export type PreNarratorStage = (typeof PRE_NARRATOR_STAGE_KEYS)[number]
export type PreNarratorStages = Partial<Record<PreNarratorStage, number>>

/**
 * Flat integer ms, and only known stages — a stray `undefined`, a negative or a
 * float would make the row harder to aggregate than it is worth. An absent key
 * means the step did not happen; it is never written as 0, so "skipped" and
 * "instant" stay distinguishable.
 */
function buildStageMs<K extends string>(
  keys: readonly K[],
  input: Partial<Record<string, number | undefined>>,
): Partial<Record<K, number>> {
  const stages: Partial<Record<K, number>> = {}
  for (const key of keys) {
    const ms = input[key]
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) stages[key] = Math.round(ms)
  }
  return stages
}

export function buildPrepStages(input: Partial<Record<string, number | undefined>>): PrepStages {
  return buildStageMs(PREP_STAGE_KEYS, input)
}

export function buildTailStages(input: Partial<Record<string, number | undefined>>): TailStages {
  return buildStageMs(TAIL_STAGE_KEYS, input)
}

export function buildPreNarratorStages(input: Partial<Record<string, number | undefined>>): PreNarratorStages {
  return buildStageMs(PRE_NARRATOR_STAGE_KEYS, input)
}

/**
 * Which of the five concurrent calls set the pace of the join — the one to look
 * at when `extraction_join` is slow. Absent when none ran; ties go to the
 * earliest in the list, which is also the one that started first.
 */
export function slowestTailCall(
  calls: Partial<Record<TailModelCallStage, number | undefined>>,
): TailModelCallStage | undefined {
  let slowest: TailModelCallStage | undefined
  let best = -1
  for (const stage of TAIL_MODEL_CALL_STAGES) {
    const ms = calls[stage]
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) continue
    if (ms > best) {
      best = ms
      slowest = stage
    }
  }
  return slowest
}

/**
 * generation_logs — one document per narration generation. Non-blocking,
 * best-effort dev/observability record: shows which model handled each turn and
 * whether the NSFW path was taken. Not on the request critical path.
 */
export interface GenerationLogDoc {
  _id: ObjectId
  instance_id: ObjectId
  player_id: ObjectId
  sequence: number
  /** World allows mature content. */
  is_nsfw_capable: boolean
  /** Player opted into NSFW in their account preferences. */
  user_nsfw_enabled: boolean
  /** Keyword classifier verdict for this turn's input. */
  scene_classification: 'sfw' | 'nsfw'
  /** True when the uncensored NSFW model was actually selected. */
  nsfw_path: boolean
  /** Narration model that produced the prose. */
  model_used: string
  /** Primary narration model requested before any provider fallback. */
  requested_model?: string
  /** Pre-stream 429 reroutes used before the successful narration model. */
  fallback_attempts?: Array<{ from: string; to: string }>
  /** OpenRouter host that streamed the winning narration, when reported. */
  provider?: string
  /** A second narration request was sent because the first gave no word in time. */
  hedged?: boolean
  /** Which of the two requests produced the prose; absent when not hedged. */
  hedge_winner?: 'primary' | 'hedge'
  /** Model used for the structured-metadata extraction pass. */
  metadata_model: string
  tokens_in: number
  tokens_out: number
  /** Non-mutating prose hygiene findings from the streamed response. */
  prose_hygiene_issues?: ProseHygieneIssue[]
  /** Wall-clock latency of the full narration generation, milliseconds. */
  latency_ms: number
  /** Time-to-first-token: ms from request start until the first streamed delta.
   *  The latency the player actually feels. 0 if no tokens streamed. */
  ttft_ms: number
  /** Per-call provider usage captured during this turn (narration + post-stream). */
  llm_calls?: LLMCallUsage[]
  /** Time spent waiting for a generation worker after the job was enqueued. */
  queue_wait_ms?: number
  /** Worker-side context/retrieval/prompt construction before the provider call. */
  context_latency_ms?: number
  /** Of the above: ms this turn waited for the query embedding, shared flight and
   *  cache hits included. Absent on rows written before this was measured. */
  embed_ms?: number
  /** Of the above: ms the whole RAG phase took, embedding included. */
  rag_ms?: number
  /** Split of `context_latency_ms` (+ `post_packet`) by prep step, so a slow turn
   *  says WHICH read or wait owned it instead of only how long it was. */
  prep_stages?: PrepStages
  /** The gaps `end_to_end_ttft_ms` spans but prep and the host's `ttft_ms` do
   *  not: dispatch, queue, job setup and prompt assembly. */
  pre_narrator_stages?: PreNarratorStages
  /** First streamed token to the last one. */
  stream_ms?: number
  /** Last token to this log insert: event persistence and the post-stream
   *  extractions the composer waits on. */
  post_stream_ms?: number
  /** Split of the tail by step, so a slow post_stream says which extraction,
   *  write or wait owned it. The five concurrent model calls overlap; the rest
   *  are serial and add up. */
  tail_stages?: TailStages
  /** Of the above: the post-stream model call that paced the extraction join. */
  tail_slowest_call?: TailModelCallStage
  /** Full request-to-first-visible-token measurement, including dispatch and queue. */
  end_to_end_ttft_ms?: number
  created_at: Date
}
