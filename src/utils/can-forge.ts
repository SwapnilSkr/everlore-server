import { env } from '../config/env'

export function canForge(
  user: { tier: string; admin_tier_override?: string | null },
  openToAllTiers: boolean = env.FORGE_OPEN_TO_ALL_TIERS,
): boolean {
  const tier = user.admin_tier_override || user.tier
  return openToAllTiers || tier === 'premium' || tier === 'creator'
}
