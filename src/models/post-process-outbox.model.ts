import type { ObjectId } from 'mongodb'

/** Durable follow-up work created alongside a canonical story event. */
export type PostProcessKind = 'memory_curation' | 'scene_summary' | 'projection_checkpoint' | 'character_projection'
export type PostProcessStatus = 'pending' | 'dispatched' | 'completed' | 'failed'

export interface PostProcessOutboxDoc {
  _id: ObjectId
  instance_id: ObjectId
  player_id: ObjectId
  event_id: ObjectId
  kind: PostProcessKind
  payload: Record<string, unknown>
  status: PostProcessStatus
  dispatch_attempts: number
  next_attempt_at: Date
  dispatched_at?: Date
  completed_at?: Date
  last_error?: string
  created_at: Date
  updated_at: Date
}
