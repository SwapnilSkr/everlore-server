import type { ObjectId } from 'mongodb'

export type ProjectionCheckpointKind = 'world_projection'
export type ProjectionCheckpointStatus = 'building' | 'active' | 'failed'
export type ProjectionCheckpointChunkKind =
  | 'characters'
  | 'entities'
  | 'entity_edges'
  | 'world_instance'

export interface ProjectionCheckpointDoc {
  _id: ObjectId
  instance_id: ObjectId
  player_id: ObjectId
  sequence: number
  kind: ProjectionCheckpointKind
  status: ProjectionCheckpointStatus
  counts: {
    characters: number
    entities: number
    entity_edges: number
  }
  /** Instance state captured at this checkpoint's sequence so suffix-replay
   *  (memory.service replay/select + rewind) can resume from the checkpoint
   *  rather than scanning every prior turn. Optional for checkpoints written
   *  before this field existed; callers fall back to a full replay then. */
  instance_state?: {
    world_state: Record<string, number>
    active_flags: Record<string, unknown>
    current_scene?: unknown
    current_location?: unknown
    current_time_anchor?: unknown
  }
  created_at: Date
  completed_at?: Date
  error?: string
}

export interface ProjectionCheckpointChunkDoc {
  _id: ObjectId
  checkpoint_id: ObjectId
  instance_id: ObjectId
  sequence: number
  kind: ProjectionCheckpointChunkKind
  index: number
  docs: unknown[]
  created_at: Date
}
