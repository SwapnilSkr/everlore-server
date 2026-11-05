import type { ObjectId } from 'mongodb'

/** The only kinds a bell row may carry (group-chat.md, "In-app notifications"). */
export type NotificationType = 'group_direct' | 'group_selfie' | 'film_ready'

/**
 * player_notifications — one row per thing that happened while the player was
 * elsewhere. Nothing from a chat's text is ever stored: `title` and `body` are
 * built in code from the contract's words and a character's name, and
 * `image_url` is a portrait or a film's cover. Optional keys are omitted, never
 * null (they share the `created_at`/`read_at` shapes other collections use).
 */
export interface PlayerNotificationDoc {
  _id: ObjectId
  player_id: ObjectId
  type: NotificationType
  instance_id: ObjectId
  /** The group member the row is about; absent on film rows. */
  character_id?: string
  title: string
  body: string
  image_url?: string
  created_at: Date
  read_at?: Date
}
