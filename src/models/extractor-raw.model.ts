import type { ObjectId } from 'mongodb'

/**
 * extractor_raw — fire-and-forget capture of the post-stream extractors' raw
 * JSON, plus the advisory citation-check verdicts. Off the request path; the
 * corpus cannot measure (b)/(c) without it.
 */
export type ExtractorStage =
  | 'scene_witness'
  | 'choice_metadata'
  | 'entity_adjudication'
  | 'character_deaths'
  | 'scene_endpoint'
  | 'player_interaction'

export type CitationCheck = 'a' | 'b' | 'c'

export interface ExtractorCitationVerdict {
  name: string
  evidence: string
  a: boolean
  b: boolean
  c: boolean
  rejected: CitationCheck[]
}

export interface ExtractorRawDoc {
  _id: ObjectId
  instance_id: ObjectId
  player_id: ObjectId
  event_id: ObjectId | null
  sequence: number
  stages: Partial<Record<ExtractorStage, string>>
  citation_verdicts?: ExtractorCitationVerdict[]
  created_at: Date
}
