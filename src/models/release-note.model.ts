/**
 * "What's new" for one release (`everlore-docs/phases/update-nudge.md`, part 2,
 * section B).
 *
 * The owner writes the words from the console. `_id` is the build number, so a
 * note and the build it describes are the same key and there can only be one.
 * A published note is readable by every player; a draft is never served.
 */
export const RELEASE_NOTES_COLLECTION = 'release_notes'

export interface ReleaseNoteItem {
  /** ≤ 50 characters, the card's heading. */
  heading: string
  /** ≤ 180 characters. */
  body: string
  /** https, on `CDN_BASE_URL`'s host only; drawn at 16:9. */
  image_url?: string
}

export interface ReleaseNoteDoc {
  /** The build it describes. */
  _id: number
  /** '1.0.15', as the app shows it under the title. */
  version: string
  /** ≤ 60 characters, e.g. "Groups you can make yourself". */
  title: string
  /** ≤ 200 characters, one plain sentence. */
  intro?: string
  /** 1–6 items. */
  items: ReleaseNoteItem[]
  status: 'draft' | 'published'
  published_at?: Date
  /** Set when the publish also sent a push. */
  pushed_at?: Date
  created_at: Date
  updated_at: Date
}
