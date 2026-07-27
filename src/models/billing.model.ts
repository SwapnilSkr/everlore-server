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
