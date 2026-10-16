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
  /** The player's own face, painted on tap; follows the persona across worlds. */
  portrait?: import('./media.model').PortraitRef
  /** One face per world art style, keyed by narrative_style key. The legacy
   *  single `portrait` above reads as the painted-default entry; no migration. */
  portraits?: Record<string, import('./media.model').PortraitRef>
  /** Style key of the most recently painted non-default face: the style a
   *  save-less "give yourself a face" paints. Absent means painted default. */
  last_art_style?: string
  appearance_version?: number
  created_at: Date
  updated_at: Date
}
