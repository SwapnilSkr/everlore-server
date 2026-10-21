import { env } from '../config/env'
import { mongoColl } from '../config/mongo'
import type { BillingConfigDoc } from '../models/billing.model'
import type { UserTier } from '../models/user.model'
import { BILLING_CATALOG } from './billing-catalog'
import { HttpError } from '../utils/http-error'
import { log } from '../utils/logger'

const SINGLETON = 'singleton'
const TIERS = ['free', 'premium', 'creator'] as const
const COST_KEYS = ['story_turn', 'character_autofill', 'world_autofill', 'image_preview'] as const

export type TierProfile = { monthly_ink: number; daily_story_safety_cap: number }
export type EffectiveBilling = {
  tiers: Record<(typeof TIERS)[number], TierProfile>
  promo: { unlimited: boolean; daily_turn_cap: number; source: 'config' | 'env'; updated_at: Date | null; updated_by: string | null }
  welcome_ink: number
  costs: Record<(typeof COST_KEYS)[number], number>
}

/** Per-account limits, any subset. Absent keys fall through to the tier. */
export type UserBillingOverrides = Partial<TierProfile>

/**
 * The admin-set values, cached briefly.
 *
 * `reserve()` reads this on every story turn, so it cannot be a database round
 * trip each time; it also must not be cached for the life of the process, or an
 * administrator would change a limit and watch nothing happen until the next
 * deploy. A few seconds is the useful middle: fast enough that a change feels
 * immediate, short enough that the API and the worker cannot disagree for long.
 */
const CACHE_TTL_MS = 5_000
let cache: { value: EffectiveBilling; at: number } | null = null

function fallback(): EffectiveBilling {
  return {
    tiers: {
      free: { ...BILLING_CATALOG.free },
      premium: { ...BILLING_CATALOG.premium },
      creator: { ...BILLING_CATALOG.creator },
    },
    promo: { unlimited: env.INK_PROMO_UNLIMITED, daily_turn_cap: env.INK_PROMO_DAILY_TURN_CAP, source: 'env', updated_at: null, updated_by: null },
    welcome_ink: BILLING_CATALOG.welcome_ink,
    costs: { ...BILLING_CATALOG.costs },
  }
}

export function mergeBillingConfig(doc: BillingConfigDoc | null): EffectiveBilling {
  const base = fallback()
  if (!doc) return base
  if (doc.promo) base.promo = { ...doc.promo, source: 'config', updated_at: doc.updated_at ?? null, updated_by: doc.updated_by ?? null }
  for (const tier of TIERS) {
    const stored = doc.tiers?.[tier]
    if (!stored) continue
    if (typeof stored.monthly_ink === 'number') base.tiers[tier].monthly_ink = stored.monthly_ink
    if (typeof stored.daily_story_safety_cap === 'number') {
      base.tiers[tier].daily_story_safety_cap = stored.daily_story_safety_cap
    }
  }
  if (typeof doc.welcome_ink === 'number') base.welcome_ink = doc.welcome_ink
  for (const key of COST_KEYS) {
    const value = doc.costs?.[key]
    if (typeof value === 'number') base.costs[key] = value
  }
  return base
}

export async function effectiveBilling(): Promise<EffectiveBilling> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value
  try {
    const doc = await mongoColl.billingConfig().findOne({ _id: SINGLETON })
    const value = mergeBillingConfig(doc)
    cache = { value, at: now }
    return value
  } catch (error) {
    // A configuration read must never take the money path down with it: the
    // compiled-in catalog is a complete, valid price list on its own.
    log.error('billing config read failed, using built-in catalog', {
      error: error instanceof Error ? error.message : String(error),
    })
    return cache?.value || fallback()
  }
}

/**
 * The limits that actually apply to one account.
 *
 * Precedence is per-account override, then the administrator's tier default,
 * then the compiled-in constant — narrowest wins, so a single tester can be
 * lifted without moving everyone on their tier.
 */
export function resolveProfile(
  config: EffectiveBilling,
  tier: string,
  overrides?: UserBillingOverrides | null,
): TierProfile {
  const base = config.tiers[tier as (typeof TIERS)[number]] || config.tiers.free
  return {
    monthly_ink:
      typeof overrides?.monthly_ink === 'number' ? overrides.monthly_ink : base.monthly_ink,
    daily_story_safety_cap:
      typeof overrides?.daily_story_safety_cap === 'number'
        ? overrides.daily_story_safety_cap
        : base.daily_story_safety_cap,
  }
}

function assertCount(value: unknown, field: string, max: number): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0 || n > max) {
    throw new HttpError(400, `${field} must be a whole number between 0 and ${max.toLocaleString()}`)
  }
  return n
}

/**
 * Writes administrator-set defaults. Only the keys supplied are touched, so a
 * form that edits one tier cannot silently reset the others.
 */
export async function saveBillingConfig(
  patch: {
    tiers?: Partial<Record<string, Partial<TierProfile>>>
    promo?: unknown
    welcome_ink?: number
    costs?: Partial<Record<string, number>>
  },
  adminUser: string,
): Promise<EffectiveBilling> {
  const set: Record<string, unknown> = { updated_at: new Date(), updated_by: adminUser }

  if (patch.promo !== undefined) {
    const promo = validatePromoPatch(patch.promo)
    if (Object.keys(promo).length) {
      if (promo.unlimited !== undefined) set['promo.unlimited'] = promo.unlimited
      if (promo.daily_turn_cap !== undefined) set['promo.daily_turn_cap'] = promo.daily_turn_cap
    }
  }
  for (const tier of TIERS) {
    const stored = patch.tiers?.[tier]
    if (!stored) continue
    if (stored.monthly_ink !== undefined) {
      set[`tiers.${tier}.monthly_ink`] = assertCount(stored.monthly_ink, `${tier} monthly Ink`, 100_000_000)
    }
    if (stored.daily_story_safety_cap !== undefined) {
      set[`tiers.${tier}.daily_story_safety_cap`] = assertCount(
        stored.daily_story_safety_cap,
        `${tier} daily turn cap`,
        1_000_000,
      )
    }
  }
  if (patch.welcome_ink !== undefined) {
    set.welcome_ink = assertCount(patch.welcome_ink, 'Welcome Ink', 100_000_000)
  }
  for (const key of COST_KEYS) {
    const value = patch.costs?.[key]
    if (value !== undefined) {
      // Zero is allowed and meaningful: it makes an action free without
      // switching enforcement off for everything else.
      set[`costs.${key}`] = assertCount(value, `${key} cost`, 1_000_000)
    }
  }

  const editsPromo = Object.keys(set).some((key) => key.startsWith('promo.'))
  // Seed inside the atomic update, rather than copying an effective cached
  // value: concurrent partial saves must never reset the other promo key.
  const update = editsPromo ? [
    { $set: { promo: { $ifNull: ['$promo', {
      unlimited: env.INK_PROMO_UNLIMITED, daily_turn_cap: env.INK_PROMO_DAILY_TURN_CAP,
    }] } } },
    { $set: Object.fromEntries(Object.entries(set).map(([key, value]) => [key, { $literal: value }])) },
  ] : { $set: set }
  await mongoColl.billingConfig().updateOne({ _id: SINGLETON }, update, { upsert: true })
  cache = null
  return effectiveBilling()
}

/** Drops the cache so a write on another path is picked up immediately. */
export function invalidateBillingConfig() {
  cache = null
}

export const BILLING_DEFAULTS = fallback()

export function validatePromoPatch(value: unknown): { unlimited?: boolean; daily_turn_cap?: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Promo must be an object.')
  }
  const promo = value as Record<string, unknown>
  if ('unlimited' in promo && typeof promo.unlimited !== 'boolean') {
    throw new HttpError(400, 'Promo unlimited must be true or false.')
  }
  if ('daily_turn_cap' in promo && (typeof promo.daily_turn_cap !== 'number' ||
      !Number.isInteger(promo.daily_turn_cap) || promo.daily_turn_cap < 1 || promo.daily_turn_cap > 100000)) {
    throw new HttpError(400, 'Promo daily turn cap must be a whole number between 1 and 100000.')
  }
  return {
    ...(promo.unlimited !== undefined ? { unlimited: promo.unlimited as boolean } : {}),
    ...(promo.daily_turn_cap !== undefined ? { daily_turn_cap: promo.daily_turn_cap as number } : {}),
  }
}
