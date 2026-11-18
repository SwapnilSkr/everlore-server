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

/** The three reminder rounds a live build gets (part 2, section A). */
export type AppUpdateRound = 1 | 2 | 3

/**
 * One push for one round of one build. A `(build, round)` pair is sent at most
 * once; round 1 is also what the owner's manual "Tell players" sends.
 */
export interface AppReleaseAnnouncement {
  build: number
  /** 1 = `live_at` + 1 h, 2 = + 3 d, 3 = + 7 d. */
  round: AppUpdateRound
  at: Date
  /** The admin who pressed, or `automatic` for the hourly job. */
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
  /**
   * When `latest_build` last changed — saving a new build is the owner saying
   * "this is live on Play". Never rewritten while the build stays the same, so
   * the rounds below are measured from one fixed moment.
   */
  live_at?: Date
  /** The console switch "Remind players who haven't updated". Absent means on. */
  auto_reminders?: boolean
  updated_at: Date
  announced: AppReleaseAnnouncement[]
}
