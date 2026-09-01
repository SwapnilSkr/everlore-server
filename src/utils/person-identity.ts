/**
 * Atmosphere, abstractions, and scene objects that prose frequently
 * personifies ("Silence answers", "Fear waits") but which must never become
 * automatic characters. A real character using one of these names still has a
 * deliberate escape hatch: an explicit in-scene self-introduction is handled
 * by the codex extractor before a new card is allowed.
 */
const ABSTRACT_NON_PERSON_TERMS = new Set([
  'silence', 'darkness', 'light', 'shadow', 'shadows', 'echo', 'echoes',
  'memory', 'memories', 'fear', 'anger', 'grief', 'death', 'fate', 'time', 'valour', 'valor',
  'night', 'morning', 'evening', 'rain', 'wind', 'air', 'fire', 'flame',
  'smoke', 'sound', 'noise', 'voice', 'voices',
])

function normalizedIdentity(value: string | null | undefined): string {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s'-]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:the|a|an)\s+/, '')
    .trim()
}

export function isAbstractNonPersonTerm(value: string | null | undefined): boolean {
  return ABSTRACT_NON_PERSON_TERMS.has(normalizedIdentity(value))
}

/** Determiners that mark a phrase as a reference to a KIND of person rather than
 *  a name for one. A proper name does not take an article. */
export const DETERMINER_PREFIX = /^(?:the|a|an|some|that|this|another|one)\s+/i

/**
 * Is this string a LABEL for a kind of person ("the rider", "guards") rather
 * than a name for one ("Aldric", "the Rider" as an authored title)?
 *
 * Structural, not a vocabulary: an article, or the absence of any capital. No
 * word list can describe the roles of an open platform's worlds — that was the
 * bug this replaced, where "knight" was hardcoded as generic and "rider" was not.
 *
 * A script without letter case reads as a label, so the caller is simply more
 * careful there rather than less.
 */
export function isLabelLike(name: string | null | undefined): boolean {
  const head = String(name || '').trim().replace(DETERMINER_PREFIX, '').trim()
  if (!head) return false
  // The article is stripped first, deliberately: an author who writes "the Rider"
  // has made it a title, and a title is an identity. Only the absence of any
  // capital marks a plain common noun.
  return !/[A-Z]/.test(head)
}
