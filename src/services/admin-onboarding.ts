import type { Document } from 'mongodb'
import type { UserDoc } from '../models/user.model'
import { HttpError } from '../utils/http-error'

type OnboardingUser = { preferences?: Partial<UserDoc['preferences']>; providers?: string[] }

export function userOnboarding(user: OnboardingUser) {
  const name = user.preferences?.player_name || null
  return {
    name,
    gender: user.preferences?.gender ?? null,
    interests: user.preferences?.interests ?? [],
    sign_in: user.providers ?? [],
    mature_enabled: user.preferences?.nsfw_enabled ?? false,
    completed: Boolean(name),
  }
}

export function usersSince(value?: string): Date | undefined {
  if (value === undefined) return undefined
  const date = new Date(value)
  const calendarDay = value.slice(0, 10)
  const validDay = new Date(`${calendarDay}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)
    || !Number.isFinite(date.getTime()) || !Number.isFinite(validDay.getTime())
    || validDay.toISOString().slice(0, 10) !== calendarDay) {
    throw new HttpError(400, 'Since must be a valid ISO date.')
  }
  return date
}

export type OnboardingBucket = { key: string; count: number }
export type OnboardingCounts = { new_users: number; completed: number; with_interests: number }
export type OnboardingFacets = {
  totals: OnboardingCounts[]
  interests: OnboardingBucket[]
  gender: OnboardingBucket[]
  sign_in: OnboardingBucket[]
}

const hasName = { $ne: [{ $ifNull: ['$preferences.player_name', ''] }, ''] }
const buckets: Document[] = [
  { $group: { _id: '$key', count: { $sum: 1 } } },
  { $sort: { count: -1, _id: 1 } },
  { $project: { _id: 0, key: '$_id', count: 1 } },
]

/** Facets share the metrics signup window and scan it once. */
export function onboardingFacets(): Record<keyof OnboardingFacets, Document[]> {
  return {
    totals: [{ $group: {
      _id: null,
      new_users: { $sum: 1 },
      completed: { $sum: { $cond: [hasName, 1, 0] } },
      with_interests: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$preferences.interests', []] } }, 0] }, 1, 0] } },
    } }, { $project: { _id: 0 } }],
    interests: [
      { $project: { key: { $setUnion: [{ $ifNull: ['$preferences.interests', []] }, []] } } },
      { $unwind: '$key' }, ...buckets,
    ],
    gender: [
      { $project: { key: { $ifNull: ['$preferences.gender', 'skipped'] } } }, ...buckets,
    ],
    sign_in: [
      { $project: { key: { $setUnion: [{ $ifNull: ['$providers', []] }, []] } } },
      { $unwind: '$key' }, ...buckets,
    ],
  }
}
