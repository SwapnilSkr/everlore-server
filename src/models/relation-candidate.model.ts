import type { ObjectId } from 'mongodb'
import type { RelationKind } from '../utils/kinship-ontology'

/**
 * A narrator-originated canon-review proposal. It is deliberately NOT canon:
 * the worker can point out a likely reveal, but only a player decision may
 * merge identities or rewrite a structural family tie.
 */
export type CanonRevisionKind =
  | 'kinship'
  | 'identity_rename'
  | 'identity_merge'
  | 'kinship_revision'

export interface RelationCandidateDoc {
  _id: ObjectId
  instance_id: ObjectId
  player_id: ObjectId
  character_entity_id: ObjectId
  player_entity_id: ObjectId
  character_name: string
  /** Existing rows predate this field and are normal kinship proposals. */
  kind?: CanonRevisionKind
  /** For identity reveals: the card/entity this proposal would fold into the
   * primary card. Omitted for a role → proper-name rename. */
  counterpart_entity_id?: ObjectId
  counterpart_character_name?: string
  /** The literal proper name proposed for an existing role/alias card. */
  proposed_name?: string
  /** The established kinship label this revision would replace. */
  replaces_relation?: string
  relation: string
  relation_kind?: RelationKind
  evidence: string
  source_event_id: ObjectId
  sequence: number
  status: 'open' | 'accepted' | 'rejected' | 'deferred' | 'superseded'
  resolved_relation?: string
  resolved_at?: Date
  created_at: Date
  updated_at: Date
}
