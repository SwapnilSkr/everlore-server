/**
 * Place identity — mongo-free so the cursor decision can use the same test as
 * the map without pulling the entity graph.
 *
 * Two questions this module answers:
 *  1. Is this label a unique place, or a local facet ("the yard", "the hall")?
 *  2. Are these two labels the same place?
 *
 * Token overlap (`locationNamesCompatible`) is a different question: can a
 * destination corroborate an observation ("Brera district" vs "Via Brera, 14").
 * Overlap is why "the yard" next to a hunting lodge later counted as "the
 * steward's yard". Do not use it for cursor identity.
 */

/** Same normalization as the codex so the two registries resolve identically. */
export function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s'-]+/g, '')
    .replace(/\s+/g, ' ')
}

export function normalizeLocationName(name: string): string {
  return normalizeEntityName(name).replace(/^(?:the|a|an)\s+/, '')
}

/**
 * Generic / relative place labels that must NEVER become a canonical location of
 * their own ("the room", "here", "outside", …). On a turn with no narrated
 * movement these mean "still where we were" — i.e. the current cursor, not a new
 * place. Matched as the WHOLE normalized label, so a QUALIFIED name stays
 * specific ("dining room" / "great room" / "throne hall" are NOT vague — only a
 * bare "room" / "the hall" is). This is the location analog of "a bare descriptor
 * is never a new character". See LOCATION_GRAPH.md (P0).
 */
const VAGUE_LOCATION_LABELS = new Set<string>([
  'here', 'there', 'this place', 'that place', 'the place', 'a place', 'someplace',
  'some place', 'somewhere', 'elsewhere', 'nearby', 'around', 'this area', 'the area',
  'the vicinity', 'this spot', 'the spot',
  'outside', 'inside', 'indoors', 'outdoors', 'out',
  'room', 'the room', 'a room', 'this room', 'that room', 'the hall', 'a hall',
  'the chamber', 'a chamber', 'the building', 'a building', 'the space', 'this space',
])

/** A possessive-pronoun + bare room/dwelling noun ("his room", "my chamber",
 *  "her quarters", "their house") is just as RELATIVE as "the room" — it names no
 *  specific place until the owner is resolved, so it must never become a canonical
 *  location of its own. A qualified possessive ("his throne room", "her war study")
 *  keeps its distinctive word and is NOT matched. The owner-scoped form a memory
 *  should actually carry ("Swapnil Sarkar's room") starts with a name, not a
 *  pronoun, so it stays specific. */
const POSSESSIVE_VAGUE_ROOM =
  /^(?:my|his|her|their|its|our|your)\s+(?:own\s+)?(?:room|bedroom|chamber|chambers|hall|study|quarters|den|cabin|cell|office|loft|suite|dorm|place|area|space|building|house|home|apartment|flat|cottage|hut|tent)$/

const LOCATION_TOKEN_STOP = new Set(['the', 'a', 'an', 'of', 'in', 'at', 'to', 'and'])
/** Generic place nouns that are NOT distinctive on their own — "room", "hall",
 *  etc. A name made up only of these ("the room") must not fuzzy-match a specific
 *  place that merely shares the noun ("dining room", "great room"): a bedroom is
 *  not the dining room. The distinctive qualifier ("dining") has to match too. */
const GENERIC_PLACE_NOUNS = new Set([
  'room', 'rooms', 'hall', 'halls', 'chamber', 'chambers', 'place', 'area', 'areas',
  'spot', 'space', 'building', 'house', 'home', 'grounds', 'yard', 'quarters',
])
/** Minimum Jaccard score for a conservative fuzzy location match. */
export const LOCATION_FUZZY_MIN_SCORE = 0.45

/** Significant tokens for location similarity — strips articles/prepositions. */
export function significantLocationTokens(normalized: string): string[] {
  return normalized
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !LOCATION_TOKEN_STOP.has(t))
}

/**
 * Conservative token-containment score between two normalized location names.
 * Returns 0 when names should not merge; 1 for identical strings.
 */
export function scoreLocationNameMatch(queryNorm: string, candidateNorm: string): number {
  if (!queryNorm || !candidateNorm) return 0
  if (queryNorm === candidateNorm) return 1

  const qt = significantLocationTokens(queryNorm)
  const ct = significantLocationTokens(candidateNorm)
  if (!qt.length || !ct.length) return 0

  const shorter = qt.length <= ct.length ? qt : ct
  const longer = qt.length <= ct.length ? ct : qt
  const longerSet = new Set(longer)
  if (!shorter.every((t) => longerSet.has(t))) return 0

  // A name made only of generic place-nouns ("the room", "the hall") is not a
  // confident match for a specific place that just shares the noun — the
  // distinctive qualifier is missing. "dining room" ≠ "the room".
  if (shorter.every((t) => GENERIC_PLACE_NOUNS.has(t))) return 0

  // Single-token shorthand ("garden" → "night garden") needs a strong token.
  if (shorter.length === 1 && shorter[0].length < 4) return 0

  const union = new Set([...qt, ...ct])
  return shorter.length / union.size
}

/** A label made only of generic place-nouns: "the yard", "the hall", "grounds".
 *  Not a unique map identity. A qualifier ("steward's yard", "hunting lodge")
 *  keeps at least one distinctive word and is not bare. */
export function isBareGenericPlaceLabel(name: string | null | undefined): boolean {
  const tokens = significantLocationTokens(normalizeLocationName(String(name || '')))
  return tokens.length > 0 && tokens.every((token) => GENERIC_PLACE_NOUNS.has(token))
}

/** True when a place label is generic/relative (see {@link VAGUE_LOCATION_LABELS}
 *  and {@link POSSESSIVE_VAGUE_ROOM}). A name whose content is only generic
 *  place-nouns ("the yard", "the grounds") is the same class: a local facet of
 *  wherever the cursor already is, not a new map node. "steward's yard" keeps
 *  a distinctive word and stays specific. */
export function isVagueLocationLabel(name: string | null | undefined): boolean {
  const n = normalizeEntityName(String(name || ''))
  if (!n) return false
  if (VAGUE_LOCATION_LABELS.has(n) || POSSESSIVE_VAGUE_ROOM.test(n)) return true
  return isBareGenericPlaceLabel(name)
}

/**
 * Same-place test for the cursor and scene breaks. This is the map's own
 * identity function — not token overlap.
 */
export function placesAreTheSameLocation(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = normalizeLocationName(String(a || ''))
  const right = normalizeLocationName(String(b || ''))
  if (!left || !right) return false
  if (left === right) return true
  return scoreLocationNameMatch(left, right) >= LOCATION_FUZZY_MIN_SCORE
}

/**
 * Inverse of the solar-room carry: a person last seen at a known place is still
 * THERE, not in the player's current room, unless those places are the same
 * node or one contains the other (the bar inside the inn).
 *
 * Used to refuse a presence admit that would teleport Elara from her tavern
 * into the hunting lodge because the player asked to go to her.
 *
 * Ancestor lists include self, nearest-first. Unknown last place or no current
 * cursor → not elsewhere (no gate).
 */
export function belongsAtAnotherLocation(params: {
  lastPlaceId?: string | null
  lastPlaceName?: string | null
  currentPlaceId?: string | null
  currentPlaceName?: string | null
  lastAncestorIds?: string[]
  currentAncestorIds?: string[]
}): boolean {
  const lastId = params.lastPlaceId ? String(params.lastPlaceId) : ''
  const currentId = params.currentPlaceId ? String(params.currentPlaceId) : ''
  const lastName = params.lastPlaceName || null
  const currentName = params.currentPlaceName || null
  if (!lastId && !lastName) return false
  if (!currentId && !currentName) return false
  if (lastId && currentId && lastId === currentId) return false
  const lastChain = params.lastAncestorIds?.length ? params.lastAncestorIds : lastId ? [lastId] : []
  const currentChain = params.currentAncestorIds?.length ? params.currentAncestorIds : currentId ? [currentId] : []
  if (lastChain.length && currentChain.length) {
    if (currentChain.includes(lastChain[0]) || lastChain.includes(currentChain[0])) return false
  }
  if (lastName && currentName && placesAreTheSameLocation(lastName, currentName)) return false
  return true
}
