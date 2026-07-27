import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import type { UserTier } from '../models/user.model'
import { HttpError } from '../utils/http-error'
import { parseObjectId } from '../utils/mongo-id'
import { env } from '../config/env'
import { googlePlayService, type VerifiedGooglePurchase } from './google-play.service'

const ledger = () => mongoColl.inkLedger()
const entitlements = () => mongoColl.billingEntitlements()
const purchases = () => mongoColl.storePurchases()
const users = () => mongoColl.users()

export const BILLING_CATALOG = {
  premium: {
    tier: 'premium' as const,
    monthly_ink: 3000,
    daily_story_safety_cap: 160,
  },
  creator: {
    tier: 'creator' as const,
    monthly_ink: 6000,
    daily_story_safety_cap: 320,
  },
  free: {
    tier: 'free' as const,
    monthly_ink: 60,
    daily_story_safety_cap: 25,
  },
  welcome_ink: 180,
  costs: {
    story_turn: 1,
    character_autofill: 12,
    world_autofill: 20,
    image_preview: 45,
  },
} as const

const PLAY_PRODUCTS = {
  everlore_premium: { kind: 'subscription' as const, tier: 'premium' as const },
  everlore_creator: { kind: 'subscription' as const, tier: 'creator' as const },
  everlore_ink_100: { kind: 'consumable' as const, ink: 100 },
  everlore_ink_350: { kind: 'consumable' as const, ink: 350 },
  everlore_ink_900: { kind: 'consumable' as const, ink: 900 },
} as const

export type BillableAction = keyof typeof BILLING_CATALOG.costs

function profileFor(tier: string) {
  return BILLING_CATALOG[tier as keyof Pick<typeof BILLING_CATALOG, 'free' | 'premium' | 'creator'>]
    || BILLING_CATALOG.free
}

async function balanceFor(playerId: ObjectId): Promise<number> {
  const [row] = await ledger().aggregate<{ balance: number }>([
    { $match: { player_id: playerId } },
    { $group: { _id: null, balance: { $sum: '$delta' } } },
  ]).toArray()
  return row?.balance ?? 0
}

export const billingService = {
  catalog() {
    // Prices live only in Play Console. This is deliberately entitlement and
    // allowance metadata, never a client-side price source.
    return { ...BILLING_CATALOG, purchases_enabled: googlePlayService.configured(), products: PLAY_PRODUCTS }
  },

  async ensureWelcomeInk(playerId: string) {
    const playerOid = parseObjectId(playerId)
    await ledger().updateOne(
      { player_id: playerOid, idempotency_key: 'welcome:v1' },
      {
        $setOnInsert: {
          _id: new ObjectId(),
          player_id: playerOid,
          delta: BILLING_CATALOG.welcome_ink,
          reason: 'welcome',
          idempotency_key: 'welcome:v1',
          created_at: new Date(),
        },
      },
      { upsert: true },
    )
  },

  async wallet(playerId: string, fallbackTier: string) {
    await this.ensureWelcomeInk(playerId)
    const playerOid = parseObjectId(playerId)
    const now = new Date()
    const active = await entitlements().findOne({
      player_id: playerOid,
      active: true,
      $or: [{ expires_at: { $exists: false } }, { expires_at: { $gt: now } }],
    })
    const tier = active?.tier || (fallbackTier as UserTier)
    return {
      tier,
      balance: await balanceFor(playerOid),
      profile: profileFor(tier),
      entitlement: active
        ? {
            product_id: active.product_id,
            base_plan_id: active.base_plan_id ?? null,
            expires_at: active.expires_at ?? null,
          }
        : null,
    }
  },

  async reserve(playerId: string, action: BillableAction, requestId: string) {
    const cost = BILLING_CATALOG.costs[action]
    if (!requestId.trim()) throw new HttpError(400, 'A billing request id is required')
    if (!env.BILLING_ENFORCEMENT_ENABLED) {
      return { reservation_id: null, cost: 0, balance: null }
    }
    await this.ensureWelcomeInk(playerId)
    const playerOid = parseObjectId(playerId)
    const key = `reserve:${action}:${requestId}`
    const already = await ledger().findOne({ player_id: playerOid, idempotency_key: key })
    if (already) return { reservation_id: key, cost, balance: await balanceFor(playerOid) }

    // Mongo's single-document conditional update would require a materialized
    // balance; the ledger is intentionally authoritative. The generation lock
    // already serializes story requests per instance, while forge calls are
    // rate-limited. This balance check is followed by a unique idempotency write.
    const balance = await balanceFor(playerOid)
    if (balance < cost) throw new HttpError(402, 'Not enough Story Ink')
    try {
      await ledger().insertOne({
        _id: new ObjectId(),
        player_id: playerOid,
        delta: -cost,
        reason: 'reserve',
        idempotency_key: key,
        reference: action,
        created_at: new Date(),
      })
    } catch (error: any) {
      if (error?.code !== 11000) throw error
    }
    return { reservation_id: key, cost, balance: await balanceFor(playerOid) }
  },

  async release(playerId: string, reservationId: string | null) {
    if (!reservationId || !env.BILLING_ENFORCEMENT_ENABLED) return
    const playerOid = parseObjectId(playerId)
    const reservation = await ledger().findOne({ player_id: playerOid, idempotency_key: reservationId })
    if (!reservation || reservation.delta >= 0) return
    await ledger().updateOne(
      { player_id: playerOid, idempotency_key: `release:${reservationId}` },
      {
        $setOnInsert: {
          _id: new ObjectId(),
          player_id: playerOid,
          delta: -reservation.delta,
          reason: 'release',
          idempotency_key: `release:${reservationId}`,
          reference: reservationId,
          created_at: new Date(),
        },
      },
      { upsert: true },
    )
  },

  async settle(playerId: string, reservationId: string | null) {
    if (!reservationId || !env.BILLING_ENFORCEMENT_ENABLED) return
    const playerOid = parseObjectId(playerId)
    const reservation = await ledger().findOne({ player_id: playerOid, idempotency_key: reservationId })
    if (!reservation || reservation.delta >= 0) return
    await ledger().updateOne(
      { player_id: playerOid, idempotency_key: `settle:${reservationId}` },
      {
        $setOnInsert: {
          _id: new ObjectId(), player_id: playerOid, delta: 0, reason: 'settle',
          idempotency_key: `settle:${reservationId}`, reference: reservationId, created_at: new Date(),
        },
      },
      { upsert: true },
    )
  },

  async verifyGooglePurchase(playerId: string, input: { product_id: string; purchase_token: string; kind: 'subscription' | 'consumable' }) {
    const configured = PLAY_PRODUCTS[input.product_id as keyof typeof PLAY_PRODUCTS]
    if (!configured || configured.kind !== input.kind) throw new HttpError(400, 'Unknown Everlore product')
    const verified = await googlePlayService.verify({
      productId: input.product_id,
      purchaseToken: input.purchase_token,
      kind: input.kind,
    })
    return this.applyVerifiedPurchase(playerId, verified)
  },

  async syncGoogleNotification(input: { product_id: string; purchase_token: string; kind: 'subscription' | 'consumable' }) {
    const record = await purchases().findOne({ provider: 'google_play', purchase_token: input.purchase_token })
    // The client is still responsible for first-time attribution. RTDN becomes
    // authoritative after that, and never guesses which Everlore account owns a token.
    if (!record) return { accepted: true, linked: false }
    const verified = await googlePlayService.verify({
      productId: input.product_id,
      purchaseToken: input.purchase_token,
      kind: input.kind,
    })
    await this.applyVerifiedPurchase(record.player_id.toString(), verified)
    return { accepted: true, linked: true }
  },

  async applyVerifiedPurchase(playerId: string, verified: VerifiedGooglePurchase) {
    const playerOid = parseObjectId(playerId)
    const product = PLAY_PRODUCTS[verified.productId as keyof typeof PLAY_PRODUCTS]
    if (!product) throw new HttpError(400, 'Unknown Everlore product')
    const existing = await purchases().findOne({ provider: 'google_play', purchase_token: verified.purchaseToken })
    if (existing && existing.player_id.toString() !== playerOid.toString()) {
      throw new HttpError(409, 'This Google Play purchase belongs to another Everlore account')
    }

    await purchases().updateOne(
      { provider: 'google_play', purchase_token: verified.purchaseToken },
      {
        $set: {
          player_id: playerOid,
          product_id: verified.productId,
          base_plan_id: verified.kind === 'subscription' ? verified.basePlanId : undefined,
          status: verified.active ? 'active' : 'revoked',
          updated_at: new Date(),
        },
        $setOnInsert: { _id: new ObjectId(), provider: 'google_play', purchase_token: verified.purchaseToken, created_at: new Date() },
      },
      { upsert: true },
    )

    if (verified.kind === 'consumable') {
      const grant = (product as { ink: number }).ink
      await ledger().updateOne(
        { player_id: playerOid, idempotency_key: `purchase:${verified.purchaseToken}` },
        {
          $setOnInsert: {
            _id: new ObjectId(), player_id: playerOid, delta: grant, reason: 'purchase',
            idempotency_key: `purchase:${verified.purchaseToken}`, reference: verified.productId, created_at: new Date(),
          },
        },
        { upsert: true },
      )
      await googlePlayService.consume(verified.productId, verified.purchaseToken)
      await purchases().updateOne(
        { provider: 'google_play', purchase_token: verified.purchaseToken },
        { $set: { status: 'consumed', updated_at: new Date() } },
      )
      return this.wallet(playerId, 'free')
    }

    const tier = (product as { tier: UserTier }).tier
    const profile = profileFor(tier)
    await entitlements().updateOne(
      { player_id: playerOid, source: 'google_play', product_id: verified.productId },
      {
        $set: {
          tier, active: verified.active, product_id: verified.productId,
          base_plan_id: verified.basePlanId, expires_at: verified.expiresAt, updated_at: new Date(),
        },
        $setOnInsert: { _id: new ObjectId(), player_id: playerOid, source: 'google_play', created_at: new Date() },
      },
      { upsert: true },
    )
    await users().updateOne({ _id: playerOid }, { $set: { tier: verified.active ? tier : 'free', updated_at: new Date() } })
    if (verified.active) {
      const cycle = verified.expiresAt?.toISOString() || 'active'
      await ledger().updateOne(
        { player_id: playerOid, idempotency_key: `subscription:${verified.purchaseToken}:${cycle}` },
        {
          $setOnInsert: {
            _id: new ObjectId(), player_id: playerOid, delta: profile.monthly_ink,
            reason: 'subscription_cycle', idempotency_key: `subscription:${verified.purchaseToken}:${cycle}`,
            reference: verified.productId, created_at: new Date(),
          },
        },
        { upsert: true },
      )
      await googlePlayService.acknowledgeSubscription(verified.productId, verified.purchaseToken)
    }
    return this.wallet(playerId, tier)
  },
}
