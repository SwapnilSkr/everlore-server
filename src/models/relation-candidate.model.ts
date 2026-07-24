import type { ObjectId } from 'mongodb'
import type { RelationKind } from '../utils/kinship-ontology'

/** A narrator-originated relationship proposal. It is deliberately NOT canon. */
export interface RelationCandidateDoc {
  _id: ObjectId
  instance_id: ObjectId
  player_id: ObjectId
  character_entity_id: ObjectId
  player_entity_id: ObjectId
  character_name: string
  relation: string
  relation_kind: RelationKind
  evidence: string
  source_event_id: ObjectId
  sequence: number
  status: 'open' | 'accepted' | 'rejected' | 'deferred' | 'superseded'
  resolved_relation?: string
  resolved_at?: Date
  created_at: Date
  updated_at: Date
}
