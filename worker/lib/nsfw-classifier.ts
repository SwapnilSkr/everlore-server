import { mongoColl } from '../../src/config/mongo'

/**
 * Fallback explicit-only signals, used ONLY until the Mongo-backed lexicon
 * (`nsfw_lexicon`, seeded by scripts/seed-nsfw-lexicon.ts) is loaded, or if the
 * load fails. Deliberately narrow: romance words are excluded so affection stays
 * on the SFW model. Map value = weight (strong=2, ambiguous=1).
 */
const FALLBACK_WORDS: Record<string, number> = {
  naked: 2, nude: 2, undress: 2, undressed: 2, undressing: 2,
  orgasm: 2, climax: 2, cum: 2, cumming: 2, horny: 2, aroused: 2, arousal: 2,
  cock: 2, pussy: 2, clit: 2, fuck: 2, fucking: 2, erection: 2,
  moan: 1, moans: 1, moaning: 1, thrust: 1, thrusts: 1, thrusting: 1,
  thigh: 1, thighs: 1, nipple: 1, nipples: 1, wet: 1, grind: 1, stroke: 1,
}

/** Behavioral phrase patterns — kept in code (regex semantics, not flat terms). */
const EXPLICIT_PATTERNS = [
  /take\s+(off|me)/i,
  /don['']t\s+stop/i,
  /inside\s+(me|you)/i,
  /make\s+love/i,
  /\bfuck/i,
  /want\s+you\s+(inside|now|so)/i,
]

const SIGNAL_THRESHOLD = 3

// --- Mongo-backed lexicon cache (loaded once at worker boot, refreshed lazily) ---
let wordWeights: Record<string, number> = FALLBACK_WORDS
let phraseWeights: Array<{ term: string; weight: number }> = []
let loaded = false
let lastLoad = 0
const REFRESH_MS = 30 * 60 * 1000 // re-read lexicon at most twice an hour

/**
 * Load routable lexicon terms (weight >= 1) from Mongo into the in-memory caches.
 * Call once at worker startup. Safe to call repeatedly; throttled by REFRESH_MS.
 * On any failure the existing cache (or the built-in fallback) is retained.
 */
export async function loadNsfwLexicon(force = false): Promise<void> {
  if (!force && loaded && Date.now() - lastLoad < REFRESH_MS) return
  try {
    const docs = await mongoColl
      .nsfwLexicon()
      .find({ weight: { $gte: 1 } }, { projection: { term: 1, is_phrase: 1, weight: 1 } })
      .toArray()

    if (docs.length === 0) return // keep fallback until the collection is seeded

    const words: Record<string, number> = {}
    const phrases: Array<{ term: string; weight: number }> = []
    for (const d of docs as any[]) {
      if (d.is_phrase) phrases.push({ term: d.term, weight: d.weight })
      else words[d.term] = d.weight
    }
    wordWeights = words
    phraseWeights = phrases
    loaded = true
    lastLoad = Date.now()
    console.log(`[nsfw-classifier] lexicon loaded: ${Object.keys(words).length} words, ${phrases.length} phrases`)
  } catch (e) {
    console.warn('[nsfw-classifier] lexicon load failed; using fallback:', (e as Error).message)
  }
}

/**
 * Decide whether THIS turn should route to the NSFW (explicit) narration model.
 *
 * Design goals:
 * - Romance must NOT trip this — only explicit content does (narrow, weighted lexicon).
 * - A single ambiguous word (weight 1) can't cross the threshold on its own.
 * - Momentum only SUSTAINS an already-explicit scene; it feeds exclusively off
 *   prior turns tagged `intimate` (explicit only — romance is tagged `romantic`
 *   and is ignored). This kills the old self-reinforcing romance->NSFW lock.
 */
export function classifyScene(
  userMessage: string,
  recentEvents: any[],
): 'sfw' | 'nsfw' {
  const text = (userMessage || '').toLowerCase()

  let signalCount = 0

  const words = text.split(/\s+/)
  for (const word of words) {
    const w = wordWeights[word]
    if (w) signalCount += w
  }

  for (const { term, weight } of phraseWeights) {
    if (text.includes(term)) signalCount += weight
  }

  for (const pattern of EXPLICIT_PATTERNS) {
    if (pattern.test(text)) signalCount += 2
  }

  // Momentum: ONLY explicit (intimate-tagged) recent turns count. Romantic turns
  // are tagged `romantic` and contribute nothing.
  const recentExplicit = recentEvents
    .slice(-3)
    .filter((e) => e.scene_tag === 'intimate' || e.type === 'intimate').length
  signalCount += recentExplicit * 2

  return signalCount >= SIGNAL_THRESHOLD ? 'nsfw' : 'sfw'
}
