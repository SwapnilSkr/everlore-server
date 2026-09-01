import { callLLM, AI_MODELS } from '../../src/ai'
import { isEphemeralPersonDescriptor, isNonPersonRole, type CharacterCodexDelta } from '../../src/services/character-codex.service'
import type { CharacterIdentityKind, RelationshipMeterKey } from '../../src/models/character-profile.model'
import { classifyPresenceCodexGaps, isActionableMention } from './presence-gap-detector'
import { isAbstractNonPersonTerm, isLabelLike } from '../../src/utils/person-identity'
import {
  relationshipEvidenceBindsToCharacter,
  relationshipInitializationFromEvidence,
  relationshipStateFromEvidence,
} from '../../src/utils/relationship-baseline'

type ExistingCharacter = {
  canonical_name: string
  identity_kind?: CharacterIdentityKind
  /** Label disambiguator + continuity clock, both read by resolveIdentityScope. */
  identity_scope?: string
  last_seen_sequence?: number
  /** Labels this person used to go by; kept resolvable only through continuity. */
  former_labels?: string[]
  aliases?: string[]
  role?: string
  appearance?: string
  persona?: string
  disposition_to_player?: string
  /** Server-owned cumulative relationship state. It informs the extractor's
   * proposed small delta; the extractor never sets an absolute meter value. */
  relationship?: {
    trust: number
    affection: number
    fear: number
    rivalry: number
  }
  relationship_moments?: Array<{
    meter: 'trust' | 'affection' | 'fear' | 'rivalry'
    delta: number
    sequence: number
  }>
  relationship_state?: { summary: string; evidence: string; tags?: string[] }
  relationship_facts?: Array<{ statement: string; evidence: string; tags?: string[]; sequence: number; status: 'active' | 'retired' }>
  /** Current status snapshot the extractor must reconcile (supersede stale items). */
  mutable_state?: string[]
  /** Permanent history; provided for context so new facts aren't duplicated. */
  immutable_facts?: string[]
}

/** Lowercase, strip punctuation to spaces, collapse runs — for grounding checks. */
function normForMatch(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** True when `name` (a proper name/epithet) literally appears in the turn text.
 *  Phrase match on the normalized strings, so "mysterious man" (coined from mood)
 *  fails even though the bare word "man" is present. */
function nameAppearsInText(name: string, normText: string): boolean {
  const n = normForMatch(name)
  if (!n || n.length < 2) return false
  return normText.includes(` ${n} `) || normText.startsWith(`${n} `) || normText.endsWith(` ${n}`) || normText === n
}

/**
 * A quoted self-introduction is unusually strong evidence that a named person
 * has physically entered this beat. It is deliberately narrower than a simple
 * name mention: off-screen relatives, remembered people, locations, and mood
 * labels cannot satisfy it. This is the safe escape hatch when the metadata
 * pass has not yet placed a just-introduced character in `presentCast`.
 */
export function isDirectSelfIntroduction(
  name: string,
  prose: string,
  playerInput = '',
): boolean {
  const candidate = String(name || '').trim()
  if (!candidate || candidate.length < 3) return false
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const explicit = new RegExp(
    `(?:^|["“][^"”]{0,220}|[.!?]\\s*)(?:I\\s+am|I['’]m|my\\s+name\\s+is|you\\s+may\\s+call\\s+me)\\s+${escaped}(?=\\b|[,.;!?”])`,
    'i',
  ).test(String(prose || ''))
  if (explicit) return true
  // A compact dialogue tag can be a genuine self-identification even when the
  // narrator uses the conventional “\"Enzo,\" he says” rather than “I am Enzo.”
  // Accept it only as the direct answer to the player's identity question; without
  // that turn-level context it could merely be someone calling another person.
  const asksIdentity = /\b(?:who\s+(?:are|might)\s+you|what(?:'s|\s+is)\s+your\s+name|what\s+should\s+i\s+call\s+you|may\s+i\s+ask\s+your\s+name)\b/i
    .test(String(playerInput || ''))
  if (!asksIdentity) return false
  return new RegExp(
    `["“]\\s*${escaped}\\s*[,!.]?["”]?\\s*,?\\s*(?:\\*[^*]{0,180}\\*\\s*)?(?:he|she|they)\\s+(?:said|says|replied|replies|answered|answers)\\b`,
    'i',
  ).test(String(prose || ''))
}

const RELATIVE_WORDS = [
  'sister', 'brother', 'mother', 'father', 'mom', 'dad', 'parent', 'daughter',
  'son', 'wife', 'husband', 'spouse', 'partner', 'twin', 'cousin', 'aunt',
  'uncle', 'grandmother', 'grandfather', 'grandma', 'grandpa',
]

const RELATIONAL_EPITHET_KEYS = new Set(RELATIVE_WORDS.map(normForMatch))

function isRelationalEpithet(name: string | null | undefined): boolean {
  const normalized = normForMatch(String(name || '')).replace(/^(?:the|my|his|her|their)\s+/, '')
  return RELATIONAL_EPITHET_KEYS.has(normalized)
}

/** A literal name used in direct address ("Mara, …") or an explicit naming
 * phrase is strong enough to make the name canonical over a role label. This
 * deliberately does not promote any capitalized word: the codex extractor must
 * already have connected it as an alias of a relative/role in its structured
 * output. */
function isDirectlyNamedInProse(name: string, prose: string): boolean {
  const candidate = String(name || '').trim()
  if (!candidate || candidate.length < 2) return false
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return new RegExp(
    `(?:["“]|\\b(?:named|called)\\s+)${escaped}(?=\\s*[,!?."”]|\\b)`,
    'i',
  ).test(String(prose || ''))
}

/**
 * The extraction model is allowed to say that `Sister` and `Mara` are the same
 * person, but a player-facing card should use Mara as its canonical identity.
 * Convert that high-confidence role→proper-name association into the stable
 * correction shape understood by the event-sourced codex fold.
 */
export function promoteProperNameOverRole(
  delta: CharacterCodexDelta,
  knownByName: Map<string, string>,
  prose: string,
): CharacterCodexDelta {
  const roleLabel = delta.name
  if (!isRelationalEpithet(roleLabel)) return delta
  const properAlias = (delta.aliases || []).find(
    (alias) => !isRelationalEpithet(alias) && isDirectlyNamedInProse(alias, prose),
  )
  if (!properAlias) return delta

  const existingRoleCard = knownByName.get(normForMatch(delta.resolved_name || roleLabel))
  return {
    ...delta,
    name: properAlias.trim(),
    aliases: [roleLabel, ...(delta.aliases || [])],
    // When the role card already exists, this is a rename rather than a new
    // person. If it does not exist yet, create the named person directly.
    resolved_name: existingRoleCard || undefined,
  }
}

export function isPlayerMentionedRelative(
  delta: CharacterCodexDelta,
  playerInput: string,
  aiResponse: string,
): boolean {
  const input = normForMatch(playerInput)
  // The relative's NAME may be supplied by the narration answering the player —
  // e.g. player asks "what's my sister's name again?" and the AI says "Mira".
  // Match the name across the whole turn, but require the RELATION ("my sister")
  // to come from the player's own framing so we only block the player's relatives.
  const turn = normForMatch(`${playerInput || ''} ${aiResponse || ''}`)
  const names = [delta.name, delta.resolved_name || '', ...(delta.aliases || [])]
    .map(normForMatch)
    .filter(Boolean)
  if (!input || names.length === 0) return false
  const role = normForMatch(delta.role || '')
  const relationInRole = RELATIVE_WORDS.some((r) => role.includes(r))
  const possessiveRelation = RELATIVE_WORDS.some((r) =>
    input.includes(` my ${r} `) ||
    input.endsWith(` my ${r}`) ||
    input.includes(` player s ${r} `) ||
    input.includes(` player ${r} `),
  )
  if (!relationInRole && !possessiveRelation) return false
  return names.some((n) => turn.includes(` ${n} `) || turn.endsWith(` ${n}`) || turn.startsWith(`${n} `))
}

/** Determiners that mark a phrase as a REFERENCE to a kind of person rather than
 *  a name for one. A proper name does not take an article ("the Mara" is not a
 *  thing English says); a common-noun label almost always does. */
const DETERMINER_PREFIX = /^(?:the|a|an|some|that|this|another|one)\s+/i

/** Characters that may sit between a sentence boundary and the word that opens
 *  the sentence — quotes, the italic asterisks the narrator writes in, brackets. */
const OPENING_MARKS = /["“”'‘’*_(\[\s]/

/**
 * Is the match at `index` the first word of a sentence? Scan back over opening
 * marks and whitespace: if we reach the start of the text or a terminator, the
 * word is sentence-initial and its capital letter carries NO information about
 * whether it is a proper name.
 */
function isSentenceInitial(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const ch = text[i]
    if (OPENING_MARKS.test(ch)) continue
    return /[.!?…:;\n]/.test(ch)
  }
  return true
}

/**
 * What the PROSE says about a person-label, judged structurally rather than
 * against a word list.
 *
 * English capitalizes a proper name or an honorific everywhere it appears, and
 * capitalizes a common noun only at the start of a sentence or a line of
 * dialogue. So the way the story itself writes a label is the evidence:
 *
 *   "the rider dismounts"          → 'common'  (a kind of person)
 *   "the Rider dismounts"          → 'proper'  (the author made it a title)
 *   "Merchant Voss dismounts"      → 'proper'
 *   "the iron merchant of Ashford" → 'proper'  (a capitalized token qualifies it)
 *   label never occurs in prose    → 'absent'
 *
 * Sentence-initial occurrences are ignored on purpose: "Rider looked up." tells
 * us nothing. A label seen ONLY there returns 'absent' and the caller falls back
 * to the determiner.
 *
 * This replaces a hardcoded 58-word English vocabulary that was wrong in both
 * directions — it blocked "knight" (a real recurring character in half the
 * fantasy worlds on the platform, with no way onto the roster) while letting
 * "rider", "herald", "outrider" and every non-English or invented role through.
 * A world model for an open platform cannot carry a list of what people are
 * called.
 */
export function labelCapitalizationEvidence(
  phrase: string,
  prose: string,
): 'proper' | 'common' | 'absent' {
  const words = String(phrase || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const text = String(prose || '')
  if (!words.length || !text) return 'absent'
  const pattern = new RegExp(
    `(?<![A-Za-z])${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')}(?![A-Za-z])`,
    'gi',
  )
  let sawLowercase = false
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0
    const span = match[0]
    // Any capitalized word INSIDE the span makes the whole label specific: the
    // capital in "iron merchant of Ashford" is what separates a named trader
    // from any trader. Skip only a capital that is merely sentence-initial.
    let offset = 0
    let proper = false
    for (const token of span.split(/(\s+)/)) {
      if (token.trim() && /^[A-Z]/.test(token) && !isSentenceInitial(text, at + offset)) {
        proper = true
        break
      }
      offset += token.length
    }
    if (proper) return 'proper'
    if (/^[a-z]/.test(span)) sawLowercase = true
  }
  return sawLowercase ? 'common' : 'absent'
}

/**
 * True when a card name is a bare common-noun label for a kind of person
 * ("the rider", "a guard", "the man in a dark suit") rather than an identity.
 * A one-off passer-by named only by function is not a Bonds card.
 *
 * This is NOT a permanent exclusion. A label that keeps coming back earns a
 * card through the recurrence path instead (see `isEligibleRecurringPromotion`
 * and the promotable block in the extraction prompt) — recurrence, not a name,
 * is what proves a person matters.
 */
export function isBareDescriptorName(name: string | null | undefined, prose = ''): boolean {
  const raw = String(name || '').trim()
  if (!raw) return false
  const hadDeterminer = DETERMINER_PREFIX.test(raw)
  const head = raw.replace(DETERMINER_PREFIX, '').trim()
  if (!head) return false
  const evidence = labelCapitalizationEvidence(head, prose)
  if (evidence === 'proper') return false
  if (evidence === 'common') return true
  // No usable evidence in the prose (a coined or off-screen label): the article
  // the model itself chose is the only remaining signal.
  return hadDeterminer
}

/**
 * Is this stored entity name a LABEL for a kind of person ("the rider") rather
 * than a name for one ("Rider Voss")? Unlike {@link isBareDescriptorName} there
 * is no prose to consult here — only the name the witness tier recorded — so the
 * test is the label's own casing: a proper name or an authored epithet carries a
 * capital ("the Rider"), a common noun does not.
 *
 * Used only to decide who must clear the HIGHER promotion bar, so the failure
 * mode is asymmetric by design: a script without letter case reads as unnamed
 * and is simply held to more evidence, never waved through.
 */
export function looksLikeUnnamedLabel(name: string | null | undefined): boolean {
  return isLabelLike(name)
}

/**
 * A figure the story keeps returning to can earn a codex card on RECURRENCE
 * alone — off-screen, and named or not. Recurrence plus direct involvement is
 * what proves a person matters to the story; a proper name is only a proxy for
 * it, and a bad one (a rider the player duels across three turns has no name; a
 * shopkeeper named once in passing does).
 *
 * The caller decides what earns a place on `promotableNames`, and holds unnamed
 * figures to a higher bar than named ones — see the promotable query in
 * generation.processor.ts. This function only checks membership, so a one-off
 * mention can still never self-promote.
 */
export function isEligibleRecurringPromotion(
  candidateNames: string[],
  promotableNames: string[],
): boolean {
  // Matched with the determiner stripped on BOTH sides. The stored label and the
  // one the extractor returns disagree about "the" constantly ("the rider" vs
  // "rider"), and an article is never what makes two people different — letting
  // it decide promotion made the whole path a coin flip.
  const key = (n: string) => normForMatch(n).replace(/^(?:the|a|an|some)\s+/, '')
  const allowed = new Set(promotableNames.map(key).filter(Boolean))
  return candidateNames.map(key).some((name) => name && allowed.has(name))
}


/**
 * How many turns a label-only identity stays "live". Past this, a bare label
 * appearing in the prose is more likely a NEW person than the return of one the
 * story dropped — the rider you duelled in chapter one is not the rider blocking
 * the ford thirty turns later just because the narrator used the same noun.
 */
export const IDENTITY_SCOPE_STALE_TURNS = 12




/**
 * Does this single word read as a bare TITLE rather than a name?
 *
 * A title leads other people's names ("Ser Roland") and is written lowercase
 * when it stands on its own ("as you say, ser"). A name is capitalized wherever
 * it stands alone. So the evidence is only the STANDALONE occurrences — the ones
 * not immediately followed by another capitalized word — because in "Ser Roland"
 * the capital belongs to Roland's name, not to Ser.
 *
 * Sentence-initial standalone occurrences prove nothing and are skipped, exactly
 * as in {@link labelCapitalizationEvidence}. No list of honorifics: Ser, Archon,
 * Kaptan and whatever the next world invents are judged by their own prose.
 */
export function readsAsBareTitle(token: string, prose: string): boolean {
  const word = String(token || '').trim()
  if (!word || /\s/.test(word)) return false
  const text = String(prose || '')
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, 'gi')
  let sawStandaloneLowercase = false
  let sawStandaloneProper = false
  for (const match of text.matchAll(re)) {
    const at = match.index ?? 0
    const after = text.slice(at + match[0].length)
    // "Ser Roland" — the next word is capitalized, so this occurrence is a
    // modifier on somebody else's name and says nothing about this word.
    if (/^\s+[A-Z][a-z]/.test(after)) continue
    if (/^[a-z]/.test(match[0])) sawStandaloneLowercase = true
    else if (!isSentenceInitial(text, at)) sawStandaloneProper = true
  }
  return sawStandaloneLowercase && !sawStandaloneProper
}

/**
 * A person known only by a LABEL may be given a proper name only when the prose
 * actually says that name is theirs.
 *
 * Without this the promotion is the model's judgement alone, and the failure is
 * silent and permanent: "the rider" who serves House Thorne becomes a card named
 * "Thorne", fusing an envoy with the lord he answers to, and every bond either
 * of them earns lands on one card. The prose is full of proper nouns that are
 * NOT the speaker — houses, lords spoken of in the third person, places.
 *
 * Accepted as proof, both already used for relational epithets:
 *   - a self-introduction  ("I am Aldric" / the answer to "what's your name?")
 *   - a literal naming     (quoted address `"Aldric,"` or "a man named Aldric")
 * A name that merely APPEARS nearby proves nothing.
 *
 * Returns the evidence kind, or null when the promotion is unsupported.
 */
export function namePromotionEvidence(
  name: string,
  prose: string,
  playerInput: string,
): 'self_introduction' | 'named_in_prose' | null {
  const candidate = String(name || '').trim()
  if (candidate.length < 2) return null
  if (isDirectSelfIntroduction(candidate, prose, playerInput)) return 'self_introduction'
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const text = String(prose || '')
  // "a rider named Aldric" / "the man they called Aldric"
  if (new RegExp(`\\b(?:named|called)\\s+${escaped}\\b`, 'i').test(text)) return 'named_in_prose'
  // A VOCATIVE: the name stands alone as the thing being said — it must be
  // followed by punctuation, not by more of a phrase. This is the whole
  // difference between «"Aldric, hold there."» and «"Blackstone Keep is yours"»,
  // where the opening quote sits in front of a name that belongs to a castle.
  if (new RegExp(`["“,]\\s*${escaped}\\s*[,.!?;:]`, 'i').test(text)) return 'named_in_prose'
  return null
}

/**
 * A label someone USED to go by still points at them — but only while nobody
 * else holds it and the story has kept them warm.
 *
 * Releasing "the rider" from Aldric's aliases is what stops a stranger inheriting
 * his bond. It must not also stop the player from calling him "rider". So the
 * former label resolves by CONTINUITY rather than by ownership: if Aldric is in
 * the scene, or was recently, and no current rider is competing for the word,
 * it is him. Expressed as an explicit resolved_name so the ledger records the
 * decision and a rewind replays it.
 */
export function resolveFormerLabelHolder(params: {
  label: string
  sequence: number
  presentCast: string[]
  existing: Array<{
    canonical_name: string
    aliases?: string[]
    former_labels?: string[]
    identity_scope?: string
    last_seen_sequence?: number
  }>
}): string | undefined {
  const key = normForMatch(params.label).replace(/^(?:the|a|an|some)\s+/, '')
  if (!key) return undefined
  const strip = (n: string) => normForMatch(n).replace(/^(?:the|a|an|some)\s+/, '')
  // Anyone currently identified BY this label owns it outright; a former holder
  // never competes with the person the story is using the word for right now.
  const activeHolder = params.existing.some((c) =>
    [c.canonical_name, ...(c.aliases || [])].some((n) => strip(n) === key),
  )
  if (activeHolder) return undefined
  const present = new Set(params.presentCast.map(strip))
  const holders = params.existing.filter((c) =>
    (c.former_labels || []).some((n) => strip(n) === key),
  )
  // Ambiguous between two former holders is not a guess worth making.
  if (holders.length !== 1) return undefined
  const holder = holders[0]
  const warm =
    present.has(strip(holder.canonical_name)) ||
    params.sequence - (holder.last_seen_sequence ?? 0) <= IDENTITY_SCOPE_STALE_TURNS
  return warm ? holder.canonical_name : undefined
}

/**
 * Decide which identity a label-only delta belongs to, and return the scope that
 * decision implies. This is the character analog of AREA-scoped location
 * resolution (resolveLocationAnchor): reuse-vs-mint is a judgement, and the
 * unique index is only the race-safe enforcement of it.
 *
 * Deterministic and computed BEFORE the ledger write, so a rewind replays the
 * same split — the scope travels in the delta, never re-derived at read time.
 *
 * Named people are unaffected: a proper name is its own identity, so this
 * returns undefined and every downstream key reduces to what it was before.
 */
export function resolveIdentityScope(params: {
  delta: CharacterCodexDelta
  sequence: number
  existing: Array<{ canonical_name: string; aliases?: string[]; identity_scope?: string; last_seen_sequence?: number }>
  prose: string
}): string | undefined {
  const { delta, sequence, existing, prose } = params
  // Only label-only identities need disambiguating.
  if (!isBareDescriptorName(delta.name, prose)) return undefined
  // An explicit correction ("this IS the rider you know") is the model telling us
  // the identity outright; honour it and inherit that card's scope.
  const keys = [delta.resolved_name || '', delta.name, ...(delta.aliases || [])]
    .map(normForMatch)
    .filter(Boolean)
  const match = existing.find((c) =>
    [c.canonical_name, ...(c.aliases || [])].map(normForMatch).some((n) => n && keys.includes(n)),
  )
  if (!match) return `s${sequence}`
  if ((delta.resolved_name || '').trim()) return match.identity_scope || `s${sequence}`
  // Continuity is the test: a label the story has kept warm refers to the person
  // holding it. A cold one has been released back to the world.
  const lastSeen = match.last_seen_sequence ?? 0
  const live = sequence - lastSeen <= IDENTITY_SCOPE_STALE_TURNS
  return live ? match.identity_scope || `s${lastSeen || sequence}` : `s${sequence}`
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw)
  } catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return {}
    try {
      return JSON.parse(m[0])
    } catch {
      return {}
    }
  }
}

const METER_KEYS = ['trust', 'affection', 'fear', 'rivalry'] as const

/** Minimum normalized length for a SALVAGED evidence fragment. Deliberately
 *  above the 8 required of a whole verbatim quote: a partial quote must carry
 *  more text, not less, before it can back a bond change. */
const MIN_SALVAGED_EVIDENCE = 12

function toRelationshipDeltas(raw: any): CharacterCodexDelta['relationship_deltas'] {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, number> = {}
  for (const key of METER_KEYS) {
    const v = Number((raw as Record<string, unknown>)[key])
    if (!Number.isFinite(v) || v === 0) continue
    out[key] = Math.max(-10, Math.min(10, Math.round(v)))
  }
  return Object.keys(out).length ? out : undefined
}

function toRelationshipEvidence(
  raw: any,
  deltas: CharacterCodexDelta['relationship_deltas'],
  sourceText: string,
): CharacterCodexDelta['relationship_evidence'] {
  if (!raw || typeof raw !== 'object' || !deltas) return undefined
  const source = normForMatch(sourceText)
  const out: Record<string, string> = {}
  for (const key of METER_KEYS) {
    if (typeof deltas[key] !== 'number') continue
    const evidence = typeof raw[key] === 'string' ? raw[key].trim().slice(0, 180) : ''
    const normalized = normForMatch(evidence)
    // Evidence must be a substantial literal excerpt from this turn. This
    // rejects model-supplied rationales that were never actually narrated.
    if (normalized.length >= 8 && source.includes(normalized)) {
      out[key] = evidence
      continue
    }
    // Near miss: the quote is real but stitched. Models routinely splice two
    // narrated fragments into one tidy line ('"Don\'t," she whispers. "Please."'
    // quoted as "Don't, please."), which is not contiguous in the source and
    // used to void the whole meter silently. Fall back to the longest fragment
    // of the model's own quote that IS contiguous in this turn — still strictly
    // evidence-bound, just no longer all-or-nothing.
    const salvaged = longestSourceBackedFragment(evidence, source)
    if (salvaged) out[key] = salvaged
  }
  return Object.keys(out).length ? out : undefined
}

/** Longest run of the model's quote that appears verbatim in this turn. Split
 *  on the quote's own punctuation, then grow the longest contiguous window of
 *  adjacent fragments that the source still contains. Returns null when no
 *  fragment clears MIN_SALVAGED_EVIDENCE — a stricter bar than a whole quote
 *  gets, so salvage can never admit weaker evidence than the exact path. */
function longestSourceBackedFragment(evidence: string, normalizedSource: string): string | null {
  const pieces = evidence
    .split(/[.,;:!?—–\n"'\u2018\u2019\u201c\u201d*]+/)
    .map((piece) => piece.trim())
    .filter(Boolean)
  if (pieces.length < 2) return null
  let best: string | null = null
  for (let start = 0; start < pieces.length; start++) {
    for (let end = pieces.length; end > start; end--) {
      const window = pieces.slice(start, end).join(' ').trim()
      const normalized = normForMatch(window)
      if (normalized.length < MIN_SALVAGED_EVIDENCE) continue
      if (!normalizedSource.includes(normalized)) continue
      if (!best || normalized.length > normForMatch(best).length) best = window
      break
    }
  }
  return best
}

function toInteractionHints(raw: any): CharacterCodexDelta['interaction_hints'] {
  if (!Array.isArray(raw)) return undefined
  const out: NonNullable<CharacterCodexDelta['interaction_hints']> = []
  for (const hint of raw) {
    const labelTemplate = typeof hint?.label_template === 'string'
      ? hint.label_template.trim().slice(0, 140)
      : ''
    const question = typeof hint?.question === 'string'
      ? hint.question.trim().slice(0, 240)
      : ''
    const sourceState = typeof hint?.source_state === 'string'
      ? hint.source_state.trim().slice(0, 160)
      : ''
    if (!labelTemplate || !question || !sourceState) continue
    out.push({
      label_template: labelTemplate,
      question,
      source_state: sourceState,
    })
    if (out.length >= 3) break
  }
  return out
}

const RELATION_KIND_SET = new Set([
  'parent_of', 'child_of', 'sibling_of', 'partner_of', 'progenitor_of',
  'descendant_of', 'superior_of', 'subordinate_of', 'kin_of', 'bonded_of',
])

/** Parse the turn-level relation_assertions array (typed kinship ties). Keeps only
 *  well-formed entries with two endpoints and a recognized structural kind. */
function toRelationAssertions(raw: any): CharacterCodexDelta['relation_assertions'] {
  if (!Array.isArray(raw)) return undefined
  const out: NonNullable<CharacterCodexDelta['relation_assertions']> = []
  for (const r of raw) {
    const from = typeof r?.from === 'string' ? r.from.trim() : ''
    const to = typeof r?.to === 'string' ? r.to.trim() : ''
    const kind = typeof r?.kind === 'string' ? r.kind.trim().toLowerCase() : ''
    if (!from || !to || !RELATION_KIND_SET.has(kind)) continue
    if (from.toLowerCase() === to.toLowerCase()) continue // no self-relations
    out.push({
      from,
      to,
      kind,
      label: typeof r?.label === 'string' ? r.label.trim().slice(0, 60) : undefined,
      gender: ['m', 'f', 'n'].includes(String(r?.gender)) ? String(r.gender) : undefined,
      polarity: r?.polarity === 'sever' ? 'sever' : 'assert',
      source: r?.source === 'character_claim' ? 'character_claim' : 'narrator',
    })
    if (out.length >= 8) break
  }
  return out.length ? out : undefined
}

function toRelationshipFactAdditions(
  raw: unknown,
  sourceText: string,
  name: string,
  aliases: string[],
): NonNullable<CharacterCodexDelta['relationship_fact_additions']> | undefined {
  const list = Array.isArray((raw as any)?.add) ? (raw as any).add : []
  const out: NonNullable<CharacterCodexDelta['relationship_fact_additions']> = []
  for (const entry of list) {
    const state = relationshipStateFromEvidence({
      summary: (entry as any)?.statement,
      evidence: (entry as any)?.evidence,
      tags: (entry as any)?.tags,
    }, sourceText)
    if (!state || !relationshipEvidenceBindsToCharacter({ name, aliases, evidence: state.evidence, sourceText })) continue
    out.push({ statement: state.summary, evidence: state.evidence, tags: state.tags })
    if (out.length >= 3) break
  }
  return out.length ? out : undefined
}

/** Fold adjudicator supplements into the reviewed candidate list. A supplement
 *  naming a character already in the list contributes only the meters (and bond
 *  facts) that character does not already carry; one naming a new character is
 *  appended as its own entry. */
export function mergeSupplements(reviewed: unknown[], supplements: unknown[]): unknown[] {
  if (!supplements.length) return reviewed
  const out = [...reviewed]
  const indexByName = new Map<string, number>()
  out.forEach((item, index) => {
    for (const field of ['resolved_name', 'name']) {
      const key = normForMatch(String((item as any)?.[field] || ''))
      if (key && !indexByName.has(key)) indexByName.set(key, index)
    }
  })
  for (const supplement of supplements) {
    const key = normForMatch(String((supplement as any)?.name || ''))
    const at = key ? indexByName.get(key) : undefined
    if (at === undefined) {
      out.push(supplement)
      continue
    }
    const target = { ...(out[at] as Record<string, unknown>) }
    const targetDeltas = (target.relationship_deltas || {}) as Record<string, unknown>
    const targetEvidence = (target.relationship_evidence || {}) as Record<string, unknown>
    const supplementDeltas = ((supplement as any)?.relationship_deltas || {}) as Record<string, unknown>
    const supplementEvidence = ((supplement as any)?.relationship_evidence || {}) as Record<string, unknown>
    const deltas = { ...targetDeltas }
    const evidence = { ...targetEvidence }
    for (const meter of METER_KEYS) {
      // Already claimed by the candidate — adding the supplement's value on top
      // would count the same beat twice.
      if (Number(targetDeltas[meter]) || !Number(supplementDeltas[meter])) continue
      deltas[meter] = supplementDeltas[meter]
      if (supplementEvidence[meter]) evidence[meter] = supplementEvidence[meter]
    }
    target.relationship_deltas = deltas
    target.relationship_evidence = evidence
    const supplementFacts = (supplement as any)?.relationship_facts
    if (supplementFacts && !target.relationship_facts) target.relationship_facts = supplementFacts
    out[at] = target
  }
  return out
}

/** Strip only the bond fields from a codex candidate, leaving the rest of the
 *  card update intact. Used when the relationship adjudicator rejects a bond
 *  claim: its remit is the bond, not the character. */
export function withoutRelationshipFields(item: unknown): unknown {
  if (!item || typeof item !== 'object') return item
  const {
    relationship_deltas: _deltas,
    relationship_evidence: _evidence,
    relationship_initialization: _initialization,
    relationship_state: _state,
    relationship_facts: _facts,
    ...rest
  } = item as Record<string, unknown>
  return rest
}

/** Drop only the named meters from a candidate's bond proposal, leaving the
 *  other meters — and the rest of the card — untouched. */
export function withoutMeters(item: unknown, meters: Set<RelationshipMeterKey>): unknown {
  if (!item || typeof item !== 'object') return item
  const record = item as Record<string, unknown>
  const strip = (field: unknown): unknown => {
    if (!field || typeof field !== 'object') return field
    const kept = Object.fromEntries(
      Object.entries(field as Record<string, unknown>).filter(
        ([key]) => !meters.has(key as RelationshipMeterKey),
      ),
    )
    return Object.keys(kept).length ? kept : undefined
  }
  return {
    ...record,
    relationship_deltas: strip(record.relationship_deltas),
    relationship_evidence: strip(record.relationship_evidence),
  }
}

/** A narrow second opinion for relationship mutations only. It never rewrites
 * prose and runs after it has streamed. Existing proposed changes are rejected
 * only on an explicit verdict; a supported omitted direct interaction may be
 * returned as a small supplement and then passes the same server validators. */
async function adjudicateRelationshipProposals(params: {
  sourceText: string
  existing: ExistingCharacter[]
  proposed: unknown[]
}): Promise<{ rejected: Map<number, Set<RelationshipMeterKey> | 'all'>; supplements: unknown[] }> {
  const candidates = params.proposed
    .map((item, index) => ({
      index,
      name: (item as any)?.name,
      relationship_initialization: (item as any)?.relationship_initialization,
      relationship_deltas: (item as any)?.relationship_deltas,
      relationship_evidence: (item as any)?.relationship_evidence,
      relationship_facts: (item as any)?.relationship_facts,
    }))
    .filter((item) => item.relationship_initialization || item.relationship_deltas || item.relationship_facts)
  let raw = ''
  try {
    raw = await callLLM({
      model: AI_MODELS.metadata,
      temperature: 0,
      maxTokens: 700,
      responseFormat: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are a conservative relationship-event adjudicator. Review only direct player↔character bond changes. Reject a proposal ONLY when the SOURCE does not actually show that named character undergoing that change — a wrong character, an invented interaction, or a change nothing in the source supports. Judge the SUBSTANCE, not the transcription: a quote that is trimmed, lightly re-punctuated, or spliced from two adjacent lines is NOT grounds for rejection so long as the source really shows the interaction, and it is not your job to verify quotes character-by-character. Never reject a well-supported change merely because its excerpt is imprecise. You may add a supplement only for a clearly missed direct interaction, with exact contiguous evidence. Never infer motives, indirect atmosphere, or changes without proof. A proposal may move several meters at once; judge EACH METER SEPARATELY and reject only the ones the source does not support — never discard a well-supported meter because a different meter on the same character is wrong. Return ONLY JSON: {"reject":[{"index":candidate index,"meters":["only the unsupported meter names"]}],"supplements":[{"name":"existing or present character name","relationship_deltas":{"trust":integer,"affection":integer,"fear":integer,"rivalry":integer},"relationship_evidence":{"trust":"exact contiguous quote","affection":"exact contiguous quote","fear":"exact contiguous quote","rivalry":"exact contiguous quote"},"relationship_facts":{"add":[{"statement":"concise bond fact","evidence":"exact quote","tags":["tag"]}],"retire":[]} }]}.' ,
        },
        {
          role: 'user',
          content: `EXISTING CHARACTERS:\n${JSON.stringify(params.existing.slice(0, 16).map((c) => ({ name: c.canonical_name, aliases: c.aliases || [], bond: c.relationship_state?.summary || null })))}\n\nPROPOSED:\n${JSON.stringify(candidates)}\n\nSOURCE:\n${params.sourceText.slice(0, 7000)}`,
        },
      ],
    })
  } catch {
    return { rejected: new Map(), supplements: [] }
  }
  const parsed = parseJsonObject(raw) as any
  // Accepts both shapes: a bare index rejects the whole bond (the original
  // contract), an { index, meters } object rejects only the meters it names.
  const rejected = new Map<number, Set<RelationshipMeterKey> | 'all'>()
  for (const entry of Array.isArray(parsed.reject) ? parsed.reject : []) {
    const index = Number.isInteger(entry) ? (entry as number) : Number((entry as any)?.index)
    if (!Number.isInteger(index) || !candidates.some((candidate) => candidate.index === index)) continue
    const rawMeters = Array.isArray((entry as any)?.meters) ? (entry as any).meters : null
    if (!rawMeters) {
      rejected.set(index, 'all')
      continue
    }
    const meters = new Set<RelationshipMeterKey>(
      rawMeters.filter((meter: unknown): meter is RelationshipMeterKey =>
        (METER_KEYS as readonly string[]).includes(String(meter)),
      ),
    )
    const existingEntry = rejected.get(index)
    if (existingEntry === 'all') continue
    if (!meters.size) {
      rejected.set(index, 'all')
      continue
    }
    if (existingEntry) for (const meter of existingEntry) meters.add(meter)
    rejected.set(index, meters)
  }
  return { rejected, supplements: Array.isArray(parsed.supplements) ? parsed.supplements.slice(0, 2) : [] }
}

function toDelta(raw: any, sourceText: string): CharacterCodexDelta | null {
  const name = typeof raw?.name === 'string' ? raw.name.trim() : ''
  if (!name) return null
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.map(String) : []
  const relationshipDeltas = toRelationshipDeltas(raw.relationship_deltas)
  const relationshipEvidence = toRelationshipEvidence(
    raw.relationship_evidence,
    relationshipDeltas,
    sourceText,
  )
  const evidenceBackedDeltas = relationshipDeltas
    ? Object.fromEntries(
        Object.entries(relationshipDeltas).filter(([key]) =>
          !!relationshipEvidence?.[key as keyof NonNullable<typeof relationshipDeltas>],
        ),
      ) as CharacterCodexDelta['relationship_deltas']
    : undefined
  const proposedInitialization = relationshipInitializationFromEvidence(
    raw.relationship_initialization,
    sourceText,
  )
  const relationshipInitialization = proposedInitialization && relationshipEvidenceBindsToCharacter({
    name,
    aliases,
    evidence: proposedInitialization.evidence,
    sourceText,
  }) ? proposedInitialization : undefined
  const proposedState = relationshipStateFromEvidence(raw.relationship_state, sourceText)
  const relationshipState = proposedState && relationshipEvidenceBindsToCharacter({
    name,
    aliases,
    evidence: proposedState.evidence,
    sourceText,
  }) ? proposedState : undefined
  const relationshipFactAdditions = toRelationshipFactAdditions(raw.relationship_facts, sourceText, name, aliases)
  const relationshipFactRetire = Array.isArray(raw.relationship_facts?.retire)
    ? raw.relationship_facts.retire.map(String).map((value: string) => value.trim().slice(0, 320)).filter((value: string) => value.length >= 12).slice(0, 3)
    : undefined
  const relationshipUpdateAllowed = !!relationshipInitialization || Object.keys(evidenceBackedDeltas || {}).length > 0
  return {
    name,
    identity_kind:
      raw.identity_kind === 'proper_name' || raw.identity_kind === 'epithet' || raw.identity_kind === 'role_label' || raw.identity_kind === 'kinship_label'
        ? raw.identity_kind
        : undefined,
    aliases,
    resolved_name: typeof raw.resolved_name === 'string' ? raw.resolved_name.trim() : undefined,
    role: typeof raw.role === 'string' ? raw.role.trim() : undefined,
    appearance: typeof raw.appearance === 'string' ? raw.appearance.trim() : undefined,
    persona: typeof raw.persona === 'string' ? raw.persona.trim() : undefined,
    immutable_facts: Array.isArray(raw.immutable_facts)
      ? raw.immutable_facts.map(String).slice(0, 6)
      : [],
    mutable_state: Array.isArray(raw.mutable_state)
      ? raw.mutable_state.map(String).slice(0, 6)
      : [],
    interaction_hints: toInteractionHints(raw.interaction_hints),
    retire_state: Array.isArray(raw.retire_state)
      ? raw.retire_state.map(String).slice(0, 6)
      : [],
    disposition_to_player:
      typeof raw.disposition_to_player === 'string' ? raw.disposition_to_player.trim() : undefined,
    hidden_thought: typeof raw.hidden_thought === 'string' ? raw.hidden_thought.trim() : undefined,
    relationship_deltas: evidenceBackedDeltas && Object.keys(evidenceBackedDeltas).length
      ? evidenceBackedDeltas
      : undefined,
    relationship_evidence: relationshipEvidence,
    relationship_initialization: relationshipInitialization,
    relationship_state: relationshipState && relationshipUpdateAllowed
      ? relationshipState
      : undefined,
    relationship_fact_additions: relationshipFactAdditions && relationshipUpdateAllowed
      ? relationshipFactAdditions
      : undefined,
    relationship_fact_retire: relationshipFactRetire && relationshipUpdateAllowed
      ? relationshipFactRetire
      : undefined,
    is_protagonist: raw.is_protagonist === true,
  }
}

/**
 * Force a correction delta into the ONE canonical shape the ledger replay expects:
 * `resolved_name` = the EXISTING canonical name being corrected, `name` = the NEW
 * corrected proper name. The extractor's LLM is inconsistent across turns — it may
 * emit a rename (e.g. Mara→Mira) with the two names swapped, or stash the old name
 * in `aliases`. If replay sees these inconsistent shapes it can't converge on which
 * name is canonical. We resolve that deterministically HERE, on ingest, before the
 * atom is written to the ledger, using the known roster to decide which side is the
 * pre-existing canonical and which is the new name.
 *
 * Returns the (possibly rewritten) delta, or null when the shape is a genuine
 * correction that can't be coerced (ambiguous: neither or both sides match a known
 * card) — the caller logs a warn and skips it so a malformed correction never
 * corrupts the ledger. Non-correction deltas (no `resolved_name`, or `resolved_name`
 * equals `name`) are returned unchanged.
 */
function canonicalizeCorrectionShape(
  delta: CharacterCodexDelta,
  knownByName: Map<string, string>,
): CharacterCodexDelta | null {
  const resolved = (delta.resolved_name || '').trim()
  const name = (delta.name || '').trim()
  // Not a correction: no resolved_name, or it points at the same identity as name.
  if (!resolved || !name) return delta
  if (normForMatch(resolved) === normForMatch(name)) return delta

  // Which side names a card that ALREADY exists? The canonical shape demands the
  // existing side live in resolved_name and the new side in name.
  const resolvedCanon = knownByName.get(normForMatch(resolved))
  const nameCanon = knownByName.get(normForMatch(name))

  // resolved_name is the existing canonical (or an alias of it) and name is new —
  // already canonical. Pin resolved_name to the registry's canonical spelling so
  // foldDelta's rename branch matches target.canonical_name exactly.
  if (resolvedCanon && !nameCanon) {
    return resolvedCanon === resolved ? delta : { ...delta, resolved_name: resolvedCanon }
  }

  // SWAPPED: name is the existing card and resolved_name is the new corrected name.
  // Flip them into the canonical shape. The old canonical (now in resolved_name's
  // slot's value `nameCanon`) goes to resolved_name; the new name to name.
  if (nameCanon && !resolvedCanon) {
    return { ...delta, name: resolved, resolved_name: nameCanon }
  }

  // Both surfaces can already map to the SAME card when a previous turn stored
  // the proper name as an alias of a role-first card (Sister ↔ Mara). That is an
  // unambiguous promotion, not a conflicting correction: preserve the existing
  // canonical target in resolved_name so the fold can rename it safely.
  if (resolvedCanon && nameCanon) {
    return resolvedCanon === nameCanon
      ? { ...delta, resolved_name: resolvedCanon }
      : null
  }
  // Neither matches: not a correction into an existing card — leave untouched.
  return delta
}

/**
 * Extract emergent NPC codex updates from a turn's player input + narration.
 * Returns compact deltas that can be merged into canonical character cards.
 */
export async function extractCharacterCodexDeltas(params: {
  playerInput: string
  aiResponse: string
  existing: ExistingCharacter[]
  /** Seed prompt of a sentient world — describes the main persona the player
   *  talks TO. Lets the extractor tag that card as the protagonist instead of
   *  treating it like a random NPC. Omit/empty for Game Master worlds. */
  seedPrompt?: string
  isSentient?: boolean
  /** Name of the locked protagonist. For GM worlds this is the PLAYER's own
   *  character — the extractor must track their evolving state and tag them. */
  protagonistName?: string
  /** Player persona name (sentient worlds): the human in the conversation.
   *  They must NEVER become a codex card — the codex tracks the world's cast. */
  playerPersonaName?: string
  /** Canonical names of the characters physically present in the scene THIS turn.
   *  Lets the extractor resolve a bare descriptor ("the man", "the woman") to the
   *  person it can only be — the anchor that stops invented duplicate cards. */
  presentCast?: string[]
  /** Known locations are excluded from person corroboration even when prose
   * personifies them ("Milan greeted him"). */
  knownLocations?: { name: string; aliases?: string[] }[]
  /** Character entities with repeated provenance but no codex card — named, or
   *  unnamed and corroborated by direct involvement. Recurrence, not a name. */
  promotableRecurringPeople?: string[]
  /** This turn's sequence — the clock identity scoping is judged against. */
  sequence?: number
  /** Test-only raw-response observer; never changes production extraction. */
  onRaw?: (raw: string) => void
}): Promise<CharacterCodexDelta[]> {
  const { playerInput, aiResponse, existing, seedPrompt, isSentient, protagonistName, playerPersonaName, presentCast, knownLocations, promotableRecurringPeople, sequence } = params

  const existingText = existing.length
    ? existing
      .map((c) => {
        const aliases = (c.aliases || []).join(', ')
        const state = (c.mutable_state || []).filter(Boolean)
        const stateLine = state.length ? `\n    current state: ${state.join('; ')}` : ''
        const bond = c.relationship
        const bondLine = bond
          ? `\n    bond state toward player: trust ${bond.trust}/100, affection ${bond.affection}/100, fear ${bond.fear}/100, rivalry ${bond.rivalry}/100`
          : ''
        const bondContextLine = c.relationship_state?.summary
          ? `\n    bond context: ${c.relationship_state.summary}`
          : ''
        const bondFactsLine = (c.relationship_facts || [])
          .filter((fact) => fact.status === 'active')
          .slice(-6)
          .map((fact) => fact.statement)
        const bondJournalLine = bondFactsLine.length
          ? `\n    active bond facts (retire only by exact statement): ${bondFactsLine.join(' | ')}`
          : ''
        const recentShifts = (c.relationship_moments || [])
          .slice(-4)
          .map((moment) => `${moment.meter} ${moment.delta >= 0 ? '+' : ''}${moment.delta} at turn ${moment.sequence}`)
        const bondHistoryLine = recentShifts.length
          ? `\n    recent evidence-backed bond shifts: ${recentShifts.join('; ')}`
          : ''
        return `- ${c.canonical_name}${c.identity_kind ? ` (identity kind: ${c.identity_kind})` : ''}${aliases ? ` (aliases: ${aliases})` : ''}${c.role ? ` role: ${c.role}` : ''}${stateLine}${bondLine}${bondContextLine}${bondJournalLine}${bondHistoryLine}`
      })
      .join('\n')
    : '(none yet)'

  const presentList = (presentCast || []).map((n) => (n || '').trim()).filter(Boolean)
  const presentBlock = presentList.length
    ? `\nPRESENT THIS TURN (these exact people are in the scene now): ${presentList.join(', ')}.\nA bare descriptor in the narration ("the man", "the woman", "the figure", "the stranger", "the boy") almost always refers to one of these present people — resolve it to them, never to a new card.\n`
    : ''
  const promotableRecurringBlock = (promotableRecurringPeople || []).length
    ? `\nREPEATED FIGURES THIS STORY HAS ALREADY ESTABLISHED (each has several grounded mentions and real involvement; create or update their card even when they are not physically present this turn): ${(promotableRecurringPeople || []).join(', ')}.
- If one of them has a proper name, card them under it.
- If one is still UNNAMED, card them anyway, with identity_kind "role_label". The story returning to them has already established them as a real, tracked person — do NOT wait for a name, and do NOT skip them because their label is generic.
- Name that card with the MOST SPECIFIC label the prose actually uses for them ("the grey-bearded rider", "the Thorne outrider"), never a bare one ("the rider") when a distinguishing one exists, and list the bare label in "aliases". Two different people who share a bare label MUST NOT share a card: if this turn's figure is a DIFFERENT person from a listed one with a similar label, say so with a distinguishing name of their own and set no "resolved_name".
- When a proper name for one of them appears later, return that name with "resolved_name" set to their existing label, so the SAME card is promoted rather than duplicated.\n`
    : ''

  const protagonistBlock =
    isSentient && seedPrompt && seedPrompt.trim().length > 0
      ? `
MAIN CHARACTER (PROTAGONIST):
This is a sentient world. The player is in conversation WITH a single main character, described by the world's seed prompt below. When you extract THAT character, set "is_protagonist": true and resolve all of their aliases/titles to the same card (never split them). Track their evolving state (relationships, powers, status) accurately. Every other character is a side character with "is_protagonist": false.
THE PLAYER IS NOT A CHARACTER: the human player${playerPersonaName && playerPersonaName.trim() ? ` (who may be called "${playerPersonaName.trim()}")` : ''} is the person the main character talks to. NEVER create a card for the player, under any name, role, or title — "disposition_to_player" and "relationship_deltas" already capture how characters relate to them.
--- SEED PROMPT ---
${seedPrompt.trim().slice(0, 800)}
--- END SEED PROMPT ---
`
      : protagonistName && protagonistName.trim()
        ? `
PROTAGONIST (THE PLAYER): The player's own character is named "${protagonistName.trim()}". Treat them as a tracked character: set "is_protagonist": true for them, and update their evolving state from the turn — relationships formed/ended, powers gained, status changes (e.g. married, wounded, exiled). Everyone else is a side character with "is_protagonist": false.
ONE PERSON, ONE CARD — CRITICAL: the narration addresses the player in second person. "You"/"your" IS "${protagonistName.trim()}". So is any role title, epithet, or description the premise or narration uses for the player's role (e.g. "the heir", "the neglected son", "the stranger"). When the narration refers to the player by ANY such referent, resolve it to the "${protagonistName.trim()}" card via "resolved_name" — NEVER create a separate card for the player, their role, or "you". A new card is only ever for a DIFFERENT person the player can meet.${seedPrompt && seedPrompt.trim() ? `
--- WORLD PREMISE (defines the player's role — referents of this role are the player) ---
${seedPrompt.trim().slice(0, 800)}
--- END WORLD PREMISE ---` : ''}
`
        : ''

  const system = `You maintain an RPG character codex. Extract character updates from the turn.

Rules:
- Include non-player characters and entities (and the protagonist described below).
- ALWAYS create or update a card for any NAMED character who appears, speaks, or is referenced this turn — even with sparse detail. Do not skip newly introduced characters; capturing them promptly keeps the story consistent.
- Prefer resolving to existing characters when aliases/titles/pronouns refer to the same person; never split one character into two cards. Before creating a NEW card, check whether the name is actually a title, epithet, or description of someone already listed (or of the player) — if so, use "resolved_name" instead of a new card.
- identity_kind: classify the literal identity used for this card: proper_name (Mara, Captain Rhea), epithet (The Mysterious Man), role_label (Butler, Guard), or kinship_label (Mother, Sister). This is durable metadata; do not infer it from capitalization alone. A literal proper name always outranks a kinship/role label for the SAME person. If prose says Sister and later directly addresses her as "Mara, ...", output name: "Mara", identity_kind: "proper_name", aliases: ["Sister"], role: "sibling". If an existing card is named "Sister", use resolved_name: "Sister" with name: "Mara" so it is promoted instead of duplicated. Keep a role label canonical only while no literal proper name has appeared.
- Generic RELATIONAL or ROLE epithets — "the sister", "his sister", "Sister", "the twin", "Mother", "the father", "the guard", "the innkeeper" — are NOT a new person when the existing roster already has a character in that role. A shorter or vaguer label ("Sister") and a more specific one ("Twin Sister") for the same family role are the SAME person. Resolve the epithet to that existing card with "resolved_name"; never create a second card alongside it. Worked example: the roster already lists "Twin Sister"; this turn the narration says "his sister scoffed" → return that character with "resolved_name": "Twin Sister" (do NOT mint a separate "Sister" card).
- A named relative mentioned only by the player as off-screen background ("my sister is Mara", "my brother keeps the locket") is NOT a codex card yet. Store that as a memory, not a Bonds card. Create/update the relative only if they physically appear, speak, act, or are already in the existing roster.
- NEVER INVENT A NAME — NON-NEGOTIABLE. A character's "name" must be a proper name or fixed epithet that LITERALLY appears in this turn's text (player input or narration). NEVER coin a label from the scene's mood, tone, or an action — do NOT produce names like "Mysterious Man", "The Stranger", "Hooded Figure", "The Visitor", "Shadowy Man" unless those exact words appear in the text. A character being secretive, unnamed, or vague is STILL one of the existing roster / present cast — describe their secrecy in their fields, do not give them a new identity.
- A BARE DESCRIPTOR IS NEVER A NEW PERSON when a matching character is already present/listed. "the man", "the woman", "the figure", "the stranger", "the boy/girl", "the older man" → resolve to the present-cast or roster member it can only be (e.g. the only adult male in the room), via "resolved_name". This is the #1 source of accidental duplicates and is FORBIDDEN. Worked example: PRESENT THIS TURN includes "Father"; the narration says *the man tilted the screen away, shielding it from view* while being cagey about his work → that "man" IS the father → return him with "resolved_name": "Father" and capture his secrecy in his state — NEVER mint a "Mysterious Man" (or any new) card for him.
- Return 0-6 characters (most important / most active first).
- Keep hidden_thought private/internal (never spoken aloud), short and specific to the player.
- immutable_facts: PERMANENT history/identity that never stops being true once it happens (e.g. "was engaged to Lord X", "gained pyromancy", "married Mira"). Append-only — only NEW permanent facts from this turn.
- mutable_state: the character's CURRENT status that may change later (e.g. "unattached", "wields fire magic", "wounded"). Only NEW or newly-changed current-status items from this turn.
- interaction_hints: 0-3 OPTIONAL conversation starters for the player, grounded ONLY in this character's post-turn current state. Each source_state must exactly equal one current-status item (new or already listed). Use this format: { "label_template": "Ask why {name} is irritated", "question": "You seem irritated. What's wrong?", "source_state": "irritated" }. The label_template MUST contain the exact {name} placeholder, no quotes or markup. question is the spoken question only: no quotes, no asterisks, no player actions. Use a natural, specific question; omit hints when no current state invites a conversation. Never invent a state just to create a hint.
- retire_state: CRITICAL for continuity. Copy here, VERBATIM, any item from the character's existing "current state" (shown below) that THIS TURN made false or obsolete. Example: if existing state says "engaged to Lord X" and this turn the engagement is broken, put "engaged to Lord X" in retire_state. Leave [] if nothing became false. NEVER let an outdated status linger.
- disposition_to_player: concise sentiment toward the player right now.
- relationship_initialization: ONLY when this character has no established meter state and the world seed, current player turn, or narration explicitly establishes their starting bond. Allowed kinds: best_friend, close_friend, friend, acquaintance, trusted_ally, reluctant_ally, mentor_bond, protector, dependent, romantic_partner, unrequited_attraction, ex_partner, family_warm, family_protective, family_strained, estranged, sibling_close, sibling_resentful, enemy, sworn_enemy, fearful, rival, indebted, betrayed, authority_trust. Return { "kind": one allowed kind, "evidence": "an exact short excerpt from that supplied source" }. Omit it for a stranger, uncertain relationship, or an existing meter state. Never infer it from a role alone.
- relationship_facts: ONLY alongside relationship_initialization or an evidence-backed relationship_deltas update. Return { "add": [{ "statement": "one concise, nuanced emotional truth about this bond", "evidence": "exact short excerpt from this turn or seed", "tags": ["1-4 short descriptive tags"] }], "retire": ["an EXACT existing bond-context statement this direct interaction made false"] }. These are an append/retire journal, not a replacement summary: preserve unresolved hurt, guilt, promises, or mixed feelings unless this turn directly changes them. Add 0-3 facts; omit the field when none apply. Never invent a motive or retire a fact without direct relationship evidence.
- relationship_deltas: how THIS TURN shifted the character's stance toward the player, as integer changes to four meters: trust, affection, fear, rivalry. Existing bond state and recent shifts in the roster are SERVER-OWNED continuity: use them to keep the new disposition and proposed delta proportionate. Include ONLY meters that genuinely moved after a DIRECT interaction with the player, ONLY for characters present this turn. Tension, atmosphere, a glance, or a generic smile alone NEVER changes a meter. But a direct interaction with real weight MUST be recorded — do not return all zeros for a turn where the player saved this character's life, threatened or hurt them, kissed or rejected them, confessed something, kept or broke a promise, defended or humiliated them in front of others. Judge ALL FOUR meters, not just trust: affection moves on warmth, desire, tenderness or their withdrawal; fear moves on threat, violence, intimidation or reassurance after it; rivalry moves on competition, being bested, humiliation or public defeat. A single turn may move several meters at once, and often should — a threat at gunpoint raises fear AND lowers trust. Scale: ±1-3 for small moments (kind words, minor friction), ±4-7 for significant ones (a gift, a confession, a public insult), ±8-10 ONLY for dramatic turning points (betrayal, a life saved, a vow broken). Omit the field entirely when nothing shifted. NEVER include it for the player's own protagonist card in a Game Master world (a character has no meters toward themself).
  Worked examples. The player drags a wounded character from a burning wreck and stays until medics arrive → { "trust": 8 } with evidence "You could have run. You didn't." The player holds a gun to a character's face → { "fear": 6, "trust": -5 } with evidence "She goes very still, and for the first time the clinical blue optic flickers." The player takes a contract out from under a rival in front of everyone → { "rivalry": 5 } with evidence "You will not get the next one." Two people simply talk in a bar and nothing is risked → omit the field entirely.
- relationship_evidence: for EVERY nonzero relationship_deltas meter, provide an EXACT verbatim excerpt from this turn that proves the direct interaction and change. The excerpt must be ONE unbroken run of text copied straight from the turn — never two separate fragments stitched together, never re-punctuated, never tidied up. Quote a WHOLE CLAUSE of at least four or five words ("she goes very still and the optic flickers", "You could have run. You didn't."); a one- or two-word scrap ("Don't,", "Please.") is too short to count and is thrown out. If the proof spans a gap, quote the single strongest contiguous clause. A meter whose excerpt cannot be found verbatim in the turn is DISCARDED, so an imprecise or over-short quote silently throws the bond change away. Each nonzero meter needs its own excerpt, including affection, fear, and rivalry — not only trust. If no exact excerpt exists, omit that meter. This field is mandatory for any relationship movement.
- is_protagonist: true ONLY for the world's main character (see below); otherwise false.
- relation_assertions (a TOP-LEVEL array, sibling to "characters" — NOT inside a character): typed family/relationship ties this turn ESTABLISHES or REVEALS between two specific people (or the player). Each: { from, to, kind, label, gender, source }. "from"/"to" are names from the cast; use "player" for the human player's own character. "kind" MUST be exactly one of: parent_of, child_of, sibling_of, partner_of, progenitor_of, descendant_of, superior_of, subordinate_of, kin_of, bonded_of — read as "from is to's <kind>". Worked example: "Mara is the player's sister" → { "from": "Mara", "to": "player", "kind": "sibling_of", "label": "sister", "gender": "f" }. Map ANY world-native term (clone-sister, sire, liege, bondmate, broodmother) to the CLOSEST kind and keep the native word in "label". gender: m|f|n implied by the label. source: "narrator" when the narration states the tie, "character_claim" when a character merely CLAIMS it (may be a lie). polarity: "sever" when a tie ENDS this turn (divorce, death, disownment), else omit. ONLY include a tie the text actually establishes or reveals THIS turn — do NOT re-list every relationship that already exists, and NEVER a figurative one ("like a brother to me"). Empty array [] when no tie is asserted.
${protagonistBlock}${presentBlock}
${promotableRecurringBlock}
Existing characters (with their current state and server-owned bond state — reconcile against this):
${existingText}

Respond ONLY JSON:
{
  "characters": [
    {
      "name": "string",
      "identity_kind": "proper_name|epithet|role_label|kinship_label",
      "resolved_name": "string optional; use canonical existing name when this is an alias/title",
      "aliases": ["string"],
      "role": "string",
      "appearance": "string",
      "persona": "string",
      "immutable_facts": ["string"],
      "mutable_state": ["string"],
      "interaction_hints": [{ "label_template": "Ask why {name} is irritated", "question": "You seem irritated. What's wrong?", "source_state": "irritated" }],
      "retire_state": ["existing current-state items that are now false/obsolete"],
      "disposition_to_player": "string",
      "hidden_thought": "string",
      "relationship_deltas": { "trust": 0, "affection": 0, "fear": 0, "rivalry": 0 },
      "relationship_evidence": { "trust": "exact words from the turn", "affection": "exact words from the turn", "fear": "exact words from the turn", "rivalry": "exact words from the turn" },
      "relationship_initialization": { "kind": "close_friend", "evidence": "my close friend" },
      "relationship_facts": { "add": [{ "statement": "A close friend who is protective but worried about the player.", "evidence": "my close friend", "tags": ["protective", "worried"] }], "retire": [] },
      "is_protagonist": false
    }
  ],
  "relation_assertions": [
    { "from": "Mara", "to": "player", "kind": "sibling_of", "label": "sister", "gender": "f", "source": "narrator" }
  ]
}`

  let raw: string
  try {
    raw = await callLLM({
      model: AI_MODELS.codexExtraction,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `Player input:\n${playerInput || '(none)'}\n\nNarration:\n${aiResponse}`,
        },
      ],
      temperature: 0.2,
      maxTokens: 900,
      responseFormat: { type: 'json_object' },
    })
  } catch {
    return []
  }
  params.onRaw?.(raw)

  const parsed = parseJsonObject(raw)
  const rawList: unknown[] = Array.isArray((parsed as any).characters) ? (parsed as any).characters : []
  const sourceText = `${seedPrompt || ''}\n${playerInput || ''}\n${aiResponse || ''}`
  const adjudication = await adjudicateRelationshipProposals({
    sourceText,
    existing,
    proposed: rawList,
  })
  // A rejection is a verdict on the BOND ONLY, and on only the meters it names.
  // The adjudicator reviews nothing else, so a rejected candidate keeps its card
  // update (appearance, state, hints, facts) and loses just the meters actually
  // faulted — dropping the whole entry threw away unrelated codex work, and
  // dropping every meter threw away well-evidenced ones, every time a single
  // quote looked shaky.
  const reviewed = rawList.map((item, index) => {
    const verdict = adjudication.rejected.get(index)
    if (!verdict) return item
    return verdict === 'all' ? withoutRelationshipFields(item) : withoutMeters(item, verdict)
  })
  // A supplement for someone the extractor ALREADY proposed is merged into that
  // entry, never appended beside it: foldDelta applies every entry in turn to
  // the same card, so two entries naming one character would apply their meters
  // twice. The candidate's own meters win; the supplement only fills gaps.
  const list = mergeSupplements(reviewed, adjudication.supplements)

  // Deterministic anti-duplication backstop (defends the prompt rules above):
  // a brand-new card is only allowed when its name (or an alias) actually appears
  // in this turn's text. A name the model COINED from the scene's mood
  // ("Mysterious Man") — not grounded in the prose — is never a real new person
  // when a roster already exists; it is a duplicate of someone already carded.
  // Drop the phantom mint; the genuine character is re-emitted on adjacent turns.
  const normText = normForMatch(`${playerInput || ''} ${aiResponse || ''}`)
  // The RAW turn, case intact: descriptor detection reads the story's own
  // capitalization, which normalization would destroy.
  const turnText = `${playerInput || ''}\n${aiResponse || ''}`
  const knownNames = new Set<string>()
  // Map every known name/alias (normalized) → its CANONICAL spelling, so a
  // correction's two names can each be resolved to a single canonical identity
  // before the atom is written. Keyed identically to the codex registry.
  const knownByName = new Map<string, string>()
  for (const c of existing) {
    const canon = c.canonical_name
    knownNames.add(normForMatch(canon))
    if (canon) knownByName.set(normForMatch(canon), canon)
    for (const a of c.aliases || []) {
      knownNames.add(normForMatch(a))
      if (canon && a) knownByName.set(normForMatch(a), canon)
    }
  }
  for (const n of presentCast || []) knownNames.add(normForMatch(n))
  const existingNames = new Set(knownByName.keys())
  const knownPlaceNames = (knownLocations || []).flatMap((place) => [
    place.name,
    ...(place.aliases || []),
  ]).map(normForMatch).filter(Boolean)
  // A fresh card needs independent PERSON evidence, not just a metadata-model
  // assertion that a capitalized word was present. This is the promotion seam:
  // new people remain automatically discovered, but only after speech/action/
  // person-possessive/title evidence corroborates the name in the prose.
  const personEvidenceKeys = new Set(
    classifyPresenceCodexGaps(aiResponse, {
      codex: existing.flatMap((c) => [c.canonical_name, ...(c.aliases || [])]),
      exclude: knownPlaceNames,
    })
      .filter(isActionableMention)
      .map((candidate) => normForMatch(candidate.key)),
  )
  const resolvesToKnown = (d: CharacterCodexDelta): boolean => {
    const cands = [d.resolved_name || '', d.name, ...(d.aliases || [])].map(normForMatch)
    return cands.some((c) => c && knownNames.has(c))
  }
  const resolvesToExisting = (d: CharacterCodexDelta): boolean => {
    const cands = [d.resolved_name || '', d.name, ...(d.aliases || [])].map(normForMatch)
    return cands.some((c) => c && existingNames.has(c))
  }

  const out: CharacterCodexDelta[] = []
  for (const item of list) {
    let delta = toDelta(item, sourceText)
    if (!delta) continue
    delta = promoteProperNameOverRole(delta, knownByName, aiResponse)
    // Enforce the ONE canonical correction shape (resolved_name = existing
    // canonical, name = new corrected name) before the atom reaches the ledger,
    // so rebuildCodexFromLedger always converges. A correction that can't be
    // coerced (both names already canonical) is skipped with a warn.
    const canonical = canonicalizeCorrectionShape(delta, knownByName)
    if (!canonical) {
      console.warn(
        `[codex-extractor] skipped ambiguous correction (both "${delta.name}" and "${delta.resolved_name}" are known cards — cannot determine canonical target)`,
      )
      continue
    }
    delta = canonical
    if (isNonPersonRole(delta.role)) {
      console.warn(`[codex-extractor] blocked non-person card "${delta.name}" (role: ${delta.role})`)
      continue
    }
    if (
      delta.resolved_name != null &&
      normForMatch(delta.name) !== normForMatch(delta.resolved_name) &&
      isEphemeralPersonDescriptor(delta.name)
    ) {
      console.warn(
        `[codex-extractor] held descriptor identity guess "${delta.name}" → "${delta.resolved_name}"; explicit reveal evidence is required`,
      )
      continue
    }
    const isNewCard = delta.is_protagonist !== true && !resolvesToExisting(delta)
    if (
      isNewCard &&
      isAbstractNonPersonTerm(delta.name) &&
      !isDirectSelfIntroduction(delta.name, aiResponse, playerInput)
    ) {
      console.warn(`[codex-extractor] blocked personified abstract noun "${delta.name}"`)
      continue
    }
    // Recurrence is checked BEFORE the descriptor block, not after: a label the
    // story keeps coming back to has already earned its card, and the whole point
    // of the promotable list is that being unnamed no longer disqualifies it.
    const promotableKeys = [delta.name, delta.resolved_name || '', ...(delta.aliases || [])]
      .map(normForMatch)
      .filter(Boolean)
    const recurringPromotion = isEligibleRecurringPromotion(
      promotableKeys,
      promotableRecurringPeople || [],
    )
    if (delta.is_protagonist !== true && !resolvesToKnown(delta) && !recurringPromotion) {
      // A bare role/descriptor for a kind of person ("the merchant", "a guard")
      // is a passer-by on first sight, not a tracked character — never mint a
      // card for it. Judged against the prose itself (see isBareDescriptorName),
      // so this holds in any world whose roles we have never heard of. If they
      // keep turning up, the promotable list above lets them through instead.
      if (
        isBareDescriptorName(delta.name, turnText) &&
        isBareDescriptorName(delta.resolved_name || delta.name, turnText)
      ) {
        console.warn(
          `[codex-extractor] blocked bare-descriptor card "${delta.name}" (passer-by, not a tracked character)`,
        )
        continue
      }
      const presentNames = new Set((presentCast || []).map(normForMatch))
      const appearsPresent = [delta.name, delta.resolved_name || '', ...(delta.aliases || [])]
        .map(normForMatch)
        .some((n) => n && presentNames.has(n))
      if (!appearsPresent && isPlayerMentionedRelative(delta, playerInput, aiResponse)) {
        console.warn(
          `[codex-extractor] blocked absent player-relative card "${delta.name}" (memory fact, not present cast)`,
        )
        continue
      }
    }
    if (isNewCard) {
      const candidateKeys = [delta.name, delta.resolved_name || '', ...(delta.aliases || [])]
        .map(normForMatch)
        .filter(Boolean)
      const presentNames = new Set((presentCast || []).map(normForMatch))
      const physicallyPresent = candidateKeys.some((name) => presentNames.has(name))
      const corroboratedPerson = candidateKeys.some((name) => personEvidenceKeys.has(name))
      const directSelfIntroduction = [delta.name, delta.resolved_name || '', ...(delta.aliases || [])]
        .some((name) => isDirectSelfIntroduction(name, aiResponse, playerInput))
      // A literal in-scene self-introduction is both presence and person
      // evidence. It is the only exception to the usual two-source gate, so a
      // named walk-on is not lost just because the independent metadata pass
      // missed them on their entrance.
      if ((!physicallyPresent || !corroboratedPerson) && !directSelfIntroduction && !recurringPromotion) {
        console.warn(
          `[codex-extractor] held uncorroborated new card "${delta.name}" (present=${physicallyPresent}, personEvidence=${corroboratedPerson}, directIntro=${directSelfIntroduction})`,
        )
        continue
      }
    }
    // A NEW card (resolves to no known/present character) MUST be grounded in the
    // text. Protagonist-tagged deltas are exempt (handled by the one-protagonist
    // invariant downstream). When the roster is empty there is nothing to dup, so
    // the guard only engages once a cast exists.
    if (knownNames.size > 0 && delta.is_protagonist !== true && !resolvesToKnown(delta)) {
      const grounded =
        nameAppearsInText(delta.name, normText) ||
        (delta.aliases || []).some((a) => nameAppearsInText(a, normText)) ||
        (delta.resolved_name ? nameAppearsInText(delta.resolved_name, normText) : false)
      if (!grounded) {
        console.warn(
          `[codex-extractor] blocked ungrounded new card "${delta.name}" (not in turn text; likely a duplicate of an existing/present character)`,
        )
        continue
      }
    }
    // A promotion from a LABEL to a proper name is only as good as its evidence.
    // Strip an unsupported one rather than dropping the delta: the turn's real
    // content (bond movement, state) still belongs on the card — it just keeps
    // the label it had.
    {
      const targetLabel = (delta.resolved_name || '').trim()
      if (targetLabel && !isLabelLike(delta.name) && isLabelLike(targetLabel)) {
        const holder = existing.find((c) =>
          [c.canonical_name, ...(c.aliases || [])].map(normForMatch).includes(normForMatch(targetLabel)),
        )
        const labelIdentified =
          !!holder &&
          (isLabelLike(holder.canonical_name) ||
            holder.identity_kind === 'role_label' ||
            holder.identity_kind === 'kinship_label')
        if (labelIdentified && !namePromotionEvidence(delta.name, aiResponse, playerInput)) {
          console.warn(
            `[codex-extractor] refused unsupported promotion "${targetLabel}" -> "${delta.name}" (no self-introduction or literal naming in the turn)`,
          )
          const rejected = normForMatch(delta.name)
          delta.name = holder!.canonical_name
          delta.resolved_name = undefined
          delta.identity_kind = holder!.identity_kind
          delta.aliases = (delta.aliases || []).filter((a) => normForMatch(a) !== rejected)
        }
      }
    }

    // A NAMED person must not collect a bare TITLE as an alias. The prose calls
    // the protagonist "ser" the way it calls a dozen other knights "ser", so
    // storing it as his alias makes every later lone "Ser" resolve to him.
    //
    // Judged the same structural way as everything else here: a word the story
    // writes in lowercase is a common noun, not a name. No list of honorifics —
    // Ser, Archon, Kaptan and whatever the next world invents are all covered by
    // how their own prose spells them. Multi-word aliases are left alone: they
    // are specific enough to identify somebody ("the grey-bearded rider").
    if (!isLabelLike(delta.name) && (delta.aliases || []).length) {
      const kept = (delta.aliases || []).filter((alias) => {
        const t = String(alias || '').trim()
        if (!t) return false
        if (t.split(/\s+/).length > 1) return true
        return !readsAsBareTitle(t, turnText)
      })
      if (kept.length !== (delta.aliases || []).length) {
        const dropped = (delta.aliases || []).filter((a) => !kept.includes(a))
        console.warn(
          `[codex-extractor] dropped bare-title alias(es) ${JSON.stringify(dropped)} from "${delta.name}" (the prose lowercases them)`,
        )
      }
      delta.aliases = kept
    }

    // Decide which identity this label belongs to and record it IN the delta, so
    // the ledger carries the split and a rewind reproduces it.
    if (typeof sequence === 'number') {
      // A bare label the model did not resolve may still belong to someone who
      // has since been named. Settle that BEFORE scoping, so it resolves to them
      // instead of opening a new identity.
      if (!(delta.resolved_name || '').trim() && isBareDescriptorName(delta.name, turnText)) {
        const formerHolder = resolveFormerLabelHolder({
          label: delta.name,
          sequence,
          presentCast: presentCast || [],
          existing: existing.map((c) => ({
            canonical_name: c.canonical_name,
            aliases: c.aliases,
            former_labels: (c as { former_labels?: string[] }).former_labels,
            identity_scope: (c as { identity_scope?: string }).identity_scope,
            last_seen_sequence: (c as { last_seen_sequence?: number }).last_seen_sequence,
          })),
        })
        if (formerHolder) {
          delta.resolved_name = formerHolder
          delta.identity_kind = undefined
        }
      }
      const scope = resolveIdentityScope({
        delta,
        sequence,
        existing: existing.map((c) => ({
          canonical_name: c.canonical_name,
          aliases: c.aliases,
          identity_scope: (c as { identity_scope?: string }).identity_scope,
          last_seen_sequence: (c as { last_seen_sequence?: number }).last_seen_sequence,
        })),
        prose: turnText,
      })
      if (scope) delta.identity_scope = scope
    }
    out.push(delta)
    if (out.length >= 6) break
  }
  // Turn-level kinship ties ride on the first delta (the kinship graph collects
  // them via flatMap; they persist on the codex_deltas ledger for free, so a
  // rewind replays the relationship graph too). Consumed by kinship-graph.service,
  // never by the codex fold itself.
  const relationAssertions = toRelationAssertions((parsed as any).relation_assertions)
  if (relationAssertions && out.length > 0) {
    out[0].relation_assertions = relationAssertions
  }
  return out
}
