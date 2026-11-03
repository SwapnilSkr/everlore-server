import type { ObjectId } from 'mongodb'
import type { RelationshipMeters } from './character-profile.model'

export interface GroupBondChangeDoc {
  _id: ObjectId
  instance_id: ObjectId
  player_id: ObjectId
  character_id: ObjectId
  reason: 'chat' | 'player_set'
  sequence: number
  batch_end_sequence: number
  thread?: string
  adult: boolean
  deltas?: Partial<RelationshipMeters>
  set?: Partial<RelationshipMeters>
  evidence: string
  created_at: Date
}
