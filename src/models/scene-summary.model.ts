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
  created_at: Date
}
