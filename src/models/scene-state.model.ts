import type { ObjectId } from 'mongodb'

/**
 * SCENE STATE — the authoritative model of the present moment.
 *
 * Everything else in the world model answers a question about the PAST: the
 * event ledger is what happened, the codex is who someone is, memories are what
 * is worth recalling, the location graph is what places exist. Nothing owned
 * the only question the narrator actually has to answer correctly every single
 * turn: *right now, in this room, what is true?*
 *
 * Without an owner, that answer was re-derived each turn from whatever survived
 * the recent-event window — so a released grip stayed gripped, a character who
 * walked out came back, and two people who were never in the room stood in it
 * for seven turns. This type exists so the answer has one place to live, one
 * writer, and an explicit lifetime for every claim.
 *
 * It is stored on the EVENT (`data.scene_state`) rather than in a mutable
 * per-instance document, which makes it a rebuildable projection like every
 * other derived state here: rewinding deletes events, and the previous event's
 * snapshot becomes current again with no repair step.
 */

/** Why someone is in the room. Provenance is what makes a cast list auditable
 *  — an entry nobody can justify is a hallucination, not a character. */
export type CastArrivalSource =
  /** Present in the authored opening scene. */
  | 'opening'
  /** Narrated arrival corroborated by this turn's prose. */
  | 'arrival'
  /** Travelled in with the player as a confirmed companion. */
  | 'travel_party'
  /** Already here at the end of the previous turn and nothing removed them. */
  | 'carried'

export interface SceneCastMember {
  /** Canonical entity row. Null only for a witnessed walk-on with no entity yet. */
  entity_id?: ObjectId | null
  /** Display name, always the canonical form when one is known. */
  name: string
  /** Turn this person entered the CURRENT scene (reset by a scene break). */
  since_sequence: number
  source: CastArrivalSource
}

/**
 * A physical configuration that persists until something ends it.
 *
 * This is the track the system was missing entirely. Physical facts lived only
 * in prose and in accreted `mutable_state` strings that no event ever closed —
 * so "pinned against the wall" outlived the release that ended it, because a
 * FIFO cap is not a story event. Here a fact is opened by a narrated action and
 * closed by a narrated action, and it is closed automatically when an actor
 * leaves, because you cannot hold someone who is not in the room.
 */
export type PhysicalFactKind =
  /** One actor physically restraining/holding another (grip, pin, headlock). */
  | 'restraint'
  /** Non-restraining sustained contact (embrace, hand held, carried). */
  | 'contact'
  /** A sustained body position (kneeling, seated at the head of the table). */
  | 'posture'
  /** An object actively held or wielded (blade drawn, letter in hand). */
  | 'held'

export interface PhysicalFact {
  kind: PhysicalFactKind
  /** Free-text, story-facing summary ("Aurelius has Cedric by the collar"). */
  statement: string
  /** Entity/display names of everyone the fact binds. A fact whose actor leaves
   *  the scene is closed, so this must name real cast members. */
  actors: string[]
  since_sequence: number
}

export interface SceneStateDoc {
  as_of_sequence: number
  place: {
    entity_id?: ObjectId | null
    name: string
  } | null
  cast: SceneCastMember[]
  physical: PhysicalFact[]
  /** True when this turn began a new scene (move, time skip, explicit exit), so
   *  consumers know the cast was reset rather than carried. */
  scene_broke: boolean
}

/** A rejected claim, kept for the anomaly log. */
export interface SceneContradiction {
  kind:
    | 'arrival_of_present'
    | 'departure_of_absent'
    | 'physical_actor_absent'
    | 'uncorroborated_arrival'
  details: string
}
