import type { ObjectId } from 'mongodb'
import type { PersonaSnapshotDoc } from './persona.model'
import type { TimeAnchorDoc } from './time.model'
import type { LocationAnchorDoc } from './location.model'

export interface InstanceMilestoneDoc {
  label: string
  sequence: number
  at: Date
}

export interface InstanceMetaDoc {
  total_events: number
  total_memories: number
  total_tokens_consumed: number
  last_active_at: Date
  is_archived: boolean
  /** Story landmarks crossed (brass seals), most recent last. Capped at 50. */
  milestones?: InstanceMilestoneDoc[]
  /** Sequence of the last fate-seeded tick beat — enforces the anti-nag cooldown. */
  last_fate_seed_sequence?: number
  /** Latest scheduled continuity (drift) audit result — detection only, written
   *  by the `drift_audit` maintenance task. Lets an admin see projection drift
   *  without re-running the audit. */
  last_continuity_audit?: {
    healthy: boolean
    summary: { ok: number; warn: number; fail: number }
    max_sequence: number
    issues: Array<{ name: string; status: string; detail: string }>
    checked_at: Date
  }
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
  /** Current story-time cursor for new events. */
  current_time_anchor?: TimeAnchorDoc
  active_timeline_id?: string
  default_calendar_id?: ObjectId
  /** Current known place at the end of the latest turn. */
  current_location?: LocationAnchorDoc | null
  /** Optional reusable account-level persona selected for this instance. */
  persona_id?: ObjectId | null
  /** Snapshot of the selected persona, so long-running chats do not drift when
   *  the reusable persona is later edited. */
  persona_snapshot?: PersonaSnapshotDoc | null
  meta: InstanceMetaDoc
  created_at: Date
  updated_at: Date
}
