/**
 * The Android release the server believes is live (`everlore-docs/phases/update-nudge.md`).
 *
 * Google Play decides whether an update is actually available to a device; this
 * document only carries what the app and the console need — the build that is
 * live, the floor below which the app stops, and the owner's own words for
 * "what's new". There is exactly one, at `_id: 'android'`.
 *
 * No document means no nudge at all: the app reads zero for both builds.
 */
export const APP_RELEASE_COLLECTION = 'app_release'

/** One push the owner sent for a build. A build is announced at most once. */
export interface AppReleaseAnnouncement {
  build: number
  at: Date
  by: string
  /** Push devices the announcement went to, including the ones held for the morning. */
  devices: number
}

export interface AppReleaseDoc {
  _id: 'android'
  /** The `versionCode` now live on Play production — compared, never the version string. */
  latest_build: number
  /** Shown in the console and in copy, e.g. `1.0.14`. */
  latest_version: string
  /** Below this the app is blocked until it updates; 0 means no floor. */
  min_build: number
  /** Up to three player-facing lines, each at most 90 characters. */
  notes: string[]
  updated_at: Date
  announced: AppReleaseAnnouncement[]
}
