import type { ObjectId } from 'mongodb'
import type { UserTier } from './user.model'

/** Immutable money/usage record. Balances are always derived from this ledger. */
export interface InkLedgerDoc {
  _id: ObjectId
  player_id: ObjectId
  delta: number
  reason: 'welcome' | 'subscription_cycle' | 'purchase' | 'reserve' | 'settle' | 'release' | 'adjustment'
  idempotency_key: string
  reference?: string
  created_at: Date
}

/** Current paid access; Play purchase state will be the authoritative writer. */
export interface BillingEntitlementDoc {
  _id: ObjectId
  player_id: ObjectId
  tier: UserTier
  source: 'google_play' | 'manual'
  product_id: string
  base_plan_id?: string
  active: boolean
  expires_at?: Date
  updated_at: Date
  created_at: Date
}

/** An idempotency boundary around a Google Play purchase token. */
export interface StorePurchaseDoc {
  _id: ObjectId
  provider: 'google_play'
  purchase_token: string
  player_id: ObjectId
  product_id: string
  base_plan_id?: string
  status: 'pending_verification' | 'active' | 'consumed' | 'revoked'
  order_id?: string
  created_at: Date
  updated_at: Date
}

/**
 * Administrator-owned billing settings, replacing what used to be compile-time
 * constants.
 *
 * Tier allowances and action costs were fixed in code, so changing what a free
 * player gets meant a deploy — too slow for a decision that is commercial
 * rather than technical, and impossible to make for one account. This document
 * holds the current values; anything absent falls back to the constants in
 * `billing.service.ts`, so a missing or partial document can never leave the
 * server without a price list.
 *
 * There is exactly one, at `_id: 'singleton'`.
 */
export interface BillingTierProfileDoc {
  monthly_ink: number
  daily_story_safety_cap: number
}

export interface BillingConfigDoc {
  _id: string
  tiers?: Partial<Record<UserTier, Partial<BillingTierProfileDoc>>>
  welcome_ink?: number
  costs?: Partial<Record<'story_turn' | 'character_autofill' | 'world_autofill' | 'image_preview', number>>
  updated_at?: Date
  updated_by?: string
}
