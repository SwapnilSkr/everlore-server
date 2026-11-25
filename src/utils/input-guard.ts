/**
 * INPUT GUARD — a deterministic screen on the player's own words, run before a
 * turn is ever enqueued.
 *
 * This is the INPUT half of the two-layer content bound. The other half lives in
 * the prompt (see `narrativeBoundaries` in prompt-builder.ts) and shapes what the
 * narrator will *write*. The two are deliberately different instruments:
 *
 *   - The prompt bound is SOFT and diegetic. It never refuses out loud; it steers
 *     the scene. That is right for everything the narrator might drift toward,
 *     because an in-fiction redirect keeps immersion and does not teach players
 *     to hunt for jailbreaks.
 *   - This guard is HARD and narrow. It exists for the small set of themes that
 *     must never reach a model at all, where a soft steer is not an acceptable
 *     failure mode.
 *
 * Everything else explicit is allowed through untouched. This is not a profanity
 * filter and must never become one — Ardent is a supported mode and the mature
 * path is a product, not a leak.
 *
 * PRECISION OVER RECALL. A false block lands on a paying player mid-scene and is
 * far more damaging than a miss, which the prompt bound still catches. Every term
 * here is one that is unambiguous in context; anything that doubles as ordinary
 * speech ("baby", "girl", "bro", "pop") is deliberately absent even though it
 * would raise recall.
 */

export type GuardCategory = 'minor_sexual' | 'incest'

export interface GuardVerdict {
  blocked: boolean
  category?: GuardCategory
  /** Player-facing copy. Names the theme so the player can rewrite the line. */
  message?: string
}

/**
 * Which categories are enforced. `minor_sexual` is not a policy preference — it
 * is the one category that is illegal rather than merely disallowed, so it stays
 * on regardless of how permissive the mature path becomes.
 */
export const GUARD_CATEGORIES: Record<GuardCategory, boolean> = {
  minor_sexual: true,
  incest: true,
}

export const GUARD_MESSAGES: Record<GuardCategory, string> = {
  minor_sexual:
    'Everlore never writes sexual content involving minors. Rewrite that line and the scene picks up where it left off.',
  incest:
    'Everlore does not write sexual content between family members. Rewrite that line and the scene picks up where it left off.',
}

/**
 * Unambiguous sexual vocabulary. Mirrors the curated weight-2 tier of the
 * narration lexicon (scripts/seed-nsfw-lexicon.ts) but is kept in code on
 * purpose: the router's lexicon is tuned for RECALL over a whole scene and is
 * operator-editable at runtime, and neither property is wanted behind a hard
 * block on the request path.
 */
const SEXUAL_TERMS = new Set([
  // acts
  'sex', 'sexual', 'sexually', 'intercourse', 'coitus', 'fuck', 'fucks', 'fucking', 'fucked',
  'blowjob', 'handjob', 'rimjob', 'rimming', 'deepthroat', 'cunnilingus', 'fellatio',
  'masturbate', 'masturbating', 'masturbation', 'fingering', 'penetrate', 'penetrated',
  'penetration', 'doggystyle', 'creampie', 'gangbang', 'threesome', 'orgy', 'titfuck',
  'bukkake', 'sodomize', 'sodomy', 'foreplay', 'incest', 'incestuous', 'molest', 'molested',
  // climax / fluids
  'orgasm', 'orgasms', 'orgasmed', 'cum', 'cumming', 'cumshot', 'ejaculate', 'ejaculation',
  // anatomy — only terms with no non-sexual reading
  'cock', 'cocks', 'dick', 'dicks', 'penis', 'pussy', 'pussies', 'vagina', 'vulva', 'labia',
  'clit', 'clitoris', 'cunt', 'nipple', 'nipples', 'areola', 'testicle', 'testicles',
  'scrotum', 'ballsack', 'foreskin', 'anus', 'erection', 'boner',
  // state / apparel
  'horny', 'aroused', 'arousal', 'naked', 'nude', 'nudity', 'undress', 'undressed',
  'undressing', 'topless', 'lingerie', 'panties',
])

/** Multi-word sexual signals. Kept short and unambiguous for the same reason. */
const SEXUAL_PHRASES = [
  'make love', 'making love', 'made love', 'have sex', 'has sex', 'had sex', 'having sex',
  'sex with', 'give head', 'gives head', 'go down on', 'goes down on', 'sleep with me',
]

/**
 * Familial vocabulary, tier 1: words that denote kinship in essentially every
 * use, so a bare occurrence counts. Diminutives that double as ordinary address
 * ("bro", "sis", "ma", "pa", "pop") are excluded — in explicit text they are far
 * more often interjections than kinship claims.
 */
const KIN_TERMS = new Set([
  'mother', 'father',
  'brother', 'brothers', 'sister', 'sisters', 'sibling', 'siblings',
  'sons', 'daughter', 'daughters',
  'aunt', 'auntie', 'uncle', 'niece', 'nephew', 'cousin',
  'grandmother', 'grandma', 'granny', 'grandfather', 'grandpa', 'granddad', 'grandad',
  'parent', 'parents',
  'stepmother', 'stepmom', 'stepmum', 'stepfather', 'stepdad', 'stepbrother', 'stepsister',
  'stepson', 'stepdaughter', 'stepsibling',
  'half-brother', 'half-sister', 'halfbrother', 'halfsister',
  'mother-in-law', 'father-in-law', 'brother-in-law', 'sister-in-law',
])

/**
 * Familial vocabulary, tier 2: parental diminutives that are ALSO among the most
 * common forms of sexual address in adult roleplay. "fuck me daddy" is not a
 * kinship claim, and blocking it would hit ordinary consensual scenes constantly.
 *
 * These count only under a possessive determiner — "my daddy", "her mom" — which
 * is what actually distinguishes the kinship reading from the vocative one.
 */
const KIN_ADDRESS_TERMS = ['daddy', 'dad', 'mommy', 'mom', 'mum', 'mummy', 'mama', 'momma', 'papa']

/**
 * "son" alone is Spanish for "are" ("los dos son adultos"), a false positive the
 * chat guard saw in real Portuguese/Spanish saves. In chat it counts as kinship
 * only in an English construction: a determiner or possessive, at most one word
 * ("my own son", "her older son"), then "son". "sons" stays unconditional —
 * Spanish does not use that form. Image prompts keep the old any-occurrence
 * reading, because a picture of "son" has no other meaning.
 */
const SON_WITH_DETERMINER = /\b(?:my|your|his|her|their|our)\s+(?:[a-z]+\s+)?son\b|\b(?:the|a)\s+son\b|\bs\s+son\b/

/** Image prompts: "son" counts anywhere, exactly as before rl-s. */
const SON_ANYWHERE = /\bson\b/

const POSSESSED_KIN_ADDRESS = new RegExp(
  `\\b(?:my|your|his|her|their|our)\\s+(?:own\\s+|dear\\s+|sweet\\s+|poor\\s+)?(?:${KIN_ADDRESS_TERMS.join('|')})\\b`,
)

/**
 * Minor markers. "baby", "girl", and "boy" are deliberately ABSENT: all three
 * are overwhelmingly used as adult address in explicit writing, and including
 * them would block ordinary consensual scenes constantly.
 */
const MINOR_TERMS = new Set([
  'child', 'children', 'kid', 'kids', 'toddler', 'toddlers', 'infant', 'infants',
  'preteen', 'pre-teen', 'tween', 'teen', 'teens', 'teenager', 'teenagers', 'teenage',
  'adolescent', 'adolescents', 'minor', 'minors', 'underage', 'schoolgirl', 'schoolboy',
  'preschooler', 'kindergartner', 'newborn',
  // coded terms that exist for no other purpose
  'loli', 'lolicon', 'shota', 'shotacon', 'jailbait',
])

/**
 * A stated age below majority: "14 years old", "9yo", "under 18", and the bare
 * copula form ("she is 15", "aged 12", "just turned 16") which is how ages are
 * most often written in prose. The bare form can in principle collide with a
 * count ("the squad is 12 strong"), and that is an accepted cost: a rare
 * puzzling block is the right side to err on for this one category.
 */
const MINOR_AGE_PATTERNS = [
  /\b(?:[1-9]|1[0-7])\s*(?:-|\s)?\s*(?:years?|yrs?)[\s-]*old\b/,
  /\b(?:[1-9]|1[0-7])\s*(?:yo|y\/o)\b/,
  /\bunder\s*(?:-|\s)?\s*(?:18|eighteen)\b/,
  /\b(?:is|was|aged|age|turned|turning)\s+(?:just\s+|only\s+|barely\s+)?(?:[1-9]|1[0-7])\b/,
]

/**
 * Kin words used as titles or idiom rather than kinship. Masked out of a
 * sentence before the kin check so a cleric, a war cry, or a Mother Superior
 * cannot trip the incest rule. Applied to the ORIGINAL casing, because the
 * title reading is what capitalization distinguishes.
 */
const FIGURATIVE_KIN_PATTERNS = [
  /\b(?:Father|Mother|Sister|Brother)\s+[A-Z][a-z]+/g, // Father Aldric, Sister Mary
  /\bMother\s+Superior\b/gi,
  /\b(?:Holy|Heavenly)\s+Father\b/gi,
  /\b(?:brothers?|sisters?)\s+in\s+arms\b/gi,
  /\bband\s+of\s+brothers\b/gi,
  /\bblood\s+brothers?\b/gi,
  /\bfounding\s+fathers?\b/gi,
]

const TOKEN = /[a-z0-9'-]+/g

function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff]/g, '') // zero-width evasion
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function maskFigurativeKin(sentence: string): string {
  let out = sentence
  for (const re of FIGURATIVE_KIN_PATTERNS) out = out.replace(re, ' ')
  return out
}

/** Sentence scoping keeps "my mother waited outside. we had sex." from tripping. */
function splitSentences(text: string): string[] {
  return text.split(/[.!?;\n\r]+/).filter((s) => s.trim().length > 0)
}

// ── chat screen: clauses, and whose relative ────────────────────────────────
//
// A chat turn is a passage; an image prompt is one picture. They share the
// lexicons but not the scoping. The image screen keeps the whole prompt as one
// scope (see `screenImagePrompt`), because comma-separated fragments describe
// the same image. The chat screen cuts a sentence into clauses, because
// "we made love while the children slept" is a scene with two facts in it, not
// one act with a child.
//
// Loosening stops at protection: when the reading is unclear it stays blocked.
// A child described by a copula ("I was a child when we slept together") is
// never dismissed as someone else's clause, and a stated age, `underage` and
// the coded terms count anywhere in the sentence, as before.

interface ChatWord {
  text: string
  start: number
  end: number
}

const SUBORDINATORS = new Set([
  'while', 'when', 'whenever', 'as', 'so', 'because', 'since', 'until', 'before',
  'after', 'although', 'though', 'if', 'where',
])

const CHAT_POSSESSIVES = new Set(['my', 'your', 'his', 'her', 'their', 'our'])

const THIRD_PERSON = new Set([
  'he', 'she', 'they', 'him', 'her', 'them', 'his', 'hers', 'their', 'theirs',
  'himself', 'herself', 'themselves',
])

const FIRST_PERSON = new Set(['i', 'we', "i'm", "i've", "i'd", "i'll", "we're", "we've"])

/** Subjects that make a possessive relative someone else's ("my wife … my brother"). */
const RELATIONSHIP_SUBJECTS = new Set([
  'wife', 'husband', 'girlfriend', 'boyfriend', 'partner', 'ex', 'friend',
])

/** Watching or taking part, in the clause that holds a child noun. */
const WATCHING = new Set([
  'watch', 'watches', 'watched', 'watching',
  'look', 'looks', 'looked', 'looking',
  'see', 'sees', 'saw', 'seen', 'seeing',
  'stare', 'stares', 'stared', 'staring',
  'join', 'joins', 'joined', 'joining',
  'touch', 'touches', 'touched', 'touching',
  'undress', 'undresses', 'undressed', 'undressing',
])

const DENIAL_WORDS = new Set([
  'never', "didn't", 'didnt', "don't", 'dont', 'not', "wouldn't", 'wouldnt',
  "isn't", 'isnt', "wasn't", 'wasnt', "aren't", 'arent', "weren't", 'werent', "won't", 'wont',
])
/** Words allowed between a denial and the act it denies; a stopper ends the denial. */
const DENIAL_BRIDGE = new Set([
  'have', 'has', 'had', 'having', 'do', 'did', 'does', 'would', 'will', 'could', 'should',
  'can', 'to', 'want', 'wanted', 'ever', 'even', 'really', 'actually', 'just', 'only', 'barely',
  'i', 'we',
])

/** A kin word that owns only a place ("my sister's house") is not a partner. */
const OWNED_PLACES = new Set([
  'house', 'home', 'room', 'place', 'bed', 'car', 'wedding', 'party', 'funeral', 'shop',
  'farm', 'boat', 'grave',
  'bedroom', 'bathroom', 'kitchen', 'apartment', 'flat', 'couch', 'sofa', 'office', 'garage',
  'birthday',
])

/** Child nouns, which the clause reading may dismiss. `minor(s)` is judged alone. */
const MINOR_NOUNS = new Set([
  'child', 'children', 'kid', 'kids', 'toddler', 'toddlers', 'infant', 'infants',
  'preteen', 'pre-teen', 'tween', 'teen', 'teens', 'teenager', 'teenagers', 'teenage',
  'adolescent', 'adolescents', 'schoolgirl', 'schoolboy', 'preschooler', 'kindergartner', 'newborn',
])
/** These count anywhere in the sentence, exactly as before rl-e. */
const MINOR_ALWAYS = new Set(['underage', 'loli', 'lolicon', 'shota', 'shotacon', 'jailbait'])

const MINOR_DETERMINERS = new Set([
  'a', 'the', 'this', 'that', 'any', 'some', 'with', 'is', 'are', 'was', 'were',
  'of', 'another', 'every', 'no', 'like', 'her', 'his', 'my',
])
const PREPOSITIONS = new Set([
  'of', 'in', 'on', 'at', 'to', 'with', 'from', 'by', 'about', 'into', 'over', 'under',
  'for', 'during', 'without', 'against', 'between', 'among', 'through', 'across', 'behind',
  'beside', 'near', 'inside', 'outside', 'around', 'up', 'down', 'off', 'upon', 'within',
  'along', 'past', 'toward', 'towards', 'beneath', 'underneath', 'beyond', 'despite',
  'except', 'per', 'via', 'than', 'like', 'as',
])
const BE_HAVE_DO = new Set([
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'having',
  'do', 'does', 'did', 'doing', 'done',
])
const CONJUNCTIONS = new Set(['and', 'but', 'or', 'nor', 'so', 'yet'])
/**
 * `minor` is a person when what follows it cannot be the noun an adjective would
 * modify: the end, punctuation, a conjunction, a subordinator, a preposition, a
 * form of be/have/do, or an activity word ("another minor undressed"). A plain
 * noun after it ("minor detail") is the adjective reading.
 */
const MINOR_FOLLOWS = new Set([
  ...CONJUNCTIONS, ...SUBORDINATORS, ...PREPOSITIONS, ...BE_HAVE_DO,
  ...SEXUAL_TERMS, ...WATCHING,
])

/** A copula before a child noun says the person is the child, not a bystander. */
const COPULA = new Set(['am', 'is', 'are', 'was', 'were', 'be', 'been', 'being'])

/** The three unambiguous age forms. They count anywhere, as before. */
const EXPLICIT_AGE_PATTERNS = MINOR_AGE_PATTERNS.slice(0, 3)

/**
 * The bare age ("she is 15", "I am 12", "you were 9"). It counts at the end,
 * before punctuation, before a conjunction, an ordinary time adverb ("last",
 * "yesterday", "still", "again"), or a subordinator. A word after it that makes
 * it a count or a clock time ("12 strong men", "5 in the morning", "5:30 pm",
 * "5 minutes away") means it is not an age.
 */
const BARE_AGE =
  /\b(?:(?:i am|i'm|i was|you are|you're|you were)|(?:is|was|were|are|aged|age|turned|turning))\s+(?:just\s+|only\s+|barely\s+)?(?:1[0-7]|[1-9])(?![\d])/g
const AGE_FOLLOW_WORDS = new Set([
  ...SUBORDINATORS, ...CONJUNCTIONS, 'now', 'then', 'years', 'yrs',
  'last', 'yesterday', 'today', 'tonight', 'this', 'that', 'at', 'back', 'already',
  'too', 'still', 'again', 'tomorrow', 'on', 'in',
])
/** "12 years older", "5 years ago": a duration or a gap, not an age. */
const YEARS_STOP_WORDS = new Set([
  'older', 'younger', 'apart', 'ago', 'married', 'together', 'into', 'in', 'behind', 'ahead', 'of',
])

function chatNormalize(sentence: string): string {
  // A curly apostrophe is folded only here: the image screen's verdicts are
  // pinned, and "sister’s house" has to read as a possessive in chat.
  return normalize(sentence).replace(/’/g, "'")
}

function chatWords(normalized: string): ChatWord[] {
  const words: ChatWord[] = []
  for (const match of normalized.matchAll(TOKEN)) {
    const start = match.index ?? 0
    words.push({ text: match[0], start, end: start + match[0].length })
  }
  return words
}

/** Clause ids: subordinators always cut; commas cut family clauses only. */
function clauseIds(words: ChatWord[], normalized: string, splitCommas: boolean): number[] {
  const ids: number[] = []
  let id = 0
  for (let i = 0; i < words.length; i++) {
    if (i > 0) {
      const gap = normalized.slice(words[i - 1].end, words[i].start)
      if (SUBORDINATORS.has(words[i].text)) id++
      else if (splitCommas && gap.includes(',')) id++
    }
    ids.push(id)
  }
  return ids
}

interface SexualOccurrence {
  start: number
  end: number
}

function sexualOccurrences(words: ChatWord[]): SexualOccurrence[] {
  const occurrences: SexualOccurrence[] = []
  for (let i = 0; i < words.length; i++) {
    if (SEXUAL_TERMS.has(words[i].text)) occurrences.push({ start: i, end: i + 1 })
    for (const phrase of SEXUAL_PHRASES) {
      const parts = phrase.split(' ')
      if (parts.length > 1 && parts.every((part, offset) => words[i + offset]?.text === part)) {
        occurrences.push({ start: i, end: i + parts.length })
      }
    }
  }
  return occurrences
}

/** A denial right before the act, with no clause boundary or stopper between. */
function denies(words: ChatWord[], occurrence: SexualOccurrence, ids: number[]): boolean {
  const clause = ids[occurrence.start]
  for (let i = occurrence.start - 1, steps = 0; i >= 0 && steps < 5; i--, steps++) {
    if (ids[i] !== clause) return false
    if (DENIAL_WORDS.has(words[i].text)) return true
    if (!DENIAL_BRIDGE.has(words[i].text)) return false
  }
  return false
}

function everySexualElsewhere(clause: number, live: SexualOccurrence[], ids: number[]): boolean {
  return live.every((occurrence) => ids[occurrence.start] !== clause)
}

/**
 * A third-person pronoun a sexual clause adds after the act can point back at
 * the person named in another clause ("… I have sex with her"). `her` right
 * before a sexual noun counts too ("her naked body").
 */
function hasAnaphoricPronoun(words: ChatWord[], live: SexualOccurrence[], ids: number[]): boolean {
  for (const occurrence of live) {
    const clause = ids[occurrence.start]
    if (occurrence.start > 0 && ids[occurrence.start - 1] === clause) {
      if (words[occurrence.start - 1].text === 'her') return true
    }
    for (let i = occurrence.start; i < words.length && ids[i] === clause; i++) {
      if (THIRD_PERSON.has(words[i].text)) return true
    }
  }
  return false
}

function hasWatching(words: ChatWord[], index: number, ids: number[]): boolean {
  const clause = ids[index]
  for (let i = 0; i < words.length; i++) {
    if (ids[i] === clause && WATCHING.has(words[i].text)) return true
  }
  return false
}

/** Point 3: the act is wholly in another clause and no pronoun reaches back. */
function ignoredByClause(index: number, words: ChatWord[], ids: number[], live: SexualOccurrence[]): boolean {
  if (live.length === 0) return true
  if (!everySexualElsewhere(ids[index], live, ids)) return false
  return !hasAnaphoricPronoun(words, live, ids)
}

function kinBase(text: string): string {
  if (text.endsWith("'s")) return text.slice(0, -2)
  if (text.endsWith("'")) return text.slice(0, -1)
  return text
}

function isKinAt(words: ChatWord[], index: number, normalized: string): boolean {
  if (index < 0 || index >= words.length) return false
  const text = words[index].text
  if (KIN_TERMS.has(text)) return true
  const base = kinBase(text)
  if (base !== text && KIN_TERMS.has(base)) return true
  // `son` is Spanish for "are" ("los dos son adultos"); in chat it is kinship
  // only when the sentence frames it as one.
  if (base === 'son' && SON_WITH_DETERMINER.test(normalized)) return true
  return KIN_ADDRESS_TERMS.includes(text) && CHAT_POSSESSIVES.has(words[index - 1]?.text ?? '')
}

/** "my sister's house": the kin word names the owner of a place, not a partner. */
function ownsPlace(words: ChatWord[], index: number): boolean {
  const base = kinBase(words[index].text)
  if (base === words[index].text) return false
  if (!KIN_TERMS.has(base) && base !== 'son' && !KIN_ADDRESS_TERMS.includes(base)) return false
  return OWNED_PLACES.has(words[index + 1]?.text ?? '') || RELATED_PERSONS.has(words[index + 1]?.text ?? '')
}

/** "my brother's wife": somebody the relative knows, not the relative. */
const RELATED_PERSONS = new Set([
  'wife', 'husband', 'girlfriend', 'boyfriend', 'fiance', 'fiancee', 'ex', 'lover', 'partner',
  'friend', 'friends', 'boss', 'roommate', 'best',
])
const PARENT_WORDS = new Set(['mother', 'father', 'parent', 'mom', 'dad'])
const OFFSPRING = new Set(['child', 'children', 'kid', 'kids', 'son', 'sons', 'daughter', 'daughters'])

/** "the father of my children": the two are co-parents, whichever word is read. */
function coParent(words: ChatWord[], index: number): boolean {
  for (const at of [index, index - 3]) {
    if (PARENT_WORDS.has(words[at]?.text ?? '') && words[at + 1]?.text === 'of' &&
      CHAT_POSSESSIVES.has(words[at + 2]?.text ?? '') && OFFSPRING.has(words[at + 3]?.text ?? '')) return true
  }
  return false
}

/** A musical key at the end of a sentence ("in b minor", "in F sharp minor"). */
function musicalKeyEnd(words: ChatWord[], index: number): boolean {
  const previous = words[index - 1]?.text
  if (!previous) return false
  if (/^[b-g]$/.test(previous)) return true
  return previous === 'sharp' || previous === 'flat' || previous === 'natural'
}

/**
 * A person noun right after `minor` keeps it a person ("a minor girl"), which is
 * the reading point 6's follow rule would otherwise miss. "minor detail",
 * "minor character" and "minor injury" are the shapes point 6 exists for.
 */
const MINOR_PERSON_NOUNS = new Set([
  'girl', 'girls', 'boy', 'boys', 'woman', 'women', 'man', 'men', 'person', 'people',
  'female', 'females', 'male', 'males',
])

/** Point 6: `minor` is a person only in a noun position. `minors` always is. */
function minorIsNoun(words: ChatWord[], index: number, normalized: string): boolean {
  if (words[index].text === 'minors') return true
  const next = words[index + 1]
  if (!next) return !musicalKeyEnd(words, index)
  const gap = normalized.slice(words[index].end, next.start)
  if (/[,:;]/.test(gap)) return true
  // C.8: "a minor sucks my cock" — a verb, then a determiner or an object
  // pronoun, makes `minor` the person doing it. "the minor noble watches me"
  // leaves a noun there and stays clear.
  const third = words[index + 2]
  if (third && !/[,:;.]/.test(normalized.slice(next.end, third.start)) &&
    (DETERMINERS.has(third.text) || CHAT_POSSESSIVES.has(third.text) || OBJECT_PRONOUNS.has(third.text))) return true
  const previous = words[index - 1]?.text
  if (!previous || !MINOR_DETERMINERS.has(previous)) return false
  if (MINOR_PERSON_NOUNS.has(next.text)) return true
  return MINOR_FOLLOWS.has(next.text) || MINOR_EXTRA_ACTS.has(next.text)
}

/** A copula up to three words before a child noun makes the person the child. */
function copulaBefore(words: ChatWord[], index: number, ids: number[]): boolean {
  const clause = ids[index]
  for (let i = index - 1; i >= 0 && i >= index - 3; i--) {
    if (ids[i] !== clause) return false
    if (COPULA.has(words[i].text)) return true
  }
  return false
}

/** Points 5 and A.1–A.2: the bare age, only where it is not a count or a clock time. */
function bareAgeCounts(sentence: string, match: RegExpExecArray): boolean {
  const subject = /([a-z']+)\s*$/.exec(sentence.slice(0, match.index))?.[1]
  if (subject === 'it') return false
  const rest = sentence.slice(match.index + match[0].length).trimStart()
  if (rest.length === 0) return true
  if (/[:.!?;,]/.test(rest[0])) {
    if (rest[0] === ':' && /^\d/.test(rest.slice(1))) return false
    return true
  }
  const word = /^[a-z']+/.exec(rest)?.[0]
  if (!word) return true
  if (word === 'in' && /^in\s+the\b/.test(rest)) return false
  if (word === 'years' || word === 'yrs') {
    // "12 years older", "ten years of marriage" — but "9 years of age" is an age.
    const after = /^(?:years?|yrs?)\s+([a-z']+)/.exec(rest)?.[1] ?? ''
    if (after === 'of' && /^(?:years?|yrs?)\s+of\s+age\b/.test(rest)) return true
    if (YEARS_STOP_WORDS.has(after)) return false
  }
  return AGE_FOLLOW_WORDS.has(word)
}

function statedMinorAge(sentence: string): boolean {
  for (const pattern of EXPLICIT_AGE_PATTERNS) if (pattern.test(sentence)) return true
  // C.8: number words in the year-old forms and after the age copulas.
  if (WORD_AGE_YEARS.test(sentence)) return true
  for (const match of sentence.matchAll(BARE_AGE)) if (bareAgeCounts(sentence, match)) return true
  for (const match of sentence.matchAll(BARE_AGE_WORDS)) if (bareAgeCounts(sentence, match)) return true
  // C.8: "she looks twelve", "he looks about fourteen".
  for (const match of sentence.matchAll(LOOKS_AGE)) if (bareAgeCounts(sentence, match)) return true
  // C.8: "The girl, 16, is naked".
  for (const match of sentence.matchAll(APPOSITIVE_AGE)) {
    if (APPOSITIVE_PEOPLE.has(match[1])) return true
  }
  // C.8: school and grade.
  if (NOT_EIGHTEEN.test(sentence)) return true
  if (SCHOOL_AGE.test(sentence) || GRADE_AGE.test(sentence)) return true
  return false
}

type Actor = 'first' | 'second' | 'third' | 'other' | 'unknown'

function actorBefore(words: ChatWord[], occurrenceStart: number, clause: number, ids: number[]): Actor {
  for (let i = occurrenceStart - 1; i >= 0 && ids[i] === clause; i--) {
    const word = words[i].text
    if (FIRST_PERSON.has(word)) return 'first'
    if (word === 'you') return 'second'
    if (word === 'he' || word === 'she' || word === 'they') return 'third'
    if (RELATIONSHIP_SUBJECTS.has(word)) {
      // "my wife", and one adjective is allowed: "my best friend", "my ex husband".
      const owner = words[i - 1]?.text
      const before = owner === 'my' || owner === 'your' ? owner : words[i - 2]?.text
      if (before === 'my' || before === 'your') return 'other'
    }
  }
  return 'unknown'
}

/**
 * Point A.1: whose relative the act's object is. rl-e point 7 and rl-e2 point
 * 10, unchanged: "I had sex with your mother" (the addressee's relative) and
 * "The guard had sex with my sister" (somebody else acting) are clear.
 */
function whoseRelativeBlocks(
  words: ChatWord[],
  index: number,
  ids: number[],
  objectOf: SexualOccurrence,
): boolean {
  if (thirdPartyActor(words, objectOf.start, ids[index], ids)) return false
  const previous = words[index - 1]?.text
  if (previous === 'own') return true
  let possessor: 'mine' | 'other' | 'name' | 'none' = 'none'
  if (previous && CHAT_POSSESSIVES.has(previous)) {
    possessor = previous === 'my' || previous === 'our' ? 'mine' : 'other'
  } else if (previous && (previous.endsWith("'s") || previous.endsWith("'"))) {
    possessor = 'name'
  }
  if (possessor === 'none') return true
  const actor = actorBefore(words, objectOf.start, ids[index], ids)
  if (possessor === 'mine') return actor !== 'second' && actor !== 'third' && actor !== 'other'
  return actor !== 'first'
}

// ── rl-e2: regressions closed and a few more innocent shapes cleared ────────
//
// Every clearing below is a structural read of ONE sentence and stops at the
// same protection the clause reading keeps: if an act's clause carries a
// third-person pronoun that could point back (rl-e's `hasAnaphoricPronoun`), or
// the guarded noun is the act's own partner, the noun still counts — except
// where the shape itself proves the noun is only the topic ("we talked about
// sex with my sister") or somebody else's partner ("the guard had sex with my
// sister").

/** Point A.4: "I am your daughter, fuck me" — the copula says who the kin word is. */
function kinIdentityCopula(words: ChatWord[], index: number, ids: number[]): boolean {
  for (let i = index - 1; i >= 0 && i >= index - 3; i--) {
    if (ids[i] !== ids[index]) return false
    if (!COPULA.has(words[i].text)) continue
    const subject = words[i - 1]?.text
    return subject === 'i' || subject === 'we' || subject === 'you'
  }
  return false
}

/** Filler that may open the clause after a vocative without being its subject. */
const CLAUSE_FILLERS = new Set([
  ...SUBORDINATORS, ...CONJUNCTIONS, 'then', 'now', 'please', 'oh',
])

function clauseWords(words: ChatWord[], ids: number[], clause: number): ChatWord[] {
  return words.filter((_, i) => ids[i] === clause)
}

/** The first word of a clause, past any filler that merely opens it. */
function clauseSubject(words: ChatWord[], ids: number[], clause: number): ChatWord | undefined {
  const own = clauseWords(words, ids, clause)
  for (const word of own) if (!CLAUSE_FILLERS.has(word.text)) return word
  return undefined
}

/** An invitation: it makes an act aimed at the addressee part of a come-on. */
const INVITATIONS = new Set(['let', "let's", 'lets', 'come', 'now'])

/** Act words that are verb forms, so they can open an imperative ("Brother, fuck me"). */
const VERB_ACTS = new Set([
  'fuck', 'fucks', 'fucked', 'fucking', 'undress', 'undresses', 'undressed', 'undressing',
  'masturbate', 'masturbating', 'penetrate', 'penetrated', 'sodomize', 'molest', 'molested',
  'cum', 'cumming', 'eat', 'ride', 'rides', 'suck', 'sucks', 'strip', 'strips',
])

/**
 * Points A.5 and 5: a kin word alone in its clause is address. A leading
 * vocative blocks before an act aimed at the speaker ("Brother, fuck me") or an
 * invitation ("Sister, come and fuck me"); a statement is no invitation ("Oh
 * brother, sex again?"). A trailing vocative blocks after an act aimed at the
 * speaker ("Fuck me, brother") or an invitation ("Let us have sex, sister").
 */
function kinAloneBlocks(words: ChatWord[], index: number, ids: number[], live: SexualOccurrence[]): boolean {
  const clause = ids[index]
  const rest = clauseWords(words, ids, clause).filter((word) => word !== words[index])
  if (rest.length > 1) return false
  if (rest.filter((word) => !CHAT_POSSESSIVES.has(word.text)).length > 1) return false

  if (clause === 0) {
    if (!live.some((occurrence) => ids[occurrence.start] === 1)) return false
    const next = clauseSubject(words, ids, 1)
    if (!next) return false
    return INVITATIONS.has(next.text) || VERB_ACTS.has(next.text)
  }

  const previous = clauseWords(words, ids, clause - 1)
  const hasAct = live.some((occurrence) => ids[occurrence.start] === clause - 1)
  if (!hasAct) return false
  if (previous.some((word) => FIRST_PERSON.has(word.text))) return false
  if (previous.some((word) => word.text === 'me')) return true
  return previous.some((word) => INVITATIONS.has(word.text))
}

const OBJECT_GAP_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'my', 'your', 'his', 'her', 'their', 'our', 'its', 'own',
  'with', 'to', 'at', 'of', 'for', 'on', 'in', 'by', 'from', 'into',
  'older', 'younger', 'elder', 'little', 'big', 'small', 'young', 'old', 'first', 'second',
  'only', 'baby', 'other', 'step', 'half', 'two', 'three', 'four', 'five', 'several', 'few',
])

/** The guarded noun is what the act is directed at ("I had sex with my sister"). */
function isActObject(words: ChatWord[], index: number, ids: number[], live: SexualOccurrence[]): boolean {
  return live.some((occurrence) => {
    if (occurrence.start >= index) return false
    if (ids[occurrence.start] !== ids[index]) return false
    const gap = index - occurrence.end
    if (gap < 0 || gap > 3) return false
    for (let i = occurrence.end; i < index; i++) {
      if (!OBJECT_GAP_WORDS.has(words[i].text)) return false
    }
    return true
  })
}

/** The noun can only be a bystander: not the act's partner, no pronoun reaching back. */
function bystander(words: ChatWord[], index: number, ids: number[], live: SexualOccurrence[]): boolean {
  if (live.length === 0) return false
  if (hasAnaphoricPronoun(words, live, ids)) return false
  return !isActObject(words, index, ids, live)
}

/**
 * A subject pronoun in the act's clause, after the noun, that could be the noun
 * acting ("I have a child and she fucks me"). Object pronouns after the act are
 * already caught by `hasAnaphoricPronoun`, and `her` is far more often the
 * possessive "her first marriage" than a subject.
 */
const B_SHAPE_PRONOUNS = new Set(['he', 'she', 'they'])

function actPronounCouldName(words: ChatWord[], index: number, ids: number[], live: SexualOccurrence[]): boolean {
  for (const occurrence of live) {
    if (occurrence.start <= index) continue
    const clause = ids[occurrence.start]
    for (let i = index + 1; i < words.length && ids[i] === clause; i++) {
      if (B_SHAPE_PRONOUNS.has(words[i].text)) return true
    }
  }
  return false
}

/** Every B-shape clearing needs the noun to be a bystander and no pronoun to name it. */
function bShapeOpen(words: ChatWord[], index: number, ids: number[], live: SexualOccurrence[]): boolean {
  return bystander(words, index, ids, live) && !actPronounCouldName(words, index, ids, live)
}

const HAVE_WORDS = new Set(['have', 'has', 'had', 'got'])
const HAVE_FOLLOWS = new Set(['and', 'but', 'or', 'from'])
const WATCHING_WORDS = new Set(['watch', 'watches', 'watching', 'watched', 'see', 'sees', 'saw', 'seen', 'looking', 'looks'])

/**
 * Point B.6: "I have two kids and I still love sex" — the noun is a family fact.
 * `have|has|had|got`, at most two words, the noun, then a conjunction, `with
 * my|his|her`, a comma or the end, with no act and no watching word in between.
 */
function havingChildren(
  words: ChatWord[],
  index: number,
  ids: number[],
  live: SexualOccurrence[],
  normalized: string,
): boolean {
  let verb = -1
  for (let at = index - 1; at >= 0 && at >= index - 3; at--) {
    if (ids[at] !== ids[index]) break
    if (HAVE_WORDS.has(words[at].text)) {
      verb = at
      break
    }
  }
  if (verb < 0 || index - verb - 1 > 2) return false

  const next = words[index + 1]
  let followIndex = index + 1
  let bareConjunction = false
  if (next) {
    const comma = normalized.slice(words[index].end, next.start).includes(',')
    const withPossessive =
      next.text === 'with' &&
      (words[index + 2]?.text === 'my' || words[index + 2]?.text === 'his' || words[index + 2]?.text === 'her')
    if (withPossessive) followIndex = index + 3
    else if (!comma && !HAVE_FOLLOWS.has(next.text)) return false
    else bareConjunction = !comma && (next.text === 'and' || next.text === 'but' || next.text === 'or')
  }

  for (let at = verb + 1; at < followIndex; at++) {
    if (WATCHING_WORDS.has(words[at].text)) return false
  }
  if (live.some((occurrence) => occurrence.start >= verb + 1 && occurrence.start < followIndex)) return false
  // "I have a child and we have sex": the first-person plural subject of the act
  // could take the noun with it. Provenance ("from her first marriage") and a
  // comma put the noun elsewhere, so they are exempt.
  if (bareConjunction) {
    const objectOf = live.find((occurrence) => occurrence.start > index)
    if (objectOf) {
      const own = clauseWords(words, ids, ids[objectOf.start])
      if (own.some((word) => word.text === 'we' || word.text === 'us')) return false
    }
  }
  return true
}

/** Point B.7: where the noun is, separated from every act by a conjunction or comma. */
const LOCATION_PHRASES = [
  ['awake'], ['asleep'], ['sleeping'], ['napping'], ['away'], ['out'], ['outside'], ['gone'],
  ['upstairs'], ['downstairs'], ['home'],
  ['at', 'school'], ['at', 'home'], ['at', 'camp'],
  ['in', 'the', 'next', 'room'], ['in', 'another', 'room'], ['in', 'bed', 'already'],
].sort((a, b) => b.length - a.length)
const LOCATION_AUX = new Set(['is', 'are', 'was', 'were'])
const GAP_SEPARATORS = new Set(['and', 'but', 'so'])

function whereTheyAre(
  words: ChatWord[],
  index: number,
  normalized: string,
  live: SexualOccurrence[],
): boolean {
  if (!LOCATION_AUX.has(words[index + 1]?.text ?? '')) return false
  let end = index + 2
  let matched = false
  // One phrase, then optionally one more that qualifies it ("asleep" then "in
  // the next room", "away" then "at camp"). A tail that is not on the list
  // ("asleep next to me", "in my bed") leaves a content word behind and blocks.
  for (let step = 0; step < 2; step++) {
    let found = -1
    for (const phrase of LOCATION_PHRASES) {
      if (phrase.every((part, offset) => words[end + offset]?.text === part)) {
        found = end + phrase.length
        break
      }
    }
    if (found < 0) break
    end = found
    matched = true
  }
  if (!matched) return false
  const after = words[end]
  if (after && !GAP_SEPARATORS.has(after.text) && !SUBORDINATORS.has(after.text)) {
    if (!normalized.slice(words[end - 1].end, after.start).includes(',')) return false
  }
  const separated = (from: number, to: number): boolean => {
    for (let i = from; i < to; i++) {
      if (GAP_SEPARATORS.has(words[i].text)) return true
      if (i + 1 < words.length && normalized.slice(words[i].end, words[i + 1].start).includes(',')) return true
    }
    return false
  }

  return live.every((occurrence) => {
    if (occurrence.end <= index) return separated(occurrence.end, index)
    if (occurrence.start >= end) return separated(end, occurrence.start)
    return false
  })
}

/** Speech verbs: their object is a topic, not an act. */
const SPEECH_VERBS = new Set([
  'talk', 'talks', 'talked', 'talking', 'speak', 'speaks', 'spoke', 'speaking',
  'ask', 'asks', 'asked', 'asking', 'joke', 'jokes', 'joked', 'joking',
  'lecture', 'lectures', 'lectured', 'lecturing',
])

/**
 * Point A.1 with rl-e2 point 9: `about` after a speech verb makes the act the
 * topic ("we talked about sex with my sister"), so the act is not live for the
 * family reading. It stays live for the child reading, which blocks by default.
 */
function isTopic(words: ChatWord[], occurrence: SexualOccurrence, ids: number[]): boolean {
  if (words[occurrence.start - 1]?.text !== 'about') return false
  if (ids[occurrence.start - 1] !== ids[occurrence.start]) return false
  for (let at = occurrence.start - 2; at >= occurrence.start - 4 && at >= 0; at--) {
    if (ids[at] !== ids[occurrence.start]) break
    if (SPEECH_VERBS.has(words[at].text)) return true
  }
  return false
}

const THIRD_PARTY_DETERMINERS = new Set(['the', 'a', 'that', 'this'])
const AUXILIARY = new Set([
  'had', 'has', 'have', 'was', 'were', 'is', 'are', 'did', 'does', 'do', 'got', 'made',
  'just', 'then', 'also', 'already', 'still', 'once', 'again', 'been', 'being',
  'would', 'will', 'could', 'should',
])

/** Point B.10: "the guard had sex with my sister" — the actor is somebody else. */
function thirdPartyActor(words: ChatWord[], occurrenceStart: number, clause: number, ids: number[]): boolean {
  for (let i = occurrenceStart - 1; i >= 0 && ids[i] === clause; i--) {
    if (AUXILIARY.has(words[i].text)) continue
    if (i === 0 || ids[i - 1] !== clause) return false
    return THIRD_PARTY_DETERMINERS.has(words[i - 1].text)
  }
  return false
}

const NEGATORS = new Set(['not', 'no', 'without'])

/**
 * Point B.11: "I want sex, not children", "no kids around, fuck me", "she is
 * not a child". The negated noun is a thing that is absent, so it may be clear —
 * but only when no act follows it in its own clause: "no minor is naked" is the
 * child doing the act, not an absent one.
 */
function childNegated(words: ChatWord[], index: number, ids: number[], live: SexualOccurrence[], normalized: string): boolean {
  const previous = words[index - 1]?.text
  let negated = false
  let negator = -1
  if (previous && NEGATORS.has(previous)) {
    negated = true
    negator = index - 1
  } else if (previous === 'a') {
    const before = words[index - 2]?.text
    if (before === 'not') {
      negated = true
      negator = index - 2
    } else if (before === 'longer' && words[index - 3]?.text === 'no') {
      negated = true
      negator = index - 3
    }
  }
  if (!negated) return false
  // A comma between the negator and the noun starts a new statement ("no,
  // children undress me"); a comma before the negator is ordinary coordination
  // ("I want sex, not children").
  for (let i = negator + 1; i <= index; i++) {
    if (normalized.slice(words[i - 1].end, words[i].start).includes(',')) return false
  }
  // C.9: "she is not a child, she is thirty" — an adult age after the comma says
  // the denial is about being a child, not about the scene.
  let comma = false
  for (let i = index + 1; i < words.length && ids[i] === ids[index]; i++) {
    if (normalized.slice(words[i - 1].end, words[i].start).includes(',')) comma = true
    if (!comma) continue
    const text = words[i].text
    if (ADULT_AGE_WORD.test(text)) return true
    if (/^\d+$/.test(text) && Number(text) >= 18) return true
  }
  // "no minor is safe" makes the noun the subject of a predicate, not an absent
  // thing; only a noun at the end or before a non-verb is genuinely absent.
  if (BE_HAVE_DO.has(words[index + 1]?.text ?? '') && words[index + 2]) return false
  return live.every((occurrence) => {
    if (occurrence.start <= index) return true
    // An act after the noun is only "absent" if the noun is not its actor: a
    // third-person pronoun in between ("she says, and fucks me") could still be
    // the child.
    for (let i = index + 1; i <= occurrence.start; i++) {
      if (THIRD_PERSON.has(words[i].text)) return false
    }
    for (let i = occurrence.start; i > index; i--) {
      if (GAP_SEPARATORS.has(words[i - 1].text)) return true
      if (normalized.slice(words[i - 1].end, words[i].start).includes(',')) return true
    }
    return false
  })
}

// ── rl-e3 point B: a `fuck` expletive is not a sexual signal ─────────────────

const FUCK_FAMILY = new Set(['fuck', 'fucks', 'fucked', 'fucking'])
const DETERMINERS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'some', 'any', 'every', 'each', 'no',
])
const FUCK_YOU_CONTINUES = new Set(['with', 'in', 'on', 'hard', 'until', 'while', 'all', 'again', 'slowly'])
const FUCK_YOU_ACTORS = new Set(['i', 'to', 'will', 'gonna'])

function isActFuckYou(words: ChatWord[], at: number): boolean {
  const before = words[at - 1]?.text ?? ''
  if (FUCK_YOU_ACTORS.has(before)) return true
  if (before === 'me' && words[at - 2]?.text === 'let') return true
  const after = words[at + 2]?.text ?? ''
  return FUCK_YOU_CONTINUES.has(after)
}

/** A `fuck` word that is only an expletive ("holy fuck", "fuck this", "fucked up"). */
function expletiveFuck(words: ChatWord[], at: number, normalized: string): boolean {
  const word = words[at].text
  if (!FUCK_FAMILY.has(word)) return false
  const previous = words[at - 1]?.text
  const next = words[at + 1]?.text
  if (previous === 'holy' || previous === 'the' || previous === 'oh' || previous === 'mother') return true
  if (word === 'fucked' && next === 'up') return true
  if (word === 'fuck' && next && ['you', 'off', 'this', 'that', 'it', 'no', 'yes', 'yeah'].includes(next)) {
    if (next === 'you' && isActFuckYou(words, at)) return false
    return true
  }
  if (word === 'fucking' && previous && (DETERMINERS.has(previous) || CHAT_POSSESSIVES.has(previous))) return true
  if (word === 'fucking' && previous && COPULA.has(previous)) {
    const after = next
    if (after && !DETERMINERS.has(after) && !CHAT_POSSESSIVES.has(after) &&
      !OBJECT_PRONOUNS.has(after) && !isKinAt(words, at + 1, normalized)) return true
  }
  if (at === 0 && /^\s*,/.test(normalized.slice(words[0].end))) return true
  return false
}

// ── rl-e3 point C: children ──────────────────────────────────────────────────

/** C.8: a determiner, a size adjective and a gendered child noun ("two little boys"). */
const LITTLE_CHILD_DETERMINERS = new Set(['the', 'a', 'this', 'that', 'these', 'those', 'two', 'some'])
const LITTLE_CHILD_ADJECTIVES = new Set(['little', 'small', 'young'])
const LITTLE_CHILD_NOUNS = new Set(['girl', 'girls', 'boy', 'boys'])

/** C.8: `undresses` and `strips` count as acts for the child reading only. */
const MINOR_EXTRA_ACTS = new Set(['undresses', 'strips'])

/** C.8: number words, for the year-old forms and the age copulas. */
const NUMBER_WORDS = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
]
const NUMBER_ALT = NUMBER_WORDS.join('|')
const WORD_AGE_YEARS = new RegExp(`\\b(?:${NUMBER_ALT})(?:-|\\s)?(?:years?|yrs?)[\\s-]*old\\b`)
const BARE_AGE_WORDS = new RegExp(
  `\\b(?:(?:i am|i'm|i was|you are|you're|you were)|(?:is|was|were|are|aged|age|turned|turning))\\s+` +
    `(?:just\\s+|only\\s+|barely\\s+)?(?:${NUMBER_ALT})\\b`,
  'g',
)
const LOOKS_AGE = new RegExp(
  `\\b(?:looks|looked|looking|seems)\\s+(?:(?:like|about|maybe|barely|only)\\s+)?(?:1[0-7]|[1-9]|${NUMBER_ALT})\\b`,
  'g',
)
const APPOSITIVE_AGE = new RegExp(
  `\\b([a-z']+)\\s*,\\s*(?:1[0-7]|[1-9]|${NUMBER_ALT})\\s*,`,
  'g',
)
const SCHOOL_AGE = /\b(?:i am|i'm|you are|you're|she is|she's|he is|he's|they are|who is)\s+(?:still\s+|only\s+)?in\s+(?:elementary|primary|middle|grade)\s+school\b/
const GRADE_AGE = /\b(?:i am|i'm|you are|you're|she is|she's|he is|he's|they are|who is)\s+(?:still\s+|only\s+)?in\s+(?:1st|2nd|3rd|4th|5th|6th|7th|8th|first|second|third|fourth|fifth|sixth|seventh|eighth)\s+grade\b/
/** "she is not 18 yet": a person's age, never a count ("it is not 18 degrees"). */
const NOT_EIGHTEEN =
  /\b(?:(?:i am|i'm|you are|you're|she is|she's|he is|he's|they are|they're)\s+not|(?:she|he)\s+isn't|(?:you|they)\s+aren't)\s+(?:yet\s+|even\s+)*(?:18|eighteen)(?=\s*(?:$|[,:-]|yet\b|but\b|and\b|so\b|years?\s+old\b))/
const APPOSITIVE_PEOPLE = new Set([
  'he', 'she', 'they', 'him', 'her', 'them', 'i', 'we', 'you', 'girl', 'girls', 'boy', 'boys',
  'man', 'woman', 'person', 'people', 'child', 'children', 'kid', 'kids', 'teen', 'teens',
  'teenager', 'teenagers', 'adolescent', 'adolescents', 'minor', 'minors',
])

/** C.9: an adult age offered right after "not a child, …". */
const ADULT_AGE_WORD = /^(?:eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:-|$)/
const WORK_WITH = new Set(['work', 'works', 'worked', 'working'])
const TALK_ABOUT = new Set(['talk', 'talks', 'talked', 'talking'])
const MINOR_PLACES = new Set([...OWNED_PLACES, 'school'])
const BED_VERBS = new Set(['put', 'puts', 'tuck', 'tucks', 'tucked', 'sent', 'send', 'drop', 'drops', 'dropped'])
const BED_PHRASES = [
  ['to', 'bed'], ['to', 'sleep'], ['in', 'bed'], ['to', 'school'], ['off'], ['out'],
]
const PUT_SEPARATORS = new Set(['then', 'and', 'so'])

/** C.8: a little girl/boy under a determiner is a child noun ("two little boys"). */
function littleChildAt(words: ChatWord[], index: number): boolean {
  if (!LITTLE_CHILD_NOUNS.has(words[index].text)) return false
  const adjective = words[index - 1]?.text
  const determiner = words[index - 2]?.text
  if (!adjective || !LITTLE_CHILD_ADJECTIVES.has(adjective)) return false
  if (!determiner || !LITTLE_CHILD_DETERMINERS.has(determiner)) return false
  return words[index - 3]?.text !== 'like'
}

/** C.9: "my kid sister" is a sister. The `kid` is not a child marker. */
function kidIsKinCompound(words: ChatWord[], index: number, normalized: string): boolean {
  const text = words[index].text
  if ((text !== 'kid' && text !== 'kids') || !words[index + 1]) return false
  return isKinAt(words, index + 1, normalized)
}

/** C.9: "we were kids" is a relationship's past, not a child in this act. */
function pastRelationshipChild(
  words: ChatWord[],
  index: number,
  live: SexualOccurrence[],
  normalized: string,
): boolean {
  const text = words[index].text
  if (!['kid', 'kids', 'child', 'children', 'teen', 'teens', 'teenager', 'teenagers'].includes(text)) return false
  if (words[index - 1]?.text !== 'were') return false
  const subject = words[index - 2]?.text
  if (subject !== 'we' && subject !== 'i' && subject !== 'you') return false
  const commaIds = clauseIds(words, normalized, true)
  const clause = commaIds[index]
  if (live.some((occurrence) => commaIds[occurrence.start] === clause)) return false
  for (const occurrence of live) {
    if (commaIds[occurrence.start] === clause) continue
    let first = occurrence.start
    while (first > 0 && commaIds[first - 1] === commaIds[occurrence.start]) first--
    const opener = words[first]?.text
    if (opener === 'when' || opener === 'while' || opener === 'as') return false
  }
  return true
}

const TEACHING = new Set(['teach', 'teaches', 'taught'])

/** "I do not want kids, fuck me", "we are trying for a child": having one, not one in the act. */
function wantsChildren(words: ChatWord[], index: number, normalized: string): boolean {
  let at = index - 1
  if (['a', 'another', 'any', 'more'].includes(words[at]?.text ?? '')) at--
  const verb = words[at]?.text ?? ''
  const wants = verb === 'want' || verb === 'wants' || verb === 'wanted' ||
    (verb === 'for' && ['try', 'tries', 'tried', 'trying'].includes(words[at - 1]?.text ?? ''))
  if (!wants) return false
  const next = words[index + 1]
  if (!next || normalized.slice(words[index].end, next.start).includes(',')) return true
  return CONJUNCTIONS.has(next.text) || SUBORDINATORS.has(next.text)
}

/** C.9: a child noun used as a compound or a topic, not a person in the act. */
function minorCompoundOrTopic(words: ChatWord[], index: number, normalized: string): boolean {
  const text = words[index].text
  const base = kinBase(text)
  if ((base === 'kid' || base === 'kids') && isKinAt(words, index + 1, normalized)) return true
  if (text === 'teen' || text === 'teens' || text === 'teenage') {
    if (words[index + 1]?.text === 'years' || words[index + 1]?.text === 'year') return true
  }
  if (base !== text && MINOR_PLACES.has(words[index + 1]?.text ?? '')) return true
  if (text === 'child' && (words[index + 1]?.text === 'support' || words[index + 1]?.text === 'care')) return true
  if (words[index + 1]?.text === 'are' && words[index + 2]?.text === 'grown') return true
  if (wantsChildren(words, index, normalized)) return true
  const previous = words[index - 1]?.text
  if (previous && TEACHING.has(previous)) return true
  if (previous === 'with' && WORK_WITH.has(words[index - 2]?.text ?? '')) return true
  if (previous === 'about' && TALK_ABOUT.has(words[index - 2]?.text ?? '')) return true
  if (previous === 'the' && words[index - 2]?.text === 'about' && TALK_ABOUT.has(words[index - 3]?.text ?? '')) return true
  if (words[index + 1]?.text === 'are' && words[index + 2]?.text === 'made') {
    for (let i = index - 1; i >= index - 4 && i >= 0; i--) {
      if (words[i].text === 'how' || words[i].text === 'where') return true
    }
  }
  return false
}

/** C.9: "I put the kids to bed and then we have sex" — the child is put away. */
function childPutAway(words: ChatWord[], index: number, ids: number[], live: SexualOccurrence[], normalized: string): boolean {
  let verb = -1
  for (let i = index - 1; i >= 0 && i >= index - 3; i--) {
    if (ids[i] !== ids[index]) break
    if (BED_VERBS.has(words[i].text)) {
      verb = i
      break
    }
  }
  if (verb < 0) return false
  let at = index + 1
  let matched = false
  for (const phrase of BED_PHRASES) {
    if (phrase.every((part, offset) => words[at + offset]?.text === part)) {
      at += phrase.length
      matched = true
      break
    }
  }
  if (!matched) return false
  const separator = words[at]
  const comma = separator && normalized.slice(words[at - 1].end, separator.start).includes(',')
  if (!comma && (!separator || !PUT_SEPARATORS.has(separator.text))) return false
  for (let i = at; i < words.length && ids[i] === ids[index]; i++) {
    const act = live.find((occurrence) => occurrence.start === i)
    if (!act) continue
    let object = words[act.end]
    if (object?.text === 'with' || object?.text === 'to') object = words[act.end + 1]
    if (object && (object.text === 'him' || object.text === 'her' || object.text === 'them')) return false
    return true
  }
  return false
}

function minorBlocks(
  words: ChatWord[],
  index: number,
  ids: number[],
  live: SexualOccurrence[],
  normalized: string,
): boolean {
  if (live.length === 0) return false
  // C.9: a denial of being a child is checked before the bystander test, so
  // "she is not a child, she is thirty" clears even with a pronoun in the clause.
  if (childNegated(words, index, ids, live, normalized)) return false
  if (pastRelationshipChild(words, index, live, normalized)) return false
  const clear = bShapeOpen(words, index, ids, live)
  if (coParent(words, index) && !isActObject(words, index, ids, live)) return false
  if (copulaBefore(words, index, ids)) return true
  if (clear) {
    // C.9: a simile names no one ("he fucks like a teenager").
    const simile = words[index - 1]?.text === 'like' ||
      ((words[index - 1]?.text === 'a' || words[index - 1]?.text === 'the') && words[index - 2]?.text === 'like')
    const like = words[index - 1]?.text === 'like' ? index - 1 : index - 2
    // "fuck me like a child" likens the act itself, so it still counts.
    const likensTheAct = live.some((occurrence) => occurrence.end <= like && like - occurrence.end <= 1)
    if (simile && !likensTheAct && !isActObject(words, index, ids, live)) return false
    if (minorCompoundOrTopic(words, index, normalized)) return false
    if (havingChildren(words, index, ids, live, normalized)) return false
    if (whereTheyAre(words, index, normalized, live)) return false
    if (childPutAway(words, index, ids, live, normalized)) return false
  }
  if (!ignoredByClause(index, words, ids, live)) return true
  return hasWatching(words, index, ids)
}

// ── rl-e3: the family reading is a set of LINKS, not a default ───────────────
//
// Children still block by default (rl-e's clause reading, above). Family does
// not: a relative who merely shares a sentence with an act is no longer a
// verdict. A kin word blocks only when the grammar puts it in the act, in one
// of seven ways. Every other reading clears.

/** A.1: the act's complement slot. */
const OBJECT_LINK_PREPS = new Set([
  'with', 'to', 'on', 'onto', 'into', 'inside', 'in', 'for', 'by', 'of', 'over', 'off',
])
/** A.1: desire words also link through "thinking about|thinking of|about". */
const THINKING_LINKS = new Set(['thinking', 'about', 'of'])
const DESIRE_TERMS = new Set([
  'masturbate', 'masturbates', 'masturbating', 'masturbation',
  'aroused', 'arousal', 'horny', 'desire', 'desires', 'desired', 'desiring',
])
/** A.1: verbs whose object is the act ("I want my sister to undress"). */
const ACT_TAKING_VERBS = new Set([
  'want', 'wants', 'wanted', 'wanting',
  'beg', 'begs', 'begged', 'begging',
  'ask', 'asks', 'asked', 'asking',
  'let', 'lets', 'letting',
  'make', 'makes', 'made', 'making',
  'help', 'helps', 'helped', 'helping',
  'force', 'forces', 'forced', 'forcing',
  'tell', 'tells', 'told', 'telling',
  'warn', 'warns', 'warned', 'warning',
])
const ANATOMY_TERMS = new Set([
  'cock', 'cocks', 'dick', 'dicks', 'penis', 'pussy', 'pussies', 'vagina', 'vulva', 'labia',
  'clit', 'clitoris', 'cunt', 'nipple', 'nipples', 'areola', 'testicle', 'testicles',
  'scrotum', 'ballsack', 'foreskin', 'anus', 'erection', 'boner',
])
const STATE_WORDS = new Set(['naked', 'nude', 'topless', 'horny', 'aroused', 'undressed'])
const SPEAKER_POSSESSIVES = new Set(['my', 'our', 'your'])

const ADVERBS = new Set([
  'just', 'only', 'also', 'still', 'already', 'always', 'often', 'sometimes', 'never', 'ever',
  'really', 'actually', 'barely', 'almost', 'then', 'now', 'soon', 'slowly', 'gently',
  'quietly', 'eagerly', 'hungrily', 'deliberately', 'suddenly', 'fully', 'completely',
  'first', 'again', 'later', 'today', 'tonight', 'yesterday', 'quietly', 'together',
])

/** A.2: what may stand between a subject relative and its act. */
const SUBJECT_BRIDGE = new Set([
  ...BE_HAVE_DO, ...ADVERBS,
  'will', 'would', 'could', 'should', 'can', 'may', 'might', 'must', 'shall', 'gonna', 'gotta',
])
/** `wants to`, `begs to`, `starts to`: two-word bridges. */
const BRIDGE_VERB_PAIRS = new Set([
  'wants', 'begs', 'starts', 'began', 'begins', 'tries', 'needs', 'going', 'starts',
])

/** A.1: a gap that holds a verb or a new subject is not the act's complement. */
const GAP_FORBIDDEN = new Set([
  ...CONJUNCTIONS, ...SUBORDINATORS, ...PREPOSITIONS,
  'i', 'we', 'you', 'he', 'she', 'they', 'it', 'me', 'him', 'us', 'them',
  'who', 'whom', 'whose', 'which', 'not', 'no',
  ...SEXUAL_TERMS, ...WATCHING, ...SPEECH_VERBS, ...ACT_TAKING_VERBS,
  'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did', 'done', 'doing',
  'will', 'would', 'could', 'should', 'can', 'may', 'might', 'must', 'shall',
  'go', 'goes', 'went', 'gone', 'going', 'come', 'comes', 'came', 'coming',
  'get', 'gets', 'got', 'getting', 'take', 'takes', 'took', 'give', 'gives', 'gave',
  'put', 'puts', 'says', 'said', 'knows', 'knew', 'sees', 'saw', 'feels', 'felt',
])
const OBJECT_PRONOUNS = new Set(['me', 'him', 'her', 'us', 'them', 'you'])
const PERSON_NOUNS = new Set([
  ...MINOR_NOUNS, 'man', 'men', 'woman', 'women', 'girl', 'girls', 'boy', 'boys',
  'person', 'people', 'guard', 'guards', 'soldier', 'soldiers', 'captain', 'king', 'queen',
  'prince', 'princess', 'lord', 'lady', 'servant', 'maid', 'stranger', 'friend', 'friends',
  'wife', 'husband', 'lover', 'partner', 'boyfriend', 'girlfriend', 'priest', 'knight',
  'merchant', 'farmer', 'sailor', 'monk', 'nun', 'witch', 'wizard',
])

/** A.1: the kin noun phrase is the act's complement. */
function kinObjectLink(
  words: ChatWord[],
  index: number,
  ids: number[],
  live: SexualOccurrence[],
): SexualOccurrence | undefined {
  const clause = ids[index]
  for (const occurrence of live) {
    if (occurrence.start >= index) continue
    if (ids[occurrence.start] !== clause) continue
    const gap = index - occurrence.end
    if (gap < 0 || gap > 3) continue
    const desire = DESIRE_TERMS.has(words[occurrence.start].text)
    let ok = true
    for (let i = occurrence.end; i < index; i++) {
      const text = words[i].text
      // `thinking`, `about` and `of` link a desire word, not an ordinary act.
      if (THINKING_LINKS.has(text) && !OBJECT_LINK_PREPS.has(text)) {
        if (!desire) {
          ok = false
          break
        }
        continue
      }
      if (OBJECT_LINK_PREPS.has(text)) continue
      if (GAP_FORBIDDEN.has(text)) {
        ok = false
        break
      }
    }
    if (ok) return occurrence
  }
  return undefined
}

/** A.1: "I want my sister to undress me" — the taking verb's act is the link. */
function kinActTakingLink(
  words: ChatWord[],
  index: number,
  ids: number[],
  live: SexualOccurrence[],
): SexualOccurrence | undefined {
  const clause = ids[index]
  let taking = false
  for (let i = index - 1; i >= 0 && i >= index - 3; i--) {
    if (ids[i] !== clause) break
    if (ACT_TAKING_VERBS.has(words[i].text)) {
      taking = true
      break
    }
  }
  if (!taking) return undefined
  for (const occurrence of live) {
    if (ids[occurrence.start] !== clause || occurrence.start <= index) continue
    const between = occurrence.start - index - 1
    if (between < 0 || between > 1) continue
    if (between === 1 && words[index + 1].text !== 'to') continue
    const after = words[occurrence.end]
    if (!after || ids[occurrence.end] !== clause) return occurrence
    if (after.text === 'me' || after.text === 'us') return occurrence
    if (PREPOSITIONS.has(after.text) && ids[occurrence.end + 1] === clause) {
      const object = words[occurrence.end + 1]?.text
      if (object === 'me' || object === 'us') return occurrence
    }
  }
  return undefined
}

/** A.2: only auxiliaries, adverbs and "wants to|begs to|starts to" sit between. */
function subjectBridgeOk(words: ChatWord[], index: number, start: number, ids: number[]): boolean {
  const clause = ids[index]
  for (let i = index + 1; i < start; i++) {
    if (ids[i] !== clause) return false
    const text = words[i].text
    if (SUBJECT_BRIDGE.has(text)) continue
    if (BRIDGE_VERB_PAIRS.has(text) && words[i + 1]?.text === 'to') continue
    if (text === 'to' && BRIDGE_VERB_PAIRS.has(words[i - 1]?.text ?? '')) continue
    return false
  }
  return true
}

/** A.2: the act's other side is me/us/I/we/you, unstated, or another kin noun. */
function otherSideAllowsKin(
  words: ChatWord[],
  occurrence: SexualOccurrence,
  ids: number[],
  clause: number,
  normalized: string,
): boolean {
  let at = occurrence.end
  if (words[at]?.text === 'with' || words[at]?.text === 'to') at++
  if (at >= words.length || ids[at] !== clause) return true
  const next = words[at].text
  if (next === 'me' || next === 'us' || next === 'i' || next === 'we' || next === 'you') return true
  if (next === 'him' || next === 'her' || next === 'them') return false
  if (PREPOSITIONS.has(next) || CONJUNCTIONS.has(next) || SUBORDINATORS.has(next)) return true
  for (let i = at; i < words.length && ids[i] === clause && i < at + 3; i++) {
    if (isKinAt(words, i, normalized)) return true
    const text = words[i].text
    if (i === at && (text === 'the' || text === 'a' || CHAT_POSSESSIVES.has(text) || text === 'own')) continue
    if (i > at && (text === 'own' || text === 'older' || text === 'younger' || text === 'little' ||
      text === 'late' || text === 'dead' || CHAT_POSSESSIVES.has(text))) continue
    return false
  }
  return false
}

/** A.2: a clause whose object is anatomy under my|our|your ("My mom rides my cock"). */
function anatomyObjectLink(words: ChatWord[], index: number, ids: number[]): boolean {
  const clause = ids[index]
  for (let i = index + 1; i < words.length && ids[i] === clause; i++) {
    if (!ANATOMY_TERMS.has(words[i].text)) continue
    if (ids[i - 1] === clause && SPEAKER_POSSESSIVES.has(words[i - 1]?.text ?? '')) return true
  }
  return false
}

/** A.2 and A.4: "my mommy makes me horny" — a causative state aimed at the speaker. */
function causativeState(words: ChatWord[], index: number, ids: number[], live: SexualOccurrence[]): boolean {
  const clause = ids[index]
  const verb = words[index + 1]
  if (!verb || ids[index + 1] !== clause) return false
  if (verb.text !== 'make' && verb.text !== 'makes' && verb.text !== 'made' && verb.text !== 'making') return false
  const object = words[index + 2]?.text
  if (ids[index + 2] !== clause || (object !== 'me' && object !== 'us')) return false
  const state = words[index + 3]
  if (!state || ids[index + 3] !== clause || !STATE_WORDS.has(state.text)) return false
  return live.some((occurrence) => occurrence.start === index + 3)
}

/** A.2: the kin noun phrase is the act's subject. */
function kinSubjectLink(
  words: ChatWord[],
  index: number,
  ids: number[],
  live: SexualOccurrence[],
  normalized: string,
): boolean {
  const clause = ids[index]
  if (anatomyObjectLink(words, index, ids)) return true
  if (causativeState(words, index, ids, live)) return true
  for (const occurrence of live) {
    if (occurrence.start <= index) continue
    if (ids[occurrence.start] !== clause) continue
    if (!subjectBridgeOk(words, index, occurrence.start, ids)) continue
    if (parentCouple(words, index) && !objectAfterIsMe(words, occurrence, ids)) continue
    if (otherSideAllowsKin(words, occurrence, ids, clause, normalized)) return true
  }
  return false
}

/** A.3: kin and I, I and kin, me and kin, then an act in the same clause. */
function kinTogetherLink(
  words: ChatWord[],
  index: number,
  ids: number[],
  live: SexualOccurrence[],
  normalized: string,
): boolean {
  const clause = ids[index]
  const partner = (at: number): boolean => {
    let i = at
    while (words[i] && ids[i] === clause && (CHAT_POSSESSIVES.has(words[i].text) || words[i].text === 'own')) i++
    if (!words[i] || ids[i] !== clause) return false
    // A bare `son` or `dad` after "mother and" is kin: the pair frames it.
    return ['i', 'me', 'you', 'we', 'son'].includes(words[i].text) ||
      KIN_ADDRESS_TERMS.includes(words[i].text) || isKinAt(words, i, normalized)
  }
  let together = false
  let right = index + 1
  while (words[right] && ids[right] === clause && (CHAT_POSSESSIVES.has(words[right].text) || words[right].text === 'own')) right++
  if (words[right]?.text === 'and' && ids[right] === clause) together = partner(right + 1)
  if (!together) {
    let left = index - 1
    while (left >= 0 && ids[left] === clause && (CHAT_POSSESSIVES.has(words[left].text) || words[left].text === 'own')) left--
    if (left >= 0 && words[left].text === 'and' && ids[left] === clause) {
      const before = words[left - 1]
      if (before && ids[left - 1] === clause) {
        together = ['i', 'me', 'you', 'we'].includes(before.text) || isKinAt(words, left - 1, normalized)
      }
    }
  }
  if (!together) return false
  return live.some((occurrence) => {
    if (ids[occurrence.start] === clause) {
      // Somebody's two parents together are a couple, unless the act is aimed at the speaker.
      return !parentCouple(words, index) || objectAfterIsMe(words, occurrence, ids)
    }
    // "My cousin and I, naked, kiss"; "my sister and I are alone, we have sex".
    if (ids[occurrence.start] !== clause + 1) return false
    return STATE_WORDS.has(words[occurrence.start].text) || clauseSubject(words, ids, clause + 1)?.text === 'we'
  })
}

const MOTHER_WORDS = new Set(['mother', 'mom', 'mum', 'mommy', 'mummy', 'mama', 'momma'])
const FATHER_WORDS = new Set(['father', 'dad', 'daddy', 'papa'])

function parentCouple(words: ChatWord[], index: number): boolean {
  for (const [left, right] of [[index, index + 2], [index - 2, index], [index, index + 3], [index - 3, index]]) {
    const a = words[left]?.text ?? ''
    const b = words[right]?.text ?? ''
    if (words[left + 1]?.text !== 'and') continue
    if (right - left === 3 && !CHAT_POSSESSIVES.has(words[left + 2]?.text ?? '')) continue
    if ((MOTHER_WORDS.has(a) && FATHER_WORDS.has(b)) || (FATHER_WORDS.has(a) && MOTHER_WORDS.has(b))) return true
  }
  return false
}

/** A.4: the kin word carries a state: "my naked sister", "my sister is naked". */
function kinStateLink(
  words: ChatWord[],
  index: number,
  ids: number[],
  live: SexualOccurrence[],
  normalized: string,
): boolean {
  const clause = ids[index]
  const isLive = (at: number): boolean => live.some((occurrence) => occurrence.start === at)
  const before = words[index - 1]
  if (before && ids[index - 1] === clause && STATE_WORDS.has(before.text) && isLive(index - 1)) return true
  const copula = words[index + 1]
  if (copula && ids[index + 1] === clause && COPULA.has(copula.text)) {
    let j = index + 2
    while (words[j] && ids[j] === clause && ADVERBS.has(words[j].text)) j++
    if (words[j] && ids[j] === clause && STATE_WORDS.has(words[j].text) && isLive(j)) return true
  }
  // Between commas right after it: "My sister, naked, pulls me close".
  for (let i = index + 1; i <= index + 2 && i < words.length; i++) {
    if (!STATE_WORDS.has(words[i].text) || !isLive(i)) continue
    if (normalized.slice(words[i - 1].end, words[i].start).includes(',')) return true
  }
  return false
}

/** A.6: a later act points back with him|her|them at the nearest earlier person. */
function nearestEarlierPersonIsKin(
  words: ChatWord[],
  index: number,
  actStart: number,
  normalized: string,
): boolean {
  for (let i = actStart - 1; i >= 0; i--) {
    if (i === index) return true
    if (isKinAt(words, i, normalized)) return false
    if (PERSON_NOUNS.has(kinBase(words[i].text))) return false
  }
  return false
}

/** `her` right before a noun is a possessive, not an object. */
function possessiveHer(words: ChatWord[], at: number, ids: number[]): boolean {
  const next = words[at + 1]
  if (!next || ids[at + 1] !== ids[at]) return false
  return !PREPOSITIONS.has(next.text) && !CONJUNCTIONS.has(next.text) &&
    !SUBORDINATORS.has(next.text) && !ADVERBS.has(next.text) &&
    !OBJECT_PRONOUNS.has(next.text) && !BE_HAVE_DO.has(next.text)
}

/** The act's own subject is third person: only auxiliaries and adverbs intervene. */
function thirdPersonSubjectBefore(words: ChatWord[], occurrence: SexualOccurrence, ids: number[]): boolean {
  const clause = ids[occurrence.start]
  for (let i = occurrence.start - 1; i >= 0 && ids[i] === clause; i--) {
    const text = words[i].text
    if (text === 'he' || text === 'she' || text === 'they') return true
    if (!SUBJECT_BRIDGE.has(text)) return false
  }
  return false
}

function objectAfterIsMe(words: ChatWord[], occurrence: SexualOccurrence, ids: number[]): boolean {
  let at = occurrence.end
  if (words[at]?.text === 'with' || words[at]?.text === 'to') at++
  return words[at]?.text === 'me' || words[at]?.text === 'us'
}

function kinPointsBack(
  words: ChatWord[],
  index: number,
  ids: number[],
  live: SexualOccurrence[],
  normalized: string,
): boolean {
  for (const occurrence of live) {
    if (occurrence.start <= index) continue
    if (subjectBridgeOk(words, index, occurrence.start, ids)) continue
    if (objectAfterIsMe(words, occurrence, ids) && thirdPersonSubjectBefore(words, occurrence, ids)) {
      if (nearestEarlierPersonIsKin(words, index, occurrence.start, normalized)) return true
    }
    const at = OBJECT_LINK_PREPS.has(words[occurrence.end]?.text ?? '') ? occurrence.end + 1 : occurrence.end
    const object = words[at]
    if (!object || ids[at] !== ids[occurrence.start]) continue
    if (object.text === 'him' || object.text === 'them') {
      if (nearestEarlierPersonIsKin(words, index, occurrence.start, normalized)) return true
    } else if (object.text === 'her' && !possessiveHer(words, at, ids)) {
      if (nearestEarlierPersonIsKin(words, index, occurrence.start, normalized)) return true
    }
  }
  return false
}

/** The act is aimed at somebody in the conversation ("fuck me", "sex with you"). */
function aimedAtSpeakers(words: ChatWord[], occurrence: SexualOccurrence): boolean {
  let at = occurrence.end
  if (PREPOSITIONS.has(words[at]?.text ?? '')) at++
  return ['me', 'us', 'you'].includes(words[at]?.text ?? '')
}

/**
 * The line gives somebody in the act the family role: "he is my brother and I
 * fuck him", "as your father I fuck you", "be my mother and fuck me", and
 * address without a comma ("fuck me sister", "come here daughter").
 */
function kinRoleLink(words: ChatWord[], index: number, ids: number[], live: SexualOccurrence[]): boolean {
  const previous = words[index - 1]?.text ?? ''
  const aimed = live.some((occurrence) => aimedAtSpeakers(words, occurrence))

  if (['me', 'us', 'here', 'please'].includes(previous) && ids[index - 1] === ids[index] && aimed) return true
  if (!CHAT_POSSESSIVES.has(previous)) return false

  const opener = words[index - 2]?.text ?? ''
  if (opener === 'as' && (index === 2 || ids[index - 2] !== ids[index - 3]) && aimed) {
    return ['i', 'you', 'we'].includes(words[index + 1]?.text ?? '') || ids[index + 1] !== ids[index]
  }
  if (['be', 'play', 'become'].includes(opener) && aimed && words[index + 1]?.text !== 'of') return true

  // "he is my brother": the pronoun in the act and the relative are one person.
  const contracted = opener === "he's" || opener === "she's"
  const subject = words[index - 3]?.text
  if (!contracted && !(COPULA.has(opener) && (subject === 'he' || subject === 'she'))) return false
  if (previous !== 'my' && previous !== 'our') return false
  return live.some((occurrence) => {
    const at = PREPOSITIONS.has(words[occurrence.end]?.text ?? '') ? occurrence.end + 1 : occurrence.end
    const object = words[at]?.text
    if (object !== 'him' && !(object === 'her' && !possessiveHer(words, at, ids))) return false
    const actor = actorBefore(words, occurrence.start, ids[occurrence.start], ids)
    return actor === 'first' || actor === 'unknown'
  })
}

const NEW_SUBJECTS = new Set(['i', 'we', 'you', 'he', 'she', 'they', 'him', 'her', 'them', 'it', 'who', 'that'])

/** "My brothers take turns fucking me": no other subject stands before the act. */
function kinActsOnMe(words: ChatWord[], index: number, ids: number[], live: SexualOccurrence[]): boolean {
  if (kinBase(words[index].text) !== words[index].text) return false
  // The relative has to open its clause as the subject.
  if (index > 0 && ids[index - 1] === ids[index] && !CHAT_POSSESSIVES.has(words[index - 1].text) &&
    !CONJUNCTIONS.has(words[index - 1].text) && !ADVERBS.has(words[index - 1].text)) return false
  return live.some((occurrence) => {
    if (occurrence.start <= index || ids[occurrence.start] !== ids[index]) return false
    if (!VERB_ACTS.has(words[occurrence.start].text) && occurrence.end - occurrence.start === 1) return false
    if (!objectAfterIsMe(words, occurrence, ids)) return false
    for (let i = index + 1; i < occurrence.start; i++) {
      const text = words[i].text
      if (NEW_SUBJECTS.has(text) || DETERMINERS.has(text) || CHAT_POSSESSIVES.has(text)) return false
      if (SPEECH_VERBS.has(text) || ACT_TAKING_VERBS.has(text)) return false
    }
    return true
  })
}

/** Touch between the speaker and the relative, which the act then continues. */
const CONTACT = new Set([
  'kiss', 'kisses', 'kissed', 'kissing', 'touch', 'touches', 'touched', 'touching',
  'caress', 'caresses', 'caressed', 'caressing', 'marry', 'marries', 'married', 'straddle', 'straddles',
  'straddled', 'climb', 'climbs', 'climbed', 'grope', 'gropes', 'groped', 'seduce', 'seduces', 'seduced',
  'pull', 'pulls', 'pulled', 'pin', 'pins', 'pinned',
  'undress', 'undresses', 'undressed', 'undressing', 'strip', 'strips', 'stripped',
])
const CONTACT_SIDE = new Set(['me', 'us'])
const SHARED_BED = [['in', 'my', 'bed'], ['in', 'our', 'bed'], ['with', 'me'], ['on', 'top', 'of', 'me'], ['next', 'to', 'me'], ['beside', 'me']]

function kinContactLink(words: ChatWord[], index: number, ids: number[], live: SexualOccurrence[]): boolean {
  if (kinBase(words[index].text) !== words[index].text) return false
  const owner = words[index - 1]?.text
  if (owner !== 'my' && owner !== 'our' && owner !== 'own') return false
  const next = words[index + 1]?.text ?? ''
  const after = words[index + 2]?.text ?? ''
  // "my uncle pulls me close", "my sister climbs on me"; "I kiss my sister".
  const reaching = CONTACT.has(next) &&
    (CONTACT_SIDE.has(after) || (PREPOSITIONS.has(after) && CONTACT_SIDE.has(words[index + 3]?.text ?? '')))
  const start = owner === 'own' ? index - 3 : index - 2
  const reached = CONTACT.has(words[start]?.text ?? '') && ['i', 'we', undefined].includes(words[start - 1]?.text)
  const shared = COPULA.has(next) &&
    SHARED_BED.some((phrase) => phrase.every((part, offset) => words[index + 2 + offset]?.text === part))
  if (!reaching && !reached && !shared) return false
  return live.some((occurrence) => {
    if (occurrence.start <= index) return false
    const before = words[occurrence.start - 1]?.text ?? ''
    // The act is theirs together ("and we have sex"), or goes on without a new subject.
    if (before === 'we' || before === 'naked') return true
    if (reaching && ((STATE_WORDS.has(words[occurrence.start].text) && ids[occurrence.start] === ids[index]) || before === 'and' || before === 'then')) return before !== 'i'
    return (reached || shared) && before === 'then' && !FIRST_PERSON.has(words[occurrence.start - 2]?.text ?? '')
  })
}

const TAKING_PART = new Set([
  'watch', 'watches', 'watched', 'watching', 'join', 'joins', 'joined', 'joining',
])

/** "My sister joins us having sex", "my brother watches us fuck". */
function kinTakesPart(words: ChatWord[], index: number, ids: number[], live: SexualOccurrence[]): boolean {
  // "Big Brother is watching us" is the idiom unless somebody owns him.
  if (words[index - 1]?.text === 'big' && !CHAT_POSSESSIVES.has(words[index - 2]?.text ?? '')) return false
  let at = index + 1
  while (words[at] && ids[at] === ids[index] && SUBJECT_BRIDGE.has(words[at].text)) at++
  if (!words[at] || ids[at] !== ids[index] || !TAKING_PART.has(words[at].text)) return false
  if (words[at + 1]?.text !== 'me' && words[at + 1]?.text !== 'us') return false
  return live.some((occurrence) => occurrence.start > at && ids[occurrence.start] === ids[index])
}

function kinBlocks(
  words: ChatWord[],
  index: number,
  ids: number[],
  live: SexualOccurrence[],
  normalized: string,
): boolean {
  if (live.length === 0) return false
  if (ownsPlace(words, index) || coParent(words, index)) return false
  // The theme word itself is the one accepted over-block (see the legacy audit).
  if (words.some((word) => word.text === 'incest' || word.text === 'incestuous')) return true
  if (kinIdentityCopula(words, index, ids)) return true
  if (kinAloneBlocks(words, index, ids, live)) return true

  const objectOf = kinObjectLink(words, index, ids, live)
  if (objectOf && whoseRelativeBlocks(words, index, ids, objectOf)) return true
  const taking = kinActTakingLink(words, index, ids, live)
  if (taking && whoseRelativeBlocks(words, index, ids, taking)) return true

  if (kinSubjectLink(words, index, ids, live, normalized)) return true
  if (kinTogetherLink(words, index, ids, live, normalized)) return true
  if (kinStateLink(words, index, ids, live, normalized)) return true
  if (kinRoleLink(words, index, ids, live)) return true
  if (kinActsOnMe(words, index, ids, live)) return true
  if (kinContactLink(words, index, ids, live)) return true
  if (kinTakesPart(words, index, ids, live)) return true
  if (kinPointsBack(words, index, ids, live, normalized)) return true
  return false
}

function hasTerm(words: Set<string>, terms: Set<string>): boolean {
  for (const w of words) if (terms.has(w)) return true
  return false
}

function hasSexualSignal(words: Set<string>, normalized: string): boolean {
  if (hasTerm(words, SEXUAL_TERMS)) return true
  return SEXUAL_PHRASES.some((p) => normalized.includes(p))
}

function hasMinorSignal(words: Set<string>, normalized: string): boolean {
  if (hasTerm(words, MINOR_TERMS)) return true
  return MINOR_AGE_PATTERNS.some((re) => re.test(normalized))
}

/**
 * Screen one player message. Returns a blocking verdict only when an
 * unambiguous sexual signal and a guarded theme occur in the SAME sentence,
 * read clause by clause — the narrowest reading that still catches the thing it
 * is for.
 */
export function screenPlayerInput(text: string): GuardVerdict {
  if (!text || typeof text !== 'string') return { blocked: false }

  for (const raw of splitSentences(text)) {
    const normalized = chatNormalize(maskFigurativeKin(raw))
    const words = chatWords(normalized)
    const occurrences = sexualOccurrences(words)
    if (occurrences.length === 0 && !words.some((word) => MINOR_EXTRA_ACTS.has(word.text))) continue

    const kinIds = clauseIds(words, normalized, true)
    const minorIds = clauseIds(words, normalized, false)
    // B: a `fuck` expletive is no sexual signal at all.
    const acted = occurrences
      .filter((occurrence) => !denies(words, occurrence, kinIds))
      .filter((occurrence) => !expletiveFuck(words, occurrence.start, normalized))
    // C.8: `undresses` and `strips` count only for the child reading.
    const minorLive = [...acted]
    for (let i = 0; i < words.length; i++) {
      if (!MINOR_EXTRA_ACTS.has(words[i].text)) continue
      const occurrence = { start: i, end: i + 1 }
      if (!denies(words, occurrence, kinIds)) minorLive.push(occurrence)
    }
    // A: for the family reading the act must be live, not only talked about.
    const kinLive = acted.filter((occurrence) => !isTopic(words, occurrence, kinIds))
    // A stated age is read even beside a denial; only an expletive is no signal.
    const spoken = occurrences.some((occurrence) => !expletiveFuck(words, occurrence.start, normalized))
    if (!spoken && minorLive.length === 0) continue

    if (GUARD_CATEGORIES.minor_sexual) {
      // Stated ages, `underage` and the coded terms count anywhere in the sentence.
      if (statedMinorAge(normalized) || words.some((word) => MINOR_ALWAYS.has(word.text))) {
        return { blocked: true, category: 'minor_sexual', message: GUARD_MESSAGES.minor_sexual }
      }
      for (let i = 0; i < words.length; i++) {
        const noun = (MINOR_NOUNS.has(words[i].text) && !kidIsKinCompound(words, i, normalized)) ||
          littleChildAt(words, i) ||
          ((words[i].text === 'minor' || words[i].text === 'minors') && minorIsNoun(words, i, normalized))
        if (noun && minorBlocks(words, i, minorIds, minorLive, normalized)) {
          return { blocked: true, category: 'minor_sexual', message: GUARD_MESSAGES.minor_sexual }
        }
      }
    }

    if (GUARD_CATEGORIES.incest) {
      for (let i = 0; i < words.length; i++) {
        if (isKinAt(words, i, normalized) && kinBlocks(words, i, kinIds, kinLive, normalized)) {
          return { blocked: true, category: 'incest', message: GUARD_MESSAGES.incest }
        }
      }
    }
  }

  return { blocked: false }
}

/**
 * Signals that a requested IMAGE is sexualized, beyond the explicit vocabulary
 * shared with chat. These are broad on purpose and are used for ONE thing: they
 * count as a sexual signal only when a minor marker is also present.
 *
 * "A seductive sorceress in a corset" is a legitimate adult request and passes.
 * "A 12 year old in a swimsuit" does not — no explicit word appears in it, so
 * the text lexicon alone would let it through, and for a generated image that
 * is the wrong side to be wrong on.
 */
const VISUAL_SEXUAL_TERMS = new Set([
  'bikini', 'swimsuit', 'swimwear', 'underwear', 'bra', 'braless', 'thong',
  'negligee', 'corset', 'garter', 'fishnet', 'stockings', 'shirtless',
  'cleavage', 'scantily', 'skimpy', 'revealing', 'sheer', 'see-through',
  'lewd', 'erotic', 'erotica', 'seductive', 'provocative', 'suggestive',
  'sensual', 'fetish', 'bdsm', 'bondage', 'pinup', 'boudoir', 'upskirt',
  'nsfw', 'hentai', 'ecchi', 'rule34',
])

const VISUAL_SEXUAL_PHRASES = [
  'spread legs', 'legs spread', 'bent over', 'barely dressed', 'no clothes',
  'without clothes', 'suggestive pose',
]

const IMAGE_MESSAGES: Record<GuardCategory, string> = {
  minor_sexual:
    'Everlore will not generate imagery that sexualises a minor. Change the description and try again.',
  incest:
    'Everlore will not generate sexual imagery involving family members. Change the description and try again.',
}

/**
 * Screen an image-generation prompt.
 *
 * Two things differ from the chat guard, both because a prompt describes ONE
 * picture rather than a passage of prose:
 *
 *  - Scope is the WHOLE prompt, not per sentence. Image prompts are comma-
 *    separated fragments, and every fragment describes the same image, so
 *    "a young girl. a nude woman." is one request and must be read as one.
 *  - The minor category additionally counts sexualized-appearance terms. The
 *    incest category does not: it keeps the strict explicit lexicon, so ordinary
 *    adult art direction is never caught by the broader list.
 */
export function screenImagePrompt(text: string): GuardVerdict {
  if (!text || typeof text !== 'string') return { blocked: false }

  const normalized = normalize(maskFigurativeKin(text))
  const words = new Set(normalized.match(TOKEN) ?? [])

  const explicit = hasSexualSignal(words, normalized)
  const sexualized =
    explicit ||
    hasTerm(words, VISUAL_SEXUAL_TERMS) ||
    VISUAL_SEXUAL_PHRASES.some((p) => normalized.includes(p))

  if (GUARD_CATEGORIES.minor_sexual && sexualized && hasMinorSignal(words, normalized)) {
    return { blocked: true, category: 'minor_sexual', message: IMAGE_MESSAGES.minor_sexual }
  }

  const kinSignal = hasTerm(words, KIN_TERMS) || SON_ANYWHERE.test(normalized) || POSSESSED_KIN_ADDRESS.test(normalized)
  if (GUARD_CATEGORIES.incest && explicit && kinSignal) {
    return { blocked: true, category: 'incest', message: IMAGE_MESSAGES.incest }
  }

  return { blocked: false }
}
