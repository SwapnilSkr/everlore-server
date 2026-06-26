import type { ObjectId } from 'mongodb'
import type { WorldFactSource } from '../utils/world-authority'

/**
 * signal_ledger — the FP/FN measurement substrate for the deterministic signal
 * detectors (movement, time, party, kinship, presence). One compact row per turn,
 * written fire-and-forget on the post-stream tail (never blocks a turn).
 *
 * Why it exists: enriching a detector (wider lexicon, lemmatization, fuzzier match)
 * trades recall for precision, and you cannot tune that trade by vibes. Aggregated
 * over turns this ledger yields:
 *   - RECALL proxy   — `detected` vs `miss_candidates` (prose named something no
 *                       detector caught). Enrichment that helps drives misses DOWN.
 *   - PRECISION proxy — `committed` on turns later/also flagged `player_corrected`
 *                       (the player retconned canon). Enrichment that over-fires
 *                       drives corrections UP.
 *   - TIER MIX       — `by_tier` shows how much commits as hard canon vs a hedged
 *                       hint; healthy enrichment grows canon, noise grows hint/hidden.
 */

export type LedgerSignalType = 'movement' | 'time' | 'party' | 'kinship' | 'presence'

/** Per-signal accounting for ONE turn.
 *
 *  UNIT CAVEAT — `detected` and `committed` share a unit for movement/time/party/
 *  presence (one candidate ↔ one commit), so their commit% is directly meaningful.
 *  For KINSHIP they do NOT: `detected` counts asserted ties while `committed` counts
 *  directed graph EDGES, which are inverse-closed ("A is B's father" also writes "B
 *  is A's child"), so kinship `committed` runs ~2× its ties and its commit% reads
 *  ~200% by construction. Read kinship's commit% as a TREND across runs, not an
 *  absolute, and don't cross-compare it to the other signals. */
export interface SignalTally {
  /** Candidates the detector produced this turn (pre-commit). For kinship: asserted ties. */
  detected: number
  /** How many became committed state/canon this turn. For kinship: directed edges
   *  (inverse-closed ⇒ ~2× the asserted ties); see the UNIT CAVEAT above. */
  committed: number
  /** Committed breakdown by consumption tier — only for signals whose brief is
   *  confidence-tiered (kinship, party, presence). Absent for movement/time, whose
   *  committed state (cursor/calendar) is hard fact, not hint-able. */
  by_tier?: { canon: number; hint: number; hidden: number }
  /** Dominant provenance of the committed fact, when single-valued (movement/time). */
  source?: WorldFactSource
  confidence?: number
}

export interface SignalLedgerDoc {
  _id: ObjectId
  instance_id: ObjectId
  player_id: ObjectId
  event_id: ObjectId | null
  sequence: number
  /** This turn carried an explicit player correction/retcon — the precision
   *  ground-truth: a commit this overturns is a confirmed false positive. */
  player_corrected: boolean
  /** FN candidates this turn = projection-anomaly "miss" findings (prose named a
   *  person/kin/place the projection didn't record). The recall ground-truth. */
  miss_candidates: number
  signals: Partial<Record<LedgerSignalType, SignalTally>>
  created_at: Date
}
