import type { ObjectId } from 'mongodb'

/** The only kinds a bell row may carry (group-chat.md, "In-app notifications"). */
export type NotificationType = 'group_direct' | 'group_selfie' | 'film_ready' | 'story_reply'

/** Which place in a group save a row opens. Absent outside group saves. */
export type NotificationThread = 'room' | 'direct'

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
  /** The group member the row is about; absent on film and story rows. */
  character_id?: string
  /** The event this row is about. Internal: never sent to the player. A rewind
   *  deletes the rows for the turns it removes by this key. */
  event_id?: ObjectId
  /** The film a `film_ready` row is about, so a tap opens that film. */
  media_id?: string
  /** Where a tap goes inside a group save (`group_direct`, `group_selfie`, and a
   *  group `story_reply`). Omitted on everything else. */
  thread?: NotificationThread
  title: string
  body: string
  image_url?: string
  created_at: Date
  read_at?: Date
}
