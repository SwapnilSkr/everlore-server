/**
 * FP/FN signal ledger builder (pure, no DB/LLM). Turns the per-signal detected vs
 * committed facts already computed during a turn into one compact ledger row. The
 * processor persists the result fire-and-forget; aggregation over rows yields the
 * recall/precision/tier-mix proxies described in signal-ledger.model.ts.
 *
 * Kept deterministic + pure so an audit pins the accounting and so it can never
 * affect a turn (it only reads what the turn already decided).
 */
import { type WorldFactSource, confidenceTier } from '../../src/utils/world-authority'
import type { LedgerSignalType, SignalTally } from '../../src/models/signal-ledger.model'

/** A single hard-committed fact (movement/time): provenance recorded, not tiered. */
interface SingleSignal {
  detected: boolean
  committed: boolean
  source?: WorldFactSource
  confidence?: number
}

export interface SignalLedgerInput {
  movement: SingleSignal
  time: SingleSignal
  /** Party JOINS this turn: candidates detected vs the confidences of fresh commits. */
  party: { detected: number; committedConfidences: number[] }
  /** Kinship: assertions detected vs edges written, with written-edge confidences. */
  kinship: { detected: number; committed: number; committedConfidences?: number[] }
  /** Presence arbitration: endpoint citations detected vs how many of those
   *  names landed in the final scene cast. `by_tier` is the citation stack
   *  (canon = a∧b∧c, hint = verbatim but not name-acting, hidden = (a) fail),
   *  not the mention-classifier ladder. */
  presence: {
    detected: number
    committed: number
    by_tier?: { canon: number; hint: number; hidden: number }
  }
  /** This turn carried a player correction/retcon (precision ground-truth). */
  playerCorrected: boolean
  /** Count of projection-anomaly "miss" findings this turn (recall ground-truth). */
  missCandidates: number
}

export interface SignalLedgerEntry {
  player_corrected: boolean
  miss_candidates: number
  signals: Partial<Record<LedgerSignalType, SignalTally>>
}

function tierRollup(confidences: number[]): { canon: number; hint: number; hidden: number } {
  const out = { canon: 0, hint: 0, hidden: 0 }
  for (const c of confidences) out[confidenceTier(c)]++
  return out
}

function singleTally(s: SingleSignal): SignalTally {
  return {
    detected: s.detected ? 1 : 0,
    committed: s.committed ? 1 : 0,
    ...(s.committed && s.source ? { source: s.source } : {}),
    ...(s.committed && typeof s.confidence === 'number' ? { confidence: s.confidence } : {}),
  }
}

/** Build the per-turn ledger entry from a turn's already-decided signal facts. */
export function buildSignalLedger(input: SignalLedgerInput): SignalLedgerEntry {
  const signals: Partial<Record<LedgerSignalType, SignalTally>> = {
    // Hard-committed, non-tiered facts — record provenance, not a tier.
    movement: singleTally(input.movement),
    time: singleTally(input.time),
    // Tiered signals — committed count + the tier mix of what committed.
    party: {
      detected: Math.max(0, input.party.detected),
      committed: input.party.committedConfidences.length,
      ...(input.party.committedConfidences.length
        ? { by_tier: tierRollup(input.party.committedConfidences) }
        : {}),
    },
    kinship: {
      detected: Math.max(0, input.kinship.detected),
      committed: Math.max(0, input.kinship.committed),
      ...(input.kinship.committedConfidences?.length
        ? { by_tier: tierRollup(input.kinship.committedConfidences) }
        : {}),
    },
    // Presence arbitration: citations the endpoint judge emitted vs names from
    // those citations that actually landed in the scene cast. by_tier is the
    // (a)/(b)/(c) stack, not the mention-classifier ladder.
    presence: {
      detected: Math.max(0, input.presence.detected),
      committed: Math.max(0, input.presence.committed),
      ...(input.presence.by_tier ? { by_tier: input.presence.by_tier } : {}),
    },
  }

  return {
    player_corrected: input.playerCorrected,
    miss_candidates: Math.max(0, input.missCandidates),
    signals,
  }
}
