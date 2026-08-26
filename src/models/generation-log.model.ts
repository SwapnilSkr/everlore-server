import type { ObjectId } from 'mongodb'
import type { ProseHygieneIssue } from '../utils/prose-hygiene'

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
  /** Time spent waiting for a generation worker after the job was enqueued. */
  queue_wait_ms?: number
  /** Worker-side context/retrieval/prompt construction before the provider call. */
  context_latency_ms?: number
  /** Full request-to-first-visible-token measurement, including dispatch and queue. */
  end_to_end_ttft_ms?: number
  created_at: Date
}
