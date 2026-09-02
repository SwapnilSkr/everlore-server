import type { ObjectId } from 'mongodb'

/**
 * projection_anomalies — a lightweight observability log of places where the
 * post-stream projection of a turn looks INCONSISTENT (a person in the prose with
 * no presence/codex/stub; a kinship phrase with no edge; a choice referencing an
 * absent entity; a place phrase with no anchor; a private side-chat fact that
 * leaked into public context; a codex card minted with no prose anchor; an orphan
 * dormant stub). These never block a turn — they are written fire-and-forget on the
 * tail so a debug/admin surface can spot systematic extraction drift over time.
 */
export type ProjectionAnomalyType =
  | 'prose_person_untracked'
  | 'kinship_phrase_no_edge'
  | 'choice_ungrounded'
  | 'location_phrase_no_anchor'
  | 'private_fact_leak'
  | 'card_without_prose_anchor'
  | 'orphan_dormant_stub'
  /** A projection pass threw. Until this existed, a crashed pass left the world
   *  frozen at the last good turn with NOTHING logged anywhere — the story kept
   *  advancing on state everyone believed was current. */
  | 'projection_failed'
  /** Two entity rows claim one identity, so the converging write cannot land. */
  | 'identity_collision'
  /** The turn generated against a previous turn whose projection never completed. */
  | 'stale_scene_state'
  /** Scene state was told something impossible: an arrival for someone already
   *  present, a departure for someone absent, a physical fact naming an absent
   *  actor. The claim is rejected, not folded in. */
  | 'scene_contradiction'

export type ProjectionAnomalySeverity = 'info' | 'warn' | 'error'

export interface ProjectionAnomalyDoc {
  _id: ObjectId
  instance_id: ObjectId
  player_id: ObjectId
  event_id: ObjectId | null
  sequence: number
  type: ProjectionAnomalyType
  severity: ProjectionAnomalySeverity
  /** Short human-readable specifics (the offending name/phrase/term). */
  details: string
  created_at: Date
  /** Set when a later repair (rewind/edit/replay) resolved the inconsistency. */
  resolved_at?: Date | null
}
