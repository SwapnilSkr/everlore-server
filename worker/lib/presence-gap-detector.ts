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

/**
 * Is this capitalized token a COMMON NOUN the prose merely happened to
 * capitalize (a sentence opener like "Guards rushed in", a title case run)
 * rather than somebody's name?
 *
 * The evidence is the prose's own usage: if the same word also appears in
 * lowercase anywhere in the passage, the story is treating it as a kind of
 * thing, not as a name. This replaces a hardcoded list of English role nouns,
 * which could never cover an open platform's worlds — it blocked "knight" and
 * "merchant" while passing "rider", "outrider", "acolyte" and every invented or
 * non-English role.
 *
 * Deliberately one-directional: only positive lowercase evidence removes a
 * candidate. A name seen once at a sentence start stays a candidate, because
 * this is the high-recall witness tier where a missed person is the costly
 * error and a surplus stub is cheap (archiveStaleStubs reaps the one-offs).
 */
export function readsAsCommonNoun(token: string, prose: string): boolean {
  const word = String(token || '').trim()
  if (word.length < 3) return false
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z])${escaped.toLowerCase()}(?![A-Za-z])`).test(String(prose || ''))
}

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
  // common sentence-initial / dialogue-opening words that capitalize but are not
  // names — kept out of the candidate set so they don't surface as mentions.
  'everyone', 'everything', 'everybody', 'someone', 'something', 'somebody',
  'anyone', 'anything', 'nobody', 'nothing', 'none', 'all', 'both', 'each',
  'get', 'go', 'come', 'stop', 'wait', 'look', 'listen', 'please', 'thanks',
  'okay', 'maybe', 'perhaps', 'well', 'let', 'lets', 'don', 'do', 'did',
  'have', 'has', 'had', 'will', 'would', 'could', 'should', 'must', 'can',
  'never', 'always', 'sometimes', 'soon', 'later', 'before', 'after',
  'good', 'bad', 'sure', 'fine', 'right', 'left', 'maybe', 'enough',
])

const FAMILY_ROLE_EQUIV: Record<string, string> = {
  dad: 'father',
  daddy: 'father',
  papa: 'father',
  pop: 'father',
  pops: 'father',
  mom: 'mother',
  mommy: 'mother',
  mum: 'mother',
  mama: 'mother',
  momma: 'mother',
  grandma: 'grandmother',
  grandpa: 'grandfather',
  sibling: 'sibling',
  sister: 'sister',
  brother: 'brother',
  father: 'father',
  mother: 'mother',
  parent: 'parent',
  parents: 'parent',
  'twin sister': 'sister',
  'twin brother': 'brother',
  twin: 'sibling',
}

function coverageKeys(name: string): string[] {
  const key = normalizeName(name)
  if (!key) return []
  const stripped = key.replace(/^(?:the|a|an|my|your|his|her|their|our)\s+/, '').trim()
  const role = FAMILY_ROLE_EQUIV[stripped]
  return role ? [key, `role:${role}`] : [key]
}

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
    if (isAbstractNonPersonTerm(key)) continue
    if (readsAsCommonNoun(t, text) && !FAMILY_ROLE_WORDS.has(key)) continue
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
    for (const key of coverageKeys(n)) covered.add(key)
  }
  return visibleNameCandidatesDetailed(prose).filter((c) =>
    coverageKeys(c.key).every((key) => !covered.has(key)),
  )
}

export function detectPresenceCodexGaps(prose: string, tracked: TrackedNames): string[] {
  return detectPresenceCodexGapsDetailed(prose, tracked).map((c) => c.key)
}

/**
 * Confidence tier for a person the prose surfaces but the turn didn't already
 * track. `confirmed` — the prose shows them acting/speaking/addressed here, so they
 * are present; `probable` — named more than once but without a strong present-signal;
 * `mentioned_only` — a single bare mention (likely talked-about, not in the room).
 *
 * ONLY `confirmed` is actionable (mints stubs / joins present_characters / ships as a
 * trackable mention) — see {@link isActionableMention}. `probable` is deliberately NOT
 * actionable: candidates are detected by CAPITALIZATION alone, so a repeated capitalized
 * word with no person-grammar signal ("Downstairs", "Upstairs", "Meanwhile") lands in
 * `probable` and would otherwise be stubbed as a person. The person-signal gate (a
 * speech/action verb, address, appositive, title, or possessive-kinship — all of which
 * promote to `confirmed`) is what tells a real walk-on apart from a capitalized adverb,
 * WITHOUT an endlessly-growing stop-word denylist. A genuinely present person reliably
 * earns a `confirmed` signal the moment they act or speak; until then this backstop
 * stays quiet and the metadata witness pass remains the primary presence source.
 */
export type MentionTier = 'confirmed' | 'probable' | 'mentioned_only'

/**
 * Whether a classified mention is strong enough to mint a stub, claim presence, and
 * surface as a backend-owned trackable mention. Person-signal gate: `confirmed` only.
 * Shared by the live generation path and the audit so the two cannot drift.
 */
export function isActionableMention(m: { tier: MentionTier }): boolean {
  return m.tier === 'confirmed'
}

export interface MentionCandidate extends VisibleNameCandidate {
  tier: MentionTier
  /** Short reason the tier was chosen — for logs/audit/debug. */
  evidence: string
  /** How many times the name appears in the prose. */
  count: number
}

const SPEECH_VERBS =
  'said|says|asked|asks|replied|replies|answered|answers|whispered|whispers|shouted|shouts|murmured|murmurs|growled|growls|muttered|mutters|called|calls|added|adds|continued|continues|cried|cries|hissed|hisses|snapped|snaps|breathed|breathes|begged|begs|warned|warns|laughed|laughs'

/**
 * Verbs that show a person DOING something in the scene.
 *
 * The list was built from a handful of examples and was far too small: a
 * character who "gave a slow nod" or "lets out a low chuckle" matched nothing,
 * so the corroboration gate refused him entry to his own scene — on a live run
 * the brother the player was talking to went missing for three consecutive
 * turns while speaking, and the physical fact naming him was rejected too.
 *
 * Deliberately restricted to BODILY and REACTIVE actions, which only make sense
 * for someone physically present. Verbs of travel (went, came, ran, left) are
 * NOT here on purpose: "Mara went to the capital" describes someone who is
 * elsewhere, and admitting that is the phantom-presence bug this gate exists to
 * stop.
 */
const ACTION_VERBS =
  'turned|turns|smiled|smiles|nodded|nods|stepped|steps|reached|reaches|leaned|leans|stood|stands|sat|sits|' +
  'moved|moves|looked|looks|glanced|glances|frowned|frowns|sighed|sighs|gripped|grips|grabbed|grabs|' +
  'walked|walks|entered|enters|approached|approaches|crossed|crosses|raised|raises|shook|shakes|' +
  'gestured|gestures|pointed|points|rose|rises|knelt|kneels|gazed|gazes|pulled|pulls|pressed|presses|' +
  'gave|gives|let|lets|shifted|shifts|shrugged|shrugs|chuckled|chuckles|snorted|snorts|' +
  'exhaled|exhales|inhaled|inhales|swallowed|swallows|blinked|blinks|straightened|straightens|' +
  'tensed|tenses|stiffened|stiffens|hesitated|hesitates|paused|pauses|watched|watches|' +
  'studied|studies|regarded|regards|tilted|tilts|lifted|lifts|dropped|drops|folded|folds|' +
  'settled|settles|sank|sinks|spat|spits|scowled|scowls|grinned|grins|smirked|smirks|' +
  'winced|winces|flinched|flinches|listened|listens|waited|waits'

const PERSON_POSSESSIONS =
  'eyes|eye|jaw|hand|hands|mouth|lips|face|smile|frown|voice|shoulders|shoulder|fingers|nails|gaze|breath|head|cheek|cheeks|brow|expression|' +
  // Worn or carried things are as good as a body part for proving someone is
  // physically here — a place cannot have a collar or a chair scrape back.
  'arm|arms|wrist|wrists|throat|chest|knuckles|knees|knee|boots|cloak|coat|sleeve|sleeves|collar|hood|belt|blade|sword|knife|reins|chair|seat'

/**
 * A thing the person OWNS doing something physical: "Halvard's chair scrapes
 * back and topples", "Mara's cup rattles against the saucer".
 *
 * The possessive rule above is deliberately restricted to a fixed noun list so
 * that civic personification ("Milan's predawn chill") is not read as a person
 * in the room. But that list can never be complete, and a live turn showed the
 * cost: the player grabbed the steward by the collar, the prose read "Halvard's
 * chair scrapes back and topples", and because "chair" was not in the list the
 * man was refused entry to his own scene — which then rejected the restraint the
 * player had just applied to him, as naming an absent actor.
 *
 * The discriminator is not WHICH noun is possessed but whether it ACTS. A chill
 * does not scrape, topple or rattle; a chair belonging to someone present does.
 */
const POSSESSED_THING_ACTS_VERBS =
  'scrapes|scraped|topples|toppled|rattles|rattled|clatters|clattered|creaks|creaked|thuds|thudded|slams|slammed|falls|fell|tightens|tightened|jerks|jerked|snaps|snapped|drops|dropped|swings|swung|hits|hit'

const TITLE_WORDS =
  'captain|king|queen|prince|princess|lord|lady|sir|dame|dr|doctor|father|mother|sister|brother|master|mistress|professor|sergeant|general|admiral|commander|duke|duchess|count|countess|baron|reverend|elder|chief'

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether the token is capitalized somewhere it ISN'T forced to be — preceded by a
 * lowercase word or a comma. A genuine proper noun keeps its capital mid-sentence
 * ("…said Mara", "Bram and Mara"); a sentence-adverb only capitalizes at the start of
 * a sentence ("Downstairs, a door slammed." / "Meanwhile, …"). Used to stop the
 * position-fragile confirmations (appositive/possessive/repeat) from promoting a
 * capitalized adverb to a tracked person — without a stop-word denylist.
 */
function appearsMidSentence(display: string, prose: string): boolean {
  return new RegExp(`[a-z0-9,]\\s+${escapeRe(display)}\\b`).test(prose)
}

/**
 * A capitalized landmark can look like a person to the generic name detector.
 * In a definite locative phrase ("near the Duomo", "inside the Louvre") it is
 * unambiguously functioning as a place.  Reject it before the person-grammar
 * checks: `Duomo, the room ...` otherwise falsely matches the broad appositive
 * rule below and mints a character stub.
 */
function appearsAsDefiniteLocation(display: string, prose: string): boolean {
  const n = escapeRe(display)
  return new RegExp(
    `\\b(?:at|in|inside|within|near|by|beside|outside|around|toward|towards|from|to|into|through|across)\\s+the\\s+${n}\\b`,
    'i',
  ).test(prose)
}

/**
 * A sentence-initial capitalized abstract can be given a human verb in normal
 * prose ("Valour answers", "Silence waits"). A second human-only signal is
 * required before that weak position can promote an unknown name to a person.
 * This intentionally prefers a missed one-line walk-on over minting a durable
 * card for a literary device.
 */
function hasIndependentPersonSignal(display: string, prose: string): boolean {
  const n = escapeRe(display)
  return (
    new RegExp(`\\b${n}(?:'s|\\u2019s)\\s+(?:${PERSON_POSSESSIONS})\\b`, 'i').test(prose) ||
    new RegExp(`\\b${n},\\s+(?:my|his|her|their|the|a|an)\\s+\\w+`, 'i').test(prose) ||
    new RegExp(`\\b(?:${TITLE_WORDS})\\s+${n}\\b`, 'i').test(prose) ||
    new RegExp(`\\b(?:my|his|her|their)\\s+\\w+\\s+${n}\\b`, 'i').test(prose)
  )
}

/** Decide the tier for one candidate display name within `prose`. */
/**
 * Does the prose show this person PARTICIPATING in the scene, as opposed to
 * merely naming them?
 *
 * This is the `confirmed` tier's evidence, exposed on its own so scene state can
 * use the same bar to admit someone to the cast. A bare mention is not presence:
 * "the untouched rations Bram had noted" is a reference to something Bram said
 * a day's ride away, and taking that as corroboration put him at the top of a
 * ruined watchtower he never visited, where carry-forward then kept him.
 *
 * Deliberately the same patterns as {@link tierFor} so the admission gate and
 * the trackable-mention gate can never drift apart.
 */
export function hasSceneParticipationGrammar(display: string, prose: string): boolean {
  return tierFor(display, String(prose || '')).tier === 'confirmed'
}

function tierFor(display: string, prose: string): { tier: MentionTier; evidence: string; count: number } {
  const n = escapeRe(display)
  const count = (prose.match(new RegExp(`\\b${n}\\b`, 'g')) || []).length
  // dialogue attribution: "Mara said" / "said Mara" → speaking here.
  if (new RegExp(`\\b${n}\\s+(?:${SPEECH_VERBS})\\b`, 'i').test(prose) ||
      new RegExp(`\\b(?:${SPEECH_VERBS})\\s+${n}\\b`, 'i').test(prose)) {
    return { tier: 'confirmed', evidence: 'dialogue attribution', count }
  }
  // action attribution: "Mara turned / reached / stepped" → acting in scene.
  if (new RegExp(`\\b${n}\\s+(?:${ACTION_VERBS})\\b`, 'i').test(prose)) {
    return { tier: 'confirmed', evidence: 'action in scene', count }
  }
  // "Nora's jaw tightened" / "Mara's smile faded" is direct evidence of a
  // person physically in the scene, without confusing civic personification
  // such as "Milan's predawn chill" for a participant.
  if (new RegExp(`\\b${n}(?:'s|\\u2019s)\\s+(?:${PERSON_POSSESSIONS})\\b`, 'i').test(prose)) {
    return { tier: 'confirmed', evidence: 'person possessive', count }
  }
  if (new RegExp(`\\b${n}(?:'s|\\u2019s)\\s+\\w+\\s+(?:${POSSESSED_THING_ACTS_VERBS})\\b`, 'i').test(prose)) {
    return { tier: 'confirmed', evidence: 'possession in motion', count }
  }
  // appositive: "Mara, my sister" / "Mara, the captain" → introduced present.
  if (new RegExp(`\\b${n},\\s+(?:my|his|her|their|the|a|an)\\s+\\w+`, 'i').test(prose)) {
    return { tier: 'confirmed', evidence: 'appositive', count }
  }
  // title-name: "Captain Rhea" / "King Orlan".
  if (new RegExp(`\\b(?:${TITLE_WORDS})\\s+${n}\\b`, 'i').test(prose)) {
    return { tier: 'confirmed', evidence: 'title-name', count }
  }
  // possessive kinship before the name: "my sister Mara".
  if (new RegExp(`\\b(?:my|his|her|their)\\s+\\w+\\s+${n}\\b`, 'i').test(prose)) {
    return { tier: 'confirmed', evidence: 'possessive kinship', count }
  }
  if (count > 1) return { tier: 'probable', evidence: 'repeated mention', count }
  return { tier: 'mentioned_only', evidence: 'single bare mention', count }
}

/**
 * Classify the turn's presence/codex GAPS into confidence tiers. Same gap set as
 * {@link detectPresenceCodexGapsDetailed}, enriched with a tier + evidence so the
 * caller can stub/track conservatively and hand the frontend a backend-OWNED list
 * of trackable mentions (it no longer decides canon gaps itself). Pure + cheap →
 * off TTFT; the audit imports it so live + audit cannot drift.
 */
const TITLE_SET = new Set(TITLE_WORDS.split('|'))

export function classifyPresenceCodexGaps(prose: string, tracked: TrackedNames): MentionCandidate[] {
  const text = String(prose || '')
  return detectPresenceCodexGapsDetailed(text, tracked)
    .filter((c) => {
      if (appearsAsDefiniteLocation(c.display, text)) return false
      // Drop a bare title word ("Captain") when it directly precedes a name in the
      // prose ("Captain Voss") — the name candidate already captures that person.
      if (!TITLE_SET.has(c.display.toLowerCase())) return true
      return !new RegExp(`\\b${escapeRe(c.display)}\\s+[A-Z][a-z]`).test(text)
    })
    .map((c) => {
      let { tier, evidence, count } = tierFor(c.display, text)
      // Verb/title signals are position-robust — a comma or sentence start can't fake
      // "Mara said" / "Captain Mara". The rest (appositive, possessive, repeat) CAN be
      // faked by a capitalized sentence-adverb ("Downstairs, a door slammed"), so when
      // they're the only evidence and the token never appears mid-sentence, demote it.
      const robust =
        evidence === 'person possessive' ||
        evidence === 'title-name' ||
        evidence === 'action in scene' ||
        (evidence === 'dialogue attribution' &&
          (appearsMidSentence(c.display, text) || hasIndependentPersonSignal(c.display, text)))
      if (tier !== 'mentioned_only' && !robust && !appearsMidSentence(c.display, text)) {
        tier = 'mentioned_only'
        evidence = 'sentence-initial only, no person signal'
      }
      return { ...c, tier, evidence, count }
    })
}
import { isAbstractNonPersonTerm } from '../../src/utils/person-identity'
