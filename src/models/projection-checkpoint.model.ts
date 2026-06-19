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
