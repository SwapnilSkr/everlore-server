import type { ObjectId } from 'mongodb'

export interface SceneEventRangeDoc {
  start_sequence: number
  end_sequence: number
}

/**
 * scene_summaries — compressed scene paragraphs tied to event ranges.
 */
export interface SceneSummaryDoc {
  _id: ObjectId
  instance_id: ObjectId
  scene_tag: string
  event_range: SceneEventRangeDoc
  summary_text: string
  key_facts_extracted: unknown[]
  model_used: string
  tokens_consumed: number
  /** Projection provenance: 'stale' when a source event inside event_range was
   *  edited/replayed after this summary was generated. Stale summaries are
   *  excluded from prompts and rebuilt by the summary queue. Missing = active. */
  status?: 'active' | 'stale'
  created_at: Date
}
