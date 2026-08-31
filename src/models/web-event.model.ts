import type { ObjectId } from 'mongodb'

/**
 * One interaction on the marketing site.
 *
 * Deliberately anonymous. There is no account behind these, no cookie and no
 * address: a `session` is a random id the page keeps for one browser tab, which
 * is enough to say "the visitor who clicked step one also clicked step three"
 * and nothing at all about who they are. Rows expire on their own (see the TTL
 * index) because nobody needs to know what a stranger clicked six months ago.
 */
export type WebEventDoc = {
  _id: ObjectId
  /** One of WEB_EVENT_NAMES — anything else is dropped at the door. */
  name: string
  /** Path the event happened on, query and hash stripped. */
  path: string
  /** Random per-tab id. Not stable across tabs, sessions or devices. */
  session: string
  /** Referrer host only, never the full URL. */
  referrer?: string
  /** Campaign tag, when the visit carried one. */
  utm_source?: string
  /** A handful of short, non-identifying labels: which tier, which step. */
  props?: Record<string, string>
  created_at: Date
}
