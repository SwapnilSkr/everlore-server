import type { ObjectId } from 'mongodb'

export type PersonaGender = 'male' | 'female' | 'non_binary'

export interface PersonaSnapshotDoc {
  name: string
  gender: PersonaGender
  age?: number | null
  description?: string
  other_info?: string
}

export interface PersonaDoc extends PersonaSnapshotDoc {
  _id: ObjectId
  player_id: ObjectId
  created_at: Date
  updated_at: Date
}
