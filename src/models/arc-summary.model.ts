import type { ObjectId } from 'mongodb'
import type { ProjectionStatus } from './projection.model'
import type { SceneEventRangeDoc } from './scene-summary.model'

/**
 * arc_summaries — the tier above chapters (Phase 9). An arc rolls up a fixed
 * block of consecutive chapters, but unlike the lower tiers it is framed around
 * the story's PLOT and RELATIONSHIP through-lines (how bonds evolved, which
 * threads opened/paid off across the span) rather than a chronological recap.
 * Like the lower tiers it is a rebuildable projection keyed by event range with
 * provenance (the child chapter ids) and the same stale/rebuild lifecycle.
 */
export interface ArcSummaryDoc {
  _id: ObjectId
  instance_id: ObjectId
  /** 1-based ordinal within the instance. */
  arc_index: number
  /** Union of the child chapters' event ranges. */
  event_range: SceneEventRangeDoc
  /** Provenance: the chapter summaries this arc compressed. */
  chapter_summary_ids: ObjectId[]
  summary_text: string
  model_used: string
  tokens_consumed: number
  /** Pinecone vector id (namespace `sum_<instanceId>`, `arc_<start>_<end>`). */
  pinecone_id?: string | null
  status?: ProjectionStatus
  created_at: Date
}
