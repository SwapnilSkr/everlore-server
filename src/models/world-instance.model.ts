import type { ObjectId } from 'mongodb'

export interface InstanceMetaDoc {
  total_events: number
  total_memories: number
  total_tokens_consumed: number
  last_active_at: Date
  is_archived: boolean
}

export interface CurrentSceneDoc {
  tag: string
  turn_count: number
  summary_pending: boolean
}

/**
 * world_instances — a player's save for one published template.
 */
export interface WorldInstanceDoc {
  _id: ObjectId
  template_id: ObjectId
  template_version: number
  player_id: ObjectId
  world_state: Record<string, number>
  active_flags: Record<string, unknown>
  current_scene: CurrentSceneDoc
  meta: InstanceMetaDoc
  created_at: Date
  updated_at: Date
}
