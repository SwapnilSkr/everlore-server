import type { ObjectId } from 'mongodb'
import type { PersonaSnapshotDoc } from './persona.model'

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
  /** Narration person, toggleable in chat. Worlds start in third person. */
  narration_pov?: 'first' | 'third'
  /** Chat MODE (see chat-modes.ts) — how the chat flows (pacing/intent).
   *  Player-chosen per conversation. Default 'free_play'. (Narrative voice is
   *  creator-locked on the template and is NOT stored here.) */
  mode?: string
  /** Desired reply length: 'short' | 'medium' | 'long'. Default 'medium'. */
  message_length?: 'short' | 'medium' | 'long'
  /** Optional focused side-character for character-targeted conversation. */
  focus_character_id?: ObjectId | null
  /** Optional reusable account-level persona selected for this instance. */
  persona_id?: ObjectId | null
  /** Snapshot of the selected persona, so long-running chats do not drift when
   *  the reusable persona is later edited. */
  persona_snapshot?: PersonaSnapshotDoc | null
  meta: InstanceMetaDoc
  created_at: Date
  updated_at: Date
}
