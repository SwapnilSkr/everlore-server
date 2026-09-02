import { comparable, hasExactEvidence, DETERMINER } from './scene-endpoint-adjudicator'
import type { CitationCheck } from '../../src/models/extractor-raw.model'

/**
 * Citation stack for the scene witness's `current_location` claim — the exact
 * shape already used for endpoint presence, applied to the location cursor.
 *
 *   (a) the cited excerpt appears verbatim in its stated source  — not fabricated
 *   (b) the excerpt actually contains the claimed place name     — about THIS place
 *   (c) the excerpt situates the PLAYER'S VIEWPOINT at that place — here, not mentioned
 *
 * Before this, the cursor's only check was (a). A witness could cite any real
 * sentence in the passage and move the map: "the road to Marrow Ford" proved
 * arrival at Marrow Ford, "Bram's down there in the cellars" proved the player
 * was in the cellars. (a) alone is a fabrication check, never a location check.
 *
 * Nothing here consults a vocabulary of places or of movement verbs. The only
 * lists are CLOSED GRAMMATICAL CLASSES — English prepositions and pronouns —
 * plus the caller's own supplied character names. The model decides where the
 * scene is; this verifies that the sentence it quoted says so.
 */

/**
 * Prepositions that place their object AT a location. Strictly locative:
 * `to`, `for`, `toward(s)` and `from` are goal/source markers and are
 * deliberately absent — "the road TO Marrow Ford" is not being in Marrow Ford,
 * and that exact excerpt moved a live cursor.
 */
const LOCATIVE_PREPOSITION = new Set([
  'in', 'into', 'inside', 'at', 'on', 'onto', 'upon', 'within', 'throughout',
  'through', 'across', 'beneath', 'underneath', 'under', 'below', 'above',
  'over', 'beyond', 'outside', 'near', 'nearby', 'beside', 'behind', 'before',
  'between', 'among', 'amid', 'amidst', 'around', 'past', 'along', 'atop',
  'opposite', 'against', 'by',
])

/** Verbs of intent, not position: "I want to head for the cafe" is a plan. */
const INTENT_MARKER = /\b(?:want|wants|wanted|plan|plans|planned|intend|intends|hope|hopes|need|needs|going\s+to|would\s+like|should|could|might|maybe|perhaps|if)\b/

/** Words that may sit between a locative preposition and its object NP. */
const NP_SKIP = new Set([
  ...DETERMINER,
  'this', 'that', 'these', 'those', 'some', 'one', 'own', 'other', 'another',
  'back', 'far', 'deep', 'deeper', 'high', 'low', 'old', 'great', 'small',
  'new', 'same', 'very', 'more', 'most', 'right', 'just', 'still',
])

/** The viewpoint: first person (the protagonist) and second person (how a
 *  sentient/character world addresses the player). A closed pronoun class. */
const VIEWPOINT_TOKEN = new Set([
  'i', "i'm", "i've", "i'll", "i'd", 'me', 'my', 'mine', 'myself',
  'we', "we're", "we've", "we'll", "we'd", 'us', 'our', 'ours', 'ourselves',
  'you', "you're", "you've", "you'll", "you'd", 'your', 'yours', 'yourself',
])

/** A third party owning the clause. A closed pronoun class. */
const THIRD_PERSON_TOKEN = new Set([
  'he', "he's", 'him', 'his', 'himself',
  'she', "she's", 'her', 'hers', 'herself',
  'they', "they're", "they've", 'them', 'their', 'theirs', 'themselves',
])

function tokenize(value: string): string[] {
  return comparable(value)
    .split(/\s+/)
    .map((token) => token.replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, ''))
    .filter(Boolean)
}

/**
 * A place name can carry its own locative preposition — "under the bridge",
 * "behind the bar", "across the square". The viewpoint test looks for a locative
 * governor BEFORE the name, so on those names it found the preceding noun
 * instead ("the air under the bridge" → governor "air") and refused a perfectly
 * good citation. Strip the preposition: the name already asserts the relation.
 */
function placeCore(value: string): string {
  const tokens = comparable(value).split(/\s+/).filter(Boolean)
  let start = 0
  while (start < tokens.length - 1 && LOCATIVE_PREPOSITION.has(tokens[start])) start++
  return tokens.slice(start).join(' ')
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** (b): the excerpt names the place, whole or by a distinctive word of it. */
export function excerptNamesPlace(place: string, evidence: string): boolean {
  const hay = comparable(evidence)
  if (!hay) return false
  const name = placeCore(place)
  if (!name) return false
  if (name.length >= 2 && new RegExp(`\\b${escapeRe(name)}\\b`).test(hay)) return true
  const parts = name.split(/\s+/).filter((part) => part.length >= 3 && !DETERMINER.has(part))
  // Every distinctive word must appear: "root cellars" must not be proved by
  // "the cellars of another house" — but "Night Garden" may be cited as
  // "the night garden was empty".
  return parts.length > 0 && parts.every((part) => new RegExp(`\\b${escapeRe(part)}\\b`).test(hay))
}

/** Index of the first token of the place mention inside a token list. */
function findPlaceStart(tokens: string[], place: string): number {
  const parts = tokenize(place).filter((part) => !DETERMINER.has(part))
  if (!parts.length) return -1
  const first = parts[0]
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== first) continue
    if (parts.every((part) => tokens.slice(i).includes(part))) return i
  }
  // A single distinctive word is enough when the full run is not contiguous.
  for (let i = 0; i < tokens.length; i++) if (parts.includes(tokens[i])) return i
  return -1
}

/**
 * (c): the excerpt puts the VIEWPOINT at this place, rather than merely
 * uttering the place's name.
 *
 * Accepts three shapes, in order:
 *   A. locative PP with no competing subject — "back in the root cellars, the air is cold"
 *   B. the viewpoint owns the clause         — "we reach the village square"
 *   C. the place is the clause subject       — "The hall is quiet again"
 *
 * Rejects a clause owned by somebody else ("Bram's down there in the cellars"),
 * a goal/source PP ("the road to Marrow Ford") and a mention with no locative
 * relation at all ("he talked about the hall").
 */
export function excerptSituatesViewpoint(
  place: string,
  evidence: string,
  options: { people?: string[] } = {},
): boolean {
  // Test each clause on its own. A subordinate clause about somebody else must
  // not poison the main clause that does situate the viewpoint — a live witness
  // cited "When he pushes the heavy door open, the great hall greets him" for a
  // player walking back into the hall, and a whole-excerpt read refused it.
  return splitClauses(evidence).some((clause) => clauseSituatesViewpoint(place, clause, options))
}

/** Closed-class clause boundaries: punctuation, coordinators, subordinators. */
const CLAUSE_BOUNDARY = new Set([
  'and', 'but', 'or', 'nor', 'so', 'yet',
  'when', 'while', 'as', 'after', 'before', 'because', 'since', 'though',
  'although', 'unless', 'until', 'if', 'whether', 'that', 'where', 'whereas',
])

function splitClauses(evidence: string): string[] {
  const pieces = comparable(evidence)
    .split(/[,;:—–]|\.\s|\band\b|\bbut\b|\bwhile\b|\bwhen\b|\bas\b|\bbecause\b|\bthough\b|\balthough\b|\bafter\b|\bbefore\b|\bsince\b|\buntil\b|\bunless\b/)
    .map((piece) => piece.trim())
    .filter(Boolean)
  // Always include the whole span too: a locative PP may legitimately straddle
  // a comma ("Back in the root cellars, the air is cold").
  return pieces.length > 1 ? [comparable(evidence), ...pieces] : [comparable(evidence)]
}

function clauseSituatesViewpoint(
  place: string,
  evidence: string,
  options: { people?: string[] } = {},
): boolean {
  const tokens = tokenize(evidence)
  if (!tokens.length) return false
  const core = placeCore(place)
  const start = findPlaceStart(tokens, core)
  if (start < 0) return false

  const head = tokens.slice(0, start)

  // Anybody else who could own this clause. Supplied names are the caller's
  // real cast, so this is a machine-checked witness test, not a vocabulary.
  const otherPeople = new Set(
    (options.people || []).flatMap((name) => tokenize(name)).filter((token) => token.length >= 3),
  )
  const placeTokens = new Set(tokenize(core))
  for (const token of placeTokens) otherPeople.delete(token)

  const viewpointAt = head.findIndex((token) => VIEWPOINT_TOKEN.has(token))
  const competitorAt = head.findIndex(
    (token) => THIRD_PERSON_TOKEN.has(token) || otherPeople.has(token.replace(/'s$/, '')),
  )
  // A competitor that appears AFTER the viewpoint does not steal the clause
  // ("I follow her into the hall"); one before it does ("Bram's down in the
  // cellars while I wait").
  const competitorOwnsClause = competitorAt >= 0 && (viewpointAt < 0 || competitorAt < viewpointAt)

  // C. subject position: the excerpt opens with the place.
  if (head.length === 0 || head.every((token) => NP_SKIP.has(token) || CLAUSE_BOUNDARY.has(token))) {
    return tokens.length > start + 1
  }

  // A. governed by a locative preposition.
  let cursor = start - 1
  while (cursor >= 0 && NP_SKIP.has(head[cursor])) cursor--
  const governor = cursor >= 0 ? head[cursor] : ''
  if (LOCATIVE_PREPOSITION.has(governor) && !competitorOwnsClause) return true

  // B. the viewpoint owns the clause containing the place — but wanting to go
  // somewhere is not being there. Shape B is the loosest of the three (any
  // first-person clause mentioning the place), so it is the one that needs the
  // intention filter; A and C are already anchored by grammar.
  if (INTENT_MARKER.test(tokens.join(' '))) return false
  return viewpointAt >= 0 && !competitorOwnsClause
}

export interface LocationCitationVerdict {
  place: string
  evidence: string
  a: boolean
  b: boolean
  c: boolean
  rejected: CitationCheck[]
}

/** The full (a)(b)(c) stack for a witness location claim against its source. */
export function evaluateLocationCitation(params: {
  place: string
  evidence: string
  source: string
  people?: string[]
}): LocationCitationVerdict {
  const a = hasExactEvidence(params.evidence, params.source)
  const b = excerptNamesPlace(params.place, params.evidence)
  const c = b && excerptSituatesViewpoint(params.place, params.evidence, { people: params.people })
  const rejected: CitationCheck[] = []
  if (!a) rejected.push('a')
  if (!b) rejected.push('b')
  if (!c) rejected.push('c')
  return { place: params.place, evidence: params.evidence, a, b, c, rejected }
}

/** A cursor move needs the whole stack. */
export function citationAdmitsLocation(verdict: LocationCitationVerdict): boolean {
  return verdict.a && verdict.b && verdict.c
}


/**
 * Does ANY sentence of the passage situate the viewpoint at this place?
 *
 * The judge names the place; this checks the passage it read actually says so.
 * It is the location twin of `showsParticipationInPassage`, and it exists
 * because a small model reliably picks the WRONG sentence: on a live turn it
 * named "the dock" — correctly, the player was sitting on one — and cited
 * "I lower myself to sit a few feet from you", which names no place at all,
 * while the same passage contained "I stay leaning against the brick wall
 * beside the open dock door".
 *
 * Searching the source for the property is still verification, not invention:
 * the model chose the place, and a place that is merely mentioned cannot
 * produce a sentence which names it AND puts the viewpoint at it. It also
 * subsumes (a) — a name absent from the prose can match no sentence.
 */
export function passageSituatesViewpoint(
  place: string,
  prose: string,
  options: { people?: string[] } = {},
): boolean {
  const text = String(prose || '')
  if (!text.trim() || !String(place || '').trim()) return false
  for (const sentence of text.split(/(?<=[.!?\u2026])\s+|\n+/)) {
    const trimmed = sentence.trim()
    if (!trimmed) continue
    if (!excerptNamesPlace(place, trimmed)) continue
    if (excerptSituatesViewpoint(place, trimmed, options)) return true
  }
  return false
}


/**
 * The player's OWN statement of where they are, quoted verbatim.
 *
 * The narrator is told `CURRENT PLACE: <cursor>` on every turn. When the cursor
 * is stale and the player writes their own movement, the narrator follows the
 * cursor and retcons them back — and the prose it produces then re-confirms the
 * stale cursor to every post-stream extractor. That is a closed loop: a wrong
 * cursor manufactures the evidence that keeps it wrong, and no extractor
 * improvement can break it, because by the time the extractors run the fiction
 * has already been written the wrong way.
 *
 * The pre-stream path that was supposed to prevent this required the player's
 * destination to match `PHYSICAL_DESTINATION_WORD` — a place vocabulary that,
 * unlike the OTHER place vocabulary in the same file, does not contain "bridge".
 * So "I walk to the canal bridge" produced no movement commitment at all, and a
 * whole world's map sat in a bar for a dozen turns because of a missing word in
 * one of two lists that disagree.
 *
 * This names no places. It finds a first-person clause whose subject is the
 * viewpoint and whose predicate carries a locative or directional preposition,
 * and returns THAT SPAN of the player's own words. The narrator is handed the
 * quote, not a resolved place — nothing is minted, nothing is validated against
 * a vocabulary, and a player who writes an imaginary place gets prose about it
 * exactly as they would if they had written it as a plain action.
 */
const POSITION_PREPOSITION = new Set([...LOCATIVE_PREPOSITION, 'into', 'onto', 'to', 'toward', 'towards', 'from'])


/** Coordinators and clause markers end the noun phrase. */
const SPAN_STOP = new Set(['and', 'but', 'then', 'while', 'as', 'so', 'or', 'before', 'after', 'until', 'because'])

export function extractStatedPosition(
  playerInput: string | null | undefined,
  options: { people?: string[] } = {},
): string | null {
  const raw = String(playerInput || '').replace(/[*_`~]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!raw) return null
  for (const clause of raw.split(/[,;:.!?]/)) {
    const trimmed = clause.trim()
    if (!trimmed || INTENT_MARKER.test(trimmed.toLocaleLowerCase())) continue
    const tokens = trimmed.split(/\s+/)
    const lower = tokens.map((token) => token.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '').toLocaleLowerCase())
    const subjectAt = lower.findIndex((token) => VIEWPOINT_TOKEN.has(token))
    if (subjectAt < 0) continue
    const prepAt = lower.findIndex((token, i) => i > subjectAt && POSITION_PREPOSITION.has(token))
    if (prepAt < 0) continue
    // Take the preposition and its noun phrase only — stop at a coordinator, a
    // second preposition, or six tokens.
    let end = prepAt + 1
    while (end < tokens.length && end < prepAt + 6) {
      const token = lower[end]
      if (SPAN_STOP.has(token) || (end > prepAt + 1 && POSITION_PREPOSITION.has(token))) break
      end++
    }
    const span = tokens.slice(prepAt, end).join(' ').trim()
    const words = span.split(/\s+/).filter(Boolean)
    if (words.length < 2) continue
    // "at Soren" is a person, not a position. Two filters, neither a vocabulary:
    // the caller's own cast when it supplies one, and the shape of the noun
    // phrase — a position takes a determiner ("under THE bridge", "to MY room"),
    // while a bare capitalised name after a preposition is somebody. A named
    // place without a determiner ("to Milan") is passed over rather than
    // guessed at; the explicit-destination path already covers those.
    const objectTokens = new Set(lower.slice(prepAt + 1, end).filter(Boolean))
    const people = (options.people || []).flatMap((name) =>
      comparable(name).split(/\s+/).filter((token) => token.length >= 3),
    )
    if (people.some((token) => objectTokens.has(token))) continue
    const objectWords = tokens.slice(prepAt + 1, end)
    const hasDeterminer = objectWords.some((word) =>
      DETERMINER.has(word.replace(/^[^\p{L}']+|[^\p{L}']+$/gu, '').toLocaleLowerCase()),
    )
    if (!hasDeterminer) continue
    return span
  }
  return null
}
