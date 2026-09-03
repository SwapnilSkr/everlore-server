import type { ObjectId } from 'mongodb'

/**
 * Current/end-of-turn place anchor. Location entities remain the canonical
 * registry; this denormalized label keeps prompts and product surfaces cheap.
 */
export interface LocationAnchorDoc {
  /**
   * null for a PROVISIONAL anchor — a place the scene is using but the world has
   * not promoted to a map node yet (see worker/lib/place-promotion.ts). It names
   * the setting for the narrator and the cursor; nothing may treat it as a
   * durable place, and it never appears in `knownPlaces`.
   */
  entity_id: ObjectId | null
  name: string
  name_normalized: string
}
