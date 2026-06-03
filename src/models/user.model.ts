import type { ObjectId } from 'mongodb'

export type UserTier = 'free' | 'premium' | 'creator'

export interface UserPreferences {
  nsfw_enabled: boolean
  preferred_model: string
  theme: string
  narration_length: 'detailed' | string
  auto_memory_curation: boolean
  /** Genre taste from onboarding (narrative_style keys); biases discovery. */
  interests?: string[]
}

/**
 * users — one document per account (password, Google, and/or phone).
 */
export interface UserDoc {
  _id: ObjectId
  email?: string
  phone?: string
  username: string
  password_hash: string
  tier: UserTier
  providers: string[]
  google_sub?: string
  preferences: UserPreferences
  token_balance: number
  created_at: Date
  updated_at: Date
}

/** Document shape before Mongo assigns `_id` on insert. */
export type UserInsertDoc = Omit<UserDoc, '_id'>
