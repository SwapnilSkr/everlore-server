/**
 * The compiled-in price list.
 *
 * These are no longer the live values — administrators set those, and they are
 * stored in the `billing_config` document. This remains the floor beneath that:
 * the seed for a fresh install, and the fallback whenever the stored settings
 * are missing, partial, or unreadable, so the server always has a complete and
 * valid catalog even with no database.
 *
 * It lives in its own module because both `billing.service` and
 * `billing-config.service` need it, and importing it from the former would make
 * that pair circular.
 */
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

export type BillableAction = keyof typeof BILLING_CATALOG.costs
