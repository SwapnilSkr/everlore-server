import type { ObjectId } from 'mongodb'
import type { WorldFactSource } from '../utils/world-authority'
import type { PersonaSnapshotDoc } from './persona.model'
import type { TimeAnchorDoc } from './time.model'
import type { LocationAnchorDoc } from './location.model'
import type { RelationAssertion } from '../services/character-codex.service'
import type { TemplateCastCharacterDoc } from './world-template.model'

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
  /** Immutable-at-start cast copy; rewind never reads a later-edited template. */
  seed_cast_snapshot?: TemplateCastCharacterDoc[]
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
  /** Optional player override for the template's narrative voice. `null` means
   * inherit the world default; an empty string deliberately selects neutral. */
  narrative_style_override?: string | null
  /** Player-selected prose register. It layers over template genre/style without
   * changing story canon or mode pacing. See narration-tones.ts. */
  narration_tone?: string
  /** Optional focused side-character for character-targeted conversation. */
  focus_character_id?: ObjectId | null
  /** Current story-time cursor for new events. */
  current_time_anchor?: TimeAnchorDoc
  active_timeline_id?: string
  default_calendar_id?: ObjectId
  /** Current known place at the end of the latest turn. */
  current_location?: LocationAnchorDoc | null
  /** TRAVELLING-WITH party — characters who explicitly joined the player and persist
   *  across scene breaks (a move or a time skip), unlike co-located locals which
   *  reset. Opt-in only: grows on explicit join signals, cleared on explicit
   *  partings. Entity-bounded (real cards/stubs), excludes the protagonist. Empty
   *  for a solo player. See LOCATION_GRAPH.md open-world limit #2. */
  travelling_with?: Array<{
    entity_id: ObjectId
    name: string
    /** Authority of the signal that put them in the party (player narration outranks
     *  narrator prose); drives the §5 companion-brief tier. Absent on legacy rows. */
    source?: WorldFactSource
    /** [0,1] confidence derived from `source`; absent legacy rows are trusted as canon. */
    confidence?: number
  }>
  /** Explicit relationship edits from the player-facing canon controls. Unlike
   * narrated discoveries, these are authorial world settings: they do not create
   * a chat turn, and must be reapplied after premise canon on every graph rebuild. */
  manual_relation_assertions?: RelationAssertion[]
  /** Player-confirmed lifecycle/retcon revisions. Kept outside chat events so
   * a prose rewind cannot resurrect a tie the player explicitly rejected. */
  manual_lifecycle_transitions?: Array<{
    rel: string
    state: 'deceased' | 'estranged' | 'dissolved' | 'revealed_false'
  }>
  /** Player-confirmed identity reveals/merges, replayed after the event codex
   * so rewind never splits a person back into stale labels. */
  manual_identity_revisions?: Array<{
    kind: 'identity_rename' | 'identity_merge'
    source_name: string
    target_name: string
  }>
  /** Optional reusable account-level persona selected for this instance. */
  persona_id?: ObjectId | null
  /** Snapshot of the selected persona, so long-running chats do not drift when
   *  the reusable persona is later edited. */
  persona_snapshot?: PersonaSnapshotDoc | null
  meta: InstanceMetaDoc
  created_at: Date
  updated_at: Date
}
