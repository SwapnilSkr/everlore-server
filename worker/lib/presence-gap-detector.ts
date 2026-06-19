/**
 * Shared WITNESS -> ENTITY-STUB gap detector.
 *
 * A gap is a person-like name visible in prose that is absent from the turn's
 * extracted presence list, absent from codex names/aliases, and absent from
 * existing stubs. The live generation path uses this to stub high-confidence
 * misses; the audit imports the same pure functions so the two cannot drift.
 */

function normalizeName(name: string): string {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s'-]+/g, '')
    .replace(/\s+/g, ' ')
}

/** Bare common-noun person labels: passer-by descriptors, not tracked people. */
export const GENERIC_PERSON_DESCRIPTORS = new Set<string>([
  'man', 'woman', 'boy', 'girl', 'child', 'kid', 'person', 'figure', 'stranger',
  'old man', 'old woman', 'young man', 'young woman', 'lady', 'gentleman', 'guy',
  'merchant', 'trader', 'vendor', 'shopkeeper', 'clerk', 'seller',
  'guard', 'soldier', 'sentry', 'watchman', 'knight', 'officer',
  'innkeeper', 'barkeep', 'bartender', 'waiter', 'waitress', 'servant', 'maid',
  'driver', 'pilot', 'sailor', 'beggar', 'priest', 'monk', 'nun', 'farmer',
  'hunter', 'fisherman', 'worker', 'passerby', 'passer by', 'bystander',
  'crowd', 'people', 'men', 'women', 'guards', 'soldiers', 'villagers', 'citizens',
])

/** Trackable role words that can be real scene participants even without names. */
export const FAMILY_ROLE_WORDS = new Set<string>([
  'father', 'mother', 'mom', 'dad', 'parent', 'parents',
  'sister', 'brother', 'sibling', 'twin sister', 'twin brother', 'twin',
  'wife', 'husband', 'spouse', 'partner', 'fiancee', 'fiance',
  'girlfriend', 'boyfriend', 'cousin', 'aunt', 'uncle',
  'grandmother', 'grandfather', 'grandma', 'grandpa',
  'butler', 'captain', 'king', 'queen', 'prince', 'princess', 'lord', 'lady',
])

const STOP = new Set<string>([
  'the', 'a', 'an', 'and', 'but', 'or', 'so', 'then', 'when', 'while', 'as',
  'he', 'she', 'they', 'it', 'his', 'her', 'their', 'its', 'him', 'them',
  'i', 'you', 'we', 'me', 'my', 'your', 'our',
  'this', 'that', 'these', 'those', 'there', 'here',
  'what', 'who', 'whom', 'whose', 'which', 'why', 'how',
  'in', 'on', 'at', 'to', 'of', 'for', 'with', 'without', 'from', 'into',
  'up', 'down', 'out', 'over', 'under', 'back', 'away', 'off',
  'one', 'two', 'three', 'first', 'second', 'next', 'last',
  'yes', 'no', 'not', 'now', 'still', 'again', 'once', 'only', 'just',
  'room', 'hall', 'door', 'table', 'fire', 'hand', 'hands', 'eyes', 'voice',
  'night', 'day', 'morning', 'evening',
])

export interface VisibleNameCandidate {
  key: string
  display: string
}

function titleCaseNormalized(key: string): string {
  return key
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function visibleNameCandidatesDetailed(prose: string): VisibleNameCandidate[] {
  const text = String(prose || '')
  const out: VisibleNameCandidate[] = []
  const seen = new Set<string>()
  const tokens = text.replace(/[^A-Za-z'\s-]/g, ' ').split(/\s+/)

  for (const raw of tokens) {
    const t = raw.trim().replace(/['\u2019]s$/i, '')
    if (t.length < 3) continue
    if (!/^[A-Z][a-z''-]+$/.test(t)) continue
    const lower = t.toLowerCase()
    if (STOP.has(lower)) continue
    const key = normalizeName(t)
    if (!key || seen.has(key)) continue
    if (GENERIC_PERSON_DESCRIPTORS.has(key) && !FAMILY_ROLE_WORDS.has(key)) continue
    seen.add(key)
    out.push({ key, display: t })
  }

  const lowerText = ` ${normalizeName(text)} `
  for (const role of FAMILY_ROLE_WORDS) {
    const key = normalizeName(role)
    if (!key || seen.has(key)) continue
    if (!lowerText.includes(` ${key} `)) continue
    seen.add(key)
    out.push({ key, display: titleCaseNormalized(key) })
  }

  return out
}

export function visibleNameCandidates(prose: string): string[] {
  return visibleNameCandidatesDetailed(prose).map((c) => c.key)
}

export interface TrackedNames {
  present?: string[]
  codex?: string[]
  stubs?: string[]
  exclude?: string[]
}

export function detectPresenceCodexGapsDetailed(
  prose: string,
  tracked: TrackedNames,
): VisibleNameCandidate[] {
  const covered = new Set<string>()
  for (const n of [
    ...(tracked.present || []),
    ...(tracked.codex || []),
    ...(tracked.stubs || []),
    ...(tracked.exclude || []),
  ]) {
    const key = normalizeName(n)
    if (key) covered.add(key)
  }
  return visibleNameCandidatesDetailed(prose).filter((c) => !covered.has(c.key))
}

export function detectPresenceCodexGaps(prose: string, tracked: TrackedNames): string[] {
  return detectPresenceCodexGapsDetailed(prose, tracked).map((c) => c.key)
}
