import { comparable } from './scene-endpoint-adjudicator'

/**
 * PLACE PROMOTION — the two-tier map.
 *
 * A location entity used to be minted the moment the cursor moved to a name.
 * That made minting self-justifying: once "the old bench" existed as a location,
 * it appeared in `knownPlaces`, and `knownPlaces` is a short-circuit meaning
 * "this is definitely a place" — so the hygiene gate that would have refused it
 * was disabled by the graph's own memory of the mistake. One furniture write on
 * one turn defeated the check for the rest of the run.
 *
 *   SCENE ANCHOR   what this passage says. May be wrong. Mints nothing, never
 *                  enters knownPlaces, costs nothing when it is furniture.
 *   MAP NODE       a place the world contains. Requires structural evidence
 *                  accrued over turns, because minting cannot be undone
 *                  downstream.
 *
 * The evidence is relational, never lexical — no vocabulary of place nouns
 * decides anything here:
 *
 *   A place is something you can be INSIDE and LEAVE.
 *   Furniture is something you are AT while remaining inside a place.
 *
 * So: a place gets entered and left. It contains things, or sits inside
 * something. Those are observable relations. "Bench" versus "hall" is not.
 *
 * This is the same rule the project already proved for characters in
 * `unnamed_character_carding`: recurrence beats naming.
 */

/** Directional prepositions — the object is somewhere the viewpoint MOVES INTO. */
const ENTRY_PREPOSITION = new Set([
  'into', 'inside', 'onto', 'through', 'to', 'toward', 'towards', 'up', 'down',
  'back', 'across', 'aboard', 'within',
])
/** Directional prepositions — the object is somewhere the viewpoint MOVES OUT OF. */
const EXIT_PREPOSITION = new Set(['out', 'from', 'off', 'outof', 'leaving', 'past', 'beyond'])
/** Static locatives. A bench takes these; so does a hall. They prove nothing. */
const STATIC_PREPOSITION = new Set([
  'in', 'at', 'on', 'upon', 'beside', 'near', 'nearby', 'behind', 'under',
  'beneath', 'above', 'over', 'around', 'against', 'by', 'opposite', 'along',
])

const NP_SKIP = new Set([
  'a', 'an', 'the', 'my', 'our', 'his', 'her', 'their', 'its',
  'this', 'that', 'these', 'those', 'own', 'other', 'another',
  'old', 'great', 'small', 'new', 'far', 'deep', 'deeper', 'high', 'low', 'same',
  // "out OF the hall", "back TO the cellars" — the second word is a particle of
  // the preposition, not the preposition. Skipping it lets the NEAREST real
  // preposition decide.
  'of',
])
const VIEWPOINT_TOKEN = new Set([
  'i', "i'm", "i've", "i'll", 'me', 'my', 'we', "we're", "we've", 'us', 'our',
  'you', "you're", "you've", 'your',
])

function tokenize(value: string): string[] {
  return comparable(value)
    .split(/\s+/)
    .map((token) => token.replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, ''))
    .filter(Boolean)
}

/** Distinctive words of a place name, minus any preposition it carries itself. */
function coreTokens(place: string): string[] {
  const tokens = tokenize(place)
  let start = 0
  while (
    start < tokens.length - 1 &&
    (ENTRY_PREPOSITION.has(tokens[start]) || EXIT_PREPOSITION.has(tokens[start]) || STATIC_PREPOSITION.has(tokens[start]))
  ) {
    start++
  }
  return tokens.slice(start).filter((token) => token.length >= 3 && !NP_SKIP.has(token))
}

export interface PlaceRelation {
  /** The viewpoint moved INTO it. */
  entry: boolean
  /** The viewpoint moved OUT OF it. */
  exit: boolean
}

/**
 * Does this passage show the viewpoint ENTERING or LEAVING the named place?
 *
 * Clause-scoped and viewpoint-owned: "Bram went down to the cellars" proves
 * nothing about where the player is, and must not accrue.
 */
export function classifyPlaceRelation(
  place: string,
  prose: string,
  options: { people?: string[] } = {},
): PlaceRelation {
  const core = coreTokens(place)
  const out: PlaceRelation = { entry: false, exit: false }
  if (!core.length) return out
  const others = new Set(
    (options.people || []).flatMap((name) => tokenize(name)).filter((token) => token.length >= 3),
  )
  for (const token of core) others.delete(token)

  // Split on punctuation and subordinators only. Coordinated clauses keep their
  // shared subject — "I take a lamp AND go down to the root cellars" has its
  // viewpoint in the first half and its movement in the second.
  for (const clause of comparable(prose).split(/[;:.!?]|\bwhile\b|\bbecause\b|\bthough\b|\balthough\b/)) {
    const tokens = tokenize(clause)
    if (!tokens.length) continue
    const at = tokens.findIndex((token) => core.includes(token))
    if (at < 0) continue
    const head = tokens.slice(0, at)
    const viewpointAt = head.findIndex((token) => VIEWPOINT_TOKEN.has(token))
    const competitorAt = head.findIndex((token) => others.has(token.replace(/'s$/, '')))
    // Somebody else owns this clause — their movement is not the player's.
    if (competitorAt >= 0 && (viewpointAt < 0 || competitorAt < viewpointAt)) continue
    if (viewpointAt < 0) continue

    // The NEAREST preposition governs. "step out onto the bridge" is an entry
    // (onto), not an exit, even though `out` is in the run; "walk out of the
    // hall" is an exit, because `of` is a particle and `out` is the nearest
    // real preposition behind it.
    let cursor = at - 1
    while (cursor >= 0 && NP_SKIP.has(head[cursor])) cursor--
    const governor = cursor >= 0 ? head[cursor] : ''
    if (EXIT_PREPOSITION.has(governor)) out.exit = true
    else if (ENTRY_PREPOSITION.has(governor)) out.entry = true
  }
  return out
}

export interface PlaceAccrual {
  name: string
  /** Distinct turns the viewpoint was situated here. */
  sightings: number
  /** Distinct turns the prose showed the viewpoint entering. */
  entries: number
  /** Distinct turns the prose showed the viewpoint leaving. */
  exits: number
  /** A validated containment edge to or from a place the world already knows. */
  containment: boolean
  first_sequence: number
  last_sequence: number
}

export interface PromotionDecision {
  promote: boolean
  reason: 'authored' | 'containment' | 'entered_and_left' | 'recurrent_arrival' | 'provisional'
  next: PlaceAccrual
}

/**
 * `authored` is the world's own canon — a template seed place or a typed travel
 * destination the player chose from the product's own UI. Those are not model
 * output and need no accrual.
 */
export function decidePlacePromotion(params: {
  candidate: string
  sequence: number
  relation: PlaceRelation
  containment: boolean
  authored: boolean
  prior: PlaceAccrual | null
}): PromotionDecision {
  const prior = params.prior
  const fresh = !prior || prior.last_sequence !== params.sequence
  const next: PlaceAccrual = {
    name: params.candidate,
    sightings: (prior?.sightings || 0) + (fresh ? 1 : 0),
    entries: (prior?.entries || 0) + (fresh && params.relation.entry ? 1 : 0),
    exits: (prior?.exits || 0) + (fresh && params.relation.exit ? 1 : 0),
    containment: !!prior?.containment || params.containment,
    first_sequence: prior?.first_sequence ?? params.sequence,
    last_sequence: params.sequence,
  }
  if (params.authored) return { promote: true, reason: 'authored', next }
  if (next.containment) return { promote: true, reason: 'containment', next }
  // Entered AND left: the definition of a place, observed rather than assumed.
  if (next.entries > 0 && next.exits > 0) return { promote: true, reason: 'entered_and_left', next }
  // Or returned to repeatedly, having been entered at least once. Furniture the
  // narration keeps mentioning never accrues an ENTRY, so it never lands here.
  if (next.sightings >= 3 && next.entries > 0) return { promote: true, reason: 'recurrent_arrival', next }
  return { promote: false, reason: 'provisional', next }
}
