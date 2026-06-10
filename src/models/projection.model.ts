import type { ObjectId } from 'mongodb'
import type { MemoryDoc } from './memory.model'

/**
 * Shared lifecycle vocabulary for every projection derived from the event
 * ledger (memories, scene summaries, entity edges, codex deltas). The ledger
 * is canonical; projections carry provenance + status so edits/replays/rewinds
 * can invalidate exactly what a removed or rewritten event produced.
 *
 *  - active      — current, retrievable, trusted.
 *  - stale       — a source event changed; awaiting rebuild (excluded from prompts).
 *  - superseded  — a later fact replaced this one (kept for provenance).
 *  - archived    — decayed/merged out of retrieval (kept for provenance).
 */
export type ProjectionStatus = 'active' | 'stale' | 'superseded' | 'archived'

/** The provenance fields every derived projection is expected to carry. */
export interface ProjectionProvenance {
  source_event_ids?: ObjectId[]
  status?: ProjectionStatus
}

/**
 * Effective status for a memory row. Pre-status rows only carry `is_archived`,
 * so the boolean stays authoritative when `status` is absent; rows written
 * since the projection-status unification carry both.
 */
export function memoryProjectionStatus(
  m: Pick<MemoryDoc, 'is_archived'> & { status?: ProjectionStatus },
): ProjectionStatus {
  if (m.status) return m.status
  return m.is_archived ? 'archived' : 'active'
}
