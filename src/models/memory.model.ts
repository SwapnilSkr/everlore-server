import type { ObjectId } from 'mongodb'

/**
 * memories — curated long-term facts with optional Pinecone vector id.
 */
export interface MemoryDoc {
  _id: ObjectId
  instance_id: ObjectId
  player_id: ObjectId
  text: string
  type: string
  importance: number
  is_nsfw: boolean
  source_event_ids: ObjectId[]
  pinecone_id: string | null
  access_count: number
  last_accessed_at: Date
  is_archived: boolean
  created_at: Date
  updated_at: Date
}
