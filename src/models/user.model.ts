import type { ObjectId } from 'mongodb'

export type UserTier = 'free' | 'premium' | 'creator'
export type UserAccountStatus = 'active' | 'banned'

export type PlayerGender = 'male' | 'female' | 'non_binary'

export interface UserPreferences {
  nsfw_enabled: boolean
  preferred_model: string
  theme: string
  narration_length: 'detailed' | string
  auto_memory_curation: boolean
  /** Display name chosen during post-auth onboarding. */
  player_name?: string
  /** Optional gender from onboarding; unset when skipped (neutral avatar). */
  gender?: PlayerGender
  /** Genre taste from onboarding (narrative_style keys); biases discovery. */
  interests?: string[]
  /**
   * Guide arcs this account has already been shown, keyed by flow id.
   *
   * The account is the source of truth: it survives reinstalls, follows the
   * player between devices, and is the only place the onboarding funnel can be
   * measured. Clients keep a device cache but reconcile against this.
   */
  guide_progress?: Record<string, GuideFlowProgress>
  /** Player asked the guide to stay quiet. Honoured on every device. */
  guide_opt_out?: boolean
}

/** Where a player stands with one guide arc. */
export interface GuideFlowProgress {
  /**
   * Flow version the player actually saw. Bumping a flow's version in the app
   * replays that one arc — once — for everybody.
   */
  version: number
  /** Last beat reached, for resume and for drop-off analysis. */
  step: number
  /**
   * `seen` is written when an arc starts, not when it ends, so a crash or a
   * force-quit mid-arc can never cause it to run again.
   */
  status: 'seen' | 'skipped' | 'done'
  /** ISO timestamp of the last change. */
  at: string
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
  /** Administrative override. When present it wins over a Play entitlement. */
  admin_tier_override?: UserTier | null
  account_status?: UserAccountStatus
  banned_at?: Date
  ban_reason?: string
  providers: string[]
  google_sub?: string
  preferences: UserPreferences
  token_balance: number
  created_at: Date
  updated_at: Date
}

/** Document shape before Mongo assigns `_id` on insert. */
export type UserInsertDoc = Omit<UserDoc, '_id'>
