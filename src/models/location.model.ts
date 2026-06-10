import type { ObjectId } from 'mongodb'

/**
 * Current/end-of-turn place anchor. Location entities remain the canonical
 * registry; this denormalized label keeps prompts and product surfaces cheap.
 */
export interface LocationAnchorDoc {
  entity_id: ObjectId
  name: string
  name_normalized: string
}
