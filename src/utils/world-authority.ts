/**
 * World-fact AUTHORITY model — the single source of truth for "who said this, and
 * how much do we trust it" across every world-state mutation the engine extracts.
 *
 * Every delta the system derives from a turn — codex facts, kinship assertions,
 * location facts, entity edges, memory atoms, side-chat facts — originates from a
 * SOURCE with a known authority. A player explicitly RETCONNING canon outranks the
 * narrator; the narrator outranks an inference; an NPC merely CLAIMING something
 * (maybe a lie) is the weakest signal that still writes a fact. Encoding this once
 * lets every merge/fold step resolve contradictions the same way instead of each
 * call site inventing its own ad-hoc precedence.
 *
 * Design notes:
 * - The ladder is intentionally small and CLOSED. New genres don't add sources;
 *   they reuse these.
 * - `player_correction` is the only source that can RETCON existing canon. Others
 *   append/refine; they never overwrite a higher-authority fact.
 * - `character_claim` writes a LOW-confidence fact that must be corroborated before
 *   it becomes hard canon — it models in-world lies/rumors.
 * - Off the TTFT path: this is consumed by post-stream extractors/mergers only.
 */

/** Where a derived world fact came from, ordered loosely high→low authority. */
export type WorldFactSource =
  | 'system_seed' // authored world/template canon (premise, seeded cast)
  | 'player_correction' // player explicitly corrects/retcons canon — highest
  | 'player_narration' // player-authored narration stating a fact as true
  | 'narrator' // AI narration stated it directly
  | 'side_chat' // established in a side conversation (scoped, see visibility)
  | 'player_claim' // player CHARACTER said/claimed it in-world dialogue
  | 'character_claim' // an NPC/AI character claimed it (may be a lie)
  | 'inference' // the system inferred it (deterministic or LLM guess)

/** The closed set, high→low, for iteration and validation. */
export const WORLD_FACT_SOURCES: WorldFactSource[] = [
  'player_correction',
  'system_seed',
  'player_narration',
  'narrator',
  'side_chat',
  'player_claim',
  'character_claim',
  'inference',
]

const SOURCE_SET = new Set<string>(WORLD_FACT_SOURCES)
export function isWorldFactSource(s: unknown): s is WorldFactSource {
  return typeof s === 'string' && SOURCE_SET.has(s)
}

/**
 * Confidence each source carries [0..1]. Used to seed a fact's confidence when the
 * extractor doesn't supply one, and to break ties when two facts share rank.
 * `player_correction` is 1.0 (canon by fiat); `inference` is the floor.
 */
export const SOURCE_CONFIDENCE: Record<WorldFactSource, number> = {
  player_correction: 1.0,
  system_seed: 0.95,
  player_narration: 0.9,
  narrator: 0.9,
  side_chat: 0.75,
  player_claim: 0.65,
  character_claim: 0.5,
  inference: 0.35,
}

/**
 * Strict precedence rank — LOWER number wins. Distinct from confidence: two
 * sources can share a confidence (narrator & player_narration are both 0.9) yet
 * have different override authority. `player_correction` outranks everything; only
 * it may retcon a fact established by a lower rank.
 */
export const SOURCE_RANK: Record<WorldFactSource, number> = {
  player_correction: 0,
  system_seed: 1,
  player_narration: 2,
  narrator: 3,
  side_chat: 4,
  player_claim: 5,
  character_claim: 6,
  inference: 7,
}

/** Default confidence for a source (its baseline), clamped to [0,1]. */
export function confidenceFor(source: WorldFactSource): number {
  return SOURCE_CONFIDENCE[source] ?? SOURCE_CONFIDENCE.inference
}

/**
 * Compare two sources for authority. Returns a negative number if `a` outranks
 * `b` (a wins), positive if `b` outranks `a`, 0 if equal rank. Suitable for
 * `Array.prototype.sort` to order best-authority-first.
 */
export function compareAuthority(a: WorldFactSource, b: WorldFactSource): number {
  return SOURCE_RANK[a] - SOURCE_RANK[b]
}

/** The higher-authority of two sources (the one that should win a contradiction). */
export function strongerSource(a: WorldFactSource, b: WorldFactSource): WorldFactSource {
  return SOURCE_RANK[a] <= SOURCE_RANK[b] ? a : b
}

/** True when the fact was authored by the PLAYER (correction/narration/claim). */
export function isPlayerAuthored(source: WorldFactSource): boolean {
  return source === 'player_correction' || source === 'player_narration' || source === 'player_claim'
}

/** Only a player_correction may RETCON (overwrite/end) an existing canon fact. */
export function canRetcon(source: WorldFactSource): boolean {
  return source === 'player_correction'
}

/**
 * True when a fact is strong enough to be treated as HARD CANON on its own (no
 * corroboration needed). Claims (player or character) are soft until corroborated.
 */
export function isHardCanon(source: WorldFactSource): boolean {
  return SOURCE_RANK[source] <= SOURCE_RANK.narrator
}

/** Visibility of a fact — who in the world is allowed to KNOW it. Drives whether a
 *  side-chat / private fact may enter the player-visible main context. */
export type VisibilityScope =
  | 'public' // anyone may know — safe for main narration
  | 'local' // known to those present where it happened
  | 'private' // known only to specific participants
  | 'player_known' // the player/protagonist knows it (safe to surface to player)

export const VISIBILITY_SCOPES: VisibilityScope[] = ['public', 'local', 'private', 'player_known']

const VISIBILITY_SET = new Set<string>(VISIBILITY_SCOPES)
export function isVisibilityScope(s: unknown): s is VisibilityScope {
  return typeof s === 'string' && VISIBILITY_SET.has(s)
}

/** Where a fact's originating EVENT lives — which chronicle channel produced it. */
export type FactOrigin = 'main' | 'side_chat' | 'replay' | 'manual_track'

export const FACT_ORIGINS: FactOrigin[] = ['main', 'side_chat', 'replay', 'manual_track']

/**
 * The provenance envelope every extracted delta should carry. Optional fields stay
 * optional so existing deltas (which only know their `source`) keep validating —
 * `confidence` is filled from `confidenceFor(source)` when absent.
 */
export interface FactProvenance {
  source: WorldFactSource
  confidence?: number
  visibility_scope?: VisibilityScope
  origin?: FactOrigin
}

/** Normalize a (possibly partial/legacy) provenance into a complete one, deriving
 *  confidence from the source when missing and defaulting origin to 'main'. */
export function normalizeProvenance(
  p: Partial<FactProvenance> | undefined,
  fallbackSource: WorldFactSource = 'inference',
): Required<Pick<FactProvenance, 'source' | 'confidence' | 'origin'>> & FactProvenance {
  const source = isWorldFactSource(p?.source) ? (p!.source as WorldFactSource) : fallbackSource
  const confidence =
    typeof p?.confidence === 'number' && p.confidence >= 0 && p.confidence <= 1
      ? p.confidence
      : confidenceFor(source)
  const origin: FactOrigin = FACT_ORIGINS.includes(p?.origin as FactOrigin)
    ? (p!.origin as FactOrigin)
    : 'main'
  const out: Required<Pick<FactProvenance, 'source' | 'confidence' | 'origin'>> & FactProvenance = {
    source,
    confidence,
    origin,
  }
  if (isVisibilityScope(p?.visibility_scope)) out.visibility_scope = p!.visibility_scope
  return out
}
