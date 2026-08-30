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

const MESSAGES: Record<GuardCategory, string> = {
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
  'son', 'sons', 'daughter', 'daughters',
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
 * unambiguous sexual signal and a guarded theme occur in the SAME sentence —
 * the narrowest reading that still catches the thing it is for.
 */
export function screenPlayerInput(text: string): GuardVerdict {
  if (!text || typeof text !== 'string') return { blocked: false }

  for (const raw of splitSentences(text)) {
    const normalized = normalize(maskFigurativeKin(raw))
    const words = new Set(normalized.match(TOKEN) ?? [])
    if (!hasSexualSignal(words, normalized)) continue

    if (GUARD_CATEGORIES.minor_sexual && hasMinorSignal(words, normalized)) {
      return { blocked: true, category: 'minor_sexual', message: MESSAGES.minor_sexual }
    }
    const kinSignal = hasTerm(words, KIN_TERMS) || POSSESSED_KIN_ADDRESS.test(normalized)
    if (GUARD_CATEGORIES.incest && kinSignal) {
      return { blocked: true, category: 'incest', message: MESSAGES.incest }
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

  const kinSignal = hasTerm(words, KIN_TERMS) || POSSESSED_KIN_ADDRESS.test(normalized)
  if (GUARD_CATEGORIES.incest && explicit && kinSignal) {
    return { blocked: true, category: 'incest', message: IMAGE_MESSAGES.incest }
  }

  return { blocked: false }
}
