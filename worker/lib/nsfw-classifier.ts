import { mongoColl } from '../../src/config/mongo'
import { callLLM, AI_MODELS } from '../../src/ai'
import { env } from '../../src/config/env'

/**
 * Fallback explicit-only signals, used ONLY until the Mongo-backed lexicon
 * (`nsfw_lexicon`, seeded by scripts/seed-nsfw-lexicon.ts) is loaded, or if the
 * load fails. Deliberately narrow: romance words are excluded so affection stays
 * on the SFW model. Map value = weight (strong=2, ambiguous=1).
 */
const FALLBACK_WORDS: Record<string, number> = {
  naked: 2, nude: 2, undress: 2, undressed: 2, undressing: 2,
  orgasm: 2, climax: 2, cum: 2, cumming: 2, horny: 2, aroused: 2, arousal: 2,
  cock: 2, dick: 2, penis: 2, pussy: 2, clit: 2, cunt: 2, fuck: 2, fucking: 2,
  sex: 2, sexual: 2, erection: 2, blowjob: 2, oral: 2, breasts: 2, breast: 2,
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
  /\b(suck|lick|ride)\s+(my|your|his|her|their)?\s*(cock|dick|pussy|clit|cunt|penis)\b/i,
  /\b(cock|dick|pussy|clit|cunt|penis)\b/i,
  /want\s+you\s+(inside|now|so)/i,
]

/** Ambiguous intent patterns (weight 1) kept in CODE so they apply regardless of
 *  the Mongo lexicon's contents. Each alone stays SFW (1 < threshold) so romance
 *  ("an intimate dinner", "she caressed his arm") never trips; but combined with a
 *  strong term or each other they push an explicit scene to the NSFW model. Closes
 *  the run-d miss: "I undress and offer myself … seeking intimacy" scored only the
 *  lexicon's undress=2 and routed SFW despite clear explicit intent. */
const AMBIGUOUS_PATTERNS = [
  /\bintimac(?:y|ies)\b/i,
  /\bintimate(?:ly)?\b/i,
  /\bseduc(?:e|es|ed|ing|tive|tion)\b/i,
  /\bcaress(?:es|ed|ing)?\b/i,
  /\bstrip(?:s|ped|ping)?\b/i,
  /\bbare\s+(?:skin|body|flesh|chest|breasts?)\b/i,
  /\boffer(?:s|ed|ing)?\s+(?:myself|yourself|himself|herself|themselves|my\s+body|your\s+body)\b/i,
  /\bgive\s+(?:myself|yourself)\s+to\b/i,
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
  return scoreScene(userMessage, recentEvents).decision
}

/**
 * Same lexicon scoring as classifyScene, but also returns the raw signal count
 * so the caller can detect the BORDERLINE band (1–2) and optionally defer to an
 * intent classifier. Score 0 and score >=3 are decided here and need no LLM.
 */
export function scoreScene(
  userMessage: string,
  recentEvents: any[],
): { decision: 'sfw' | 'nsfw'; score: number } {
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

  for (const pattern of AMBIGUOUS_PATTERNS) {
    if (pattern.test(text)) signalCount += 1
  }

  // Momentum: ONLY explicit (intimate-tagged) recent turns count. Romantic turns
  // are tagged `romantic` and contribute nothing.
  const recentExplicit = recentEvents
    .slice(-3)
    .filter(
      (e) =>
        e.scene_tag === 'intimate' ||
        e.type === 'intimate' ||
        // Set off the TTFT path by the post-turn intent judge: a prior turn where
        // the PLAYER expressed clean-language sexual intent the lexicon missed.
        // This is how that intent arms routing without a read-path LLM call.
        e.nsfw_intent === true,
    ).length
  signalCount += recentExplicit * 2

  return {
    decision: signalCount >= SIGNAL_THRESHOLD ? 'nsfw' : 'sfw',
    score: signalCount,
  }
}

/**
 * Borderline-intent deferral (risk G). The lexicon catches explicit VOCABULARY
 * but misses explicit INTENT in clean language ("take me", "I give myself to
 * you"). Growing the word list is a treadmill; instead, ONLY for the borderline
 * band (lexicon score 1–2) we ask a cheap aux judge whether the turn expresses
 * unambiguous sexual intent. Score 0 and score >=3 never reach here.
 *
 * This is the SECONDARY signal: chat-mode (Ardent) opt-in is primary. CRITICAL:
 * the caller runs this AFTER the turn has streamed (off the TTFT path), using the
 * result to set `nsfw_intent` on the event so it arms the NEXT turn's momentum —
 * never synchronously before generation, which would add latency to first token.
 * Gated behind NSFW_INTENT_DEFER_ENABLED. DEFENSIVE: any error/timeout/malformed
 * reply falls back to SFW — never throws, never escalates on uncertainty.
 */
export async function classifyBorderlineIntent(
  userMessage: string,
): Promise<'sfw' | 'nsfw'> {
  if (!env.NSFW_INTENT_DEFER_ENABLED) return 'sfw'
  const text = (userMessage || '').trim()
  if (!text) return 'sfw'
  try {
    const raw = await callLLM({
      model: AI_MODELS.cheapRank,
      temperature: 0,
      maxTokens: 16,
      timeoutMs: 6000,
      responseFormat: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You decide if a single roleplay turn expresses unambiguous SEXUAL INTENT — ' +
            'a clear move to initiate or continue a sex act — even when phrased in clean, ' +
            'non-explicit language (e.g. "take me", "I give myself to you", "I want you inside me"). ' +
            'Romance, flirting, kissing, affection, or tension WITHOUT a clear move to sex is NOT sexual intent. ' +
            'When unsure, answer false. Return ONLY JSON: {"sexual_intent": true|false}.',
        },
        { role: 'user', content: text.slice(0, 600) },
      ],
    })
    const parsed = JSON.parse(raw) as { sexual_intent?: boolean }
    return parsed?.sexual_intent === true ? 'nsfw' : 'sfw'
  } catch (err) {
    console.warn('[nsfw-classifier] borderline intent check failed; staying SFW:', (err as Error).message)
    return 'sfw'
  }
}
