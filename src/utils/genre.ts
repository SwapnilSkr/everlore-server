/**
 * Genre SHELF layer.
 *
 * A world's narration voice describes how it sounds; a genre describes which
 * shelf it sits on in Explore. They are separate authored facts: Horror is its
 * own shelf even though the horror voice belongs to the atmospheric-dark family,
 * and the anime-voiced worlds are not all Cozy.
 *
 * Genre is authored data. It is never inferred from a title or a word list; the
 * only automatic value is a fallback for worlds written before the backfill,
 * derived from the voice family that already exists in narrative-styles.ts.
 */
import { STYLE_FAMILY } from './narrative-styles'

/** Ordered, and the single source of the app's tab bar. */
export const GENRES = [
  { key: 'romance', label: 'Romance' },
  { key: 'epic', label: 'Epic' },
  { key: 'dark', label: 'Dark' },
  { key: 'horror', label: 'Horror' },
  { key: 'modern', label: 'Modern' },
  { key: 'cozy', label: 'Cozy' },
] as const

export type Genre = (typeof GENRES)[number]['key']

export const GENRE_KEYS: readonly Genre[] = GENRES.map(({ key }) => key)

export function isGenre(value: unknown): value is Genre {
  return typeof value === 'string' && (GENRE_KEYS as readonly string[]).includes(value)
}

/** Voice family → shelf. Horror is handled separately because it gets its own. */
const FAMILY_GENRE: Record<string, Genre> = {
  romance_charged: 'romance',
  epic_adventure: 'epic',
  atmospheric_dark: 'dark',
  modern_everyday: 'modern',
  cozy_playful: 'cozy',
}

/**
 * The shelf for a narration voice. `horror` keeps its own shelf; every other
 * known voice follows its family. An unknown or absent voice is Epic, the
 * broadest shelf.
 */
export function deriveGenre(narrativeStyle?: string | null): Genre {
  if (!narrativeStyle) return 'epic'
  if (narrativeStyle === 'horror') return 'horror'
  const family = STYLE_FAMILY[narrativeStyle]
  return (family && FAMILY_GENRE[family]) || 'epic'
}

/** The stored genre when it is valid, otherwise the derived fallback. */
export function resolveGenre(genre: unknown, narrativeStyle?: string | null): Genre {
  return isGenre(genre) ? genre : deriveGenre(narrativeStyle)
}

/** Every known voice that derives to this shelf. */
export function voicesForGenre(genre: Genre): string[] {
  return Object.keys(STYLE_FAMILY).filter((voice) => deriveGenre(voice) === genre)
}

/**
 * A Mongo clause matching one shelf, including worlds written before the
 * backfill ran. Derived here rather than in the service so the query and the
 * derivation cannot drift apart: a pre-backfill Horror world is still found by
 * the Horror tab, and `GET /templates/genres` counts the same set.
 */
export function genreFilter(genre: Genre): Record<string, unknown> {
  const or: Record<string, unknown>[] = [
    { genre },
    { genre: null, narrative_style: { $in: voicesForGenre(genre) } },
  ]
  // An absent, empty or unknown voice derives to Epic; `$nin` also matches a
  // missing field.
  if (genre === 'epic') or.push({ genre: null, narrative_style: { $nin: Object.keys(STYLE_FAMILY) } })
  return { $or: or }
}

/** The minimum a candidate needs for the For You ordering. */
export interface ForYouCandidate {
  id: string
  genre?: string | null
  narrative_style?: string | null
  created_at: Date
}

function dayOfYear(now: Date): number {
  const start = Date.UTC(now.getUTCFullYear(), 0, 1)
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Math.floor((today - start) / 86_400_000) + 1
}

/** Voice affinity, then newest, then id; shared by the feed and starter pick. */
export function forYouComparator(interests: readonly string[]) {
  const family = new Set(
    interests.map((voice) => STYLE_FAMILY[voice]).filter((value): value is string => Boolean(value)),
  )
  const familyVoices = new Set(
    Object.entries(STYLE_FAMILY)
      .filter(([, voiceFamily]) => family.has(voiceFamily))
      .map(([voice]) => voice),
  )
  const score = (candidate: ForYouCandidate): number => {
    const voice = candidate.narrative_style
    if (!voice) return 0
    if (interests.includes(voice)) return 2
    return familyVoices.has(voice) ? 1 : 0
  }
  return (a: ForYouCandidate, b: ForYouCandidate): number =>
    score(b) - score(a) || b.created_at.getTime() - a.created_at.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/**
 * The For You order: one queue per shelf, served in a weighted round-robin.
 *
 * A shelf the player has an interest in gets two places per round, every other
 * shelf one, so interests still lead without turning the feed into a wall of
 * one genre. The round starts at a different shelf each day, and a shelf never
 * takes more than its two places at once, so no genre runs three in a row while
 * another still has items.
 *
 * This is computed over the whole listed set (a few hundred worlds today) and
 * paged from the result. Past a few thousand worlds it should move to a
 * precomputed cursor or a materialised feed.
 */
export function forYouOrder(
  candidates: readonly ForYouCandidate[],
  interests: readonly string[],
  now: Date = new Date(),
): ForYouCandidate[] {
  const compare = forYouComparator(interests)
  const picked = new Set(interests.map((voice) => deriveGenre(voice)))

  const queues = new Map<Genre, ForYouCandidate[]>()
  for (const candidate of candidates) {
    const genre = resolveGenre(candidate.genre, candidate.narrative_style)
    const queue = queues.get(genre)
    if (queue) queue.push(candidate)
    else queues.set(genre, [candidate])
  }
  for (const queue of queues.values()) {
    queue.sort(compare)
  }

  const active = GENRE_KEYS.filter((genre) => (queues.get(genre)?.length ?? 0) > 0)
  if (active.length === 0) return []
  const start = dayOfYear(now) % active.length
  const rotated = [...active.slice(start), ...active.slice(0, start)]

  const order: ForYouCandidate[] = []
  while (order.length < candidates.length) {
    let taken = 0
    for (const genre of rotated) {
      const queue = queues.get(genre)!
      const places = picked.has(genre) ? 2 : 1
      for (let i = 0; i < places && queue.length > 0; i++) {
        order.push(queue.shift()!)
        taken++
      }
    }
    if (taken === 0) break
  }
  return order
}
