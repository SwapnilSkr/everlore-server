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

const ACTION_VERBS =
  'turned|turns|smiled|smiles|nodded|nods|stepped|steps|reached|reaches|leaned|leans|stood|stands|sat|sits|moved|moves|looked|looks|glanced|glances|frowned|frowns|sighed|sighs|gripped|grips|grabbed|grabs|walked|walks|entered|enters|approached|approaches|crossed|crosses|raised|raises|shook|shakes|gestured|gestures|pointed|points|rose|rises|knelt|kneels|gazed|gazes|pulled|pulls|pressed|presses'

const PERSON_POSSESSIONS =
  'eyes|eye|jaw|hand|hands|mouth|lips|face|smile|frown|voice|shoulders|shoulder|fingers|nails|gaze|breath|head|cheek|cheeks|brow|expression'

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

/** Decide the tier for one candidate display name within `prose`. */
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
        evidence === 'dialogue attribution' ||
        evidence === 'action in scene' ||
        evidence === 'person possessive' ||
        evidence === 'title-name'
      if (tier !== 'mentioned_only' && !robust && !appearsMidSentence(c.display, text)) {
        tier = 'mentioned_only'
        evidence = 'sentence-initial only, no person signal'
      }
      return { ...c, tier, evidence, count }
    })
}
