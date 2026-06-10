import type { ObjectId } from 'mongodb'
import type { ProjectionStatus } from './projection.model'
import type { SceneEventRangeDoc } from './scene-summary.model'

/**
 * chapter_summaries — the tier above scene summaries (Phase 9). A chapter rolls
 * up a fixed block of consecutive scene summaries into one higher-level
 * paragraph, so the prompt/recap can lean on a handful of chapters instead of
 * dozens of scenes as a playthrough grows. Like scene summaries, a chapter is a
 * rebuildable projection keyed by its covered event range, carries provenance
 * (the child scene-summary ids), and goes `stale` when a covered scene changes.
 */
export interface ChapterSummaryDoc {
  _id: ObjectId
  instance_id: ObjectId
  /** 1-based ordinal within the instance. */
  chapter_index: number
  /** Union of the child scenes' event ranges. */
  event_range: SceneEventRangeDoc
  /** Provenance: the scene summaries this chapter compressed. */
  scene_summary_ids: ObjectId[]
  summary_text: string
  model_used: string
  tokens_consumed: number
  /** Pinecone vector id (namespace `sum_<instanceId>`, `chapter_<start>_<end>`). */
  pinecone_id?: string | null
  status?: ProjectionStatus
  created_at: Date
}
