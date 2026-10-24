import { mongoColl } from '../../config/mongo'
import { log } from '../../utils/logger'
import { categoryForClass } from './classify'
import type { AppErrorClass, ErrorGroupStatus } from './types'

/**
 * §4.5 / §4.5a — one row per error identity, counted, never one per event.
 *
 * A group is the thing the owner reads, so it is created once and then only
 * counted: the first sample's message becomes the title and never changes, the
 * class and plain category come from code, and every later sample contributes a
 * count, a last-seen and a per-version tally.
 *
 * The one transition that lives here is regression, because it belongs with the
 * counting: a group the admin resolved is dead until an error of the same
 * identity turns up on a *newer* version, at which point the "fix" did not hold
 * and the group comes back as `regressed` rather than silently counting under a
 * status that says it is gone.
 */

/** Mongo field names may not contain dots, so `1.0.11` is stored as `1_0_11`. */
export function versionKey(version: string): string {
  return version.replace(/\./g, '_')
}

/** Numeric, part by part — `1.0.10` is newer than `1.0.9`, which strings disagree about. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number(part) || 0)
  const right = b.split('.').map((part) => Number(part) || 0)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0
    const y = right[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** `{ "1_0_11": 3 }` → `[{ version: "1.0.11", count: 3 }]`, newest first (§4.6a). */
export function versionEntries(versions?: Record<string, number>): Array<{ version: string; count: number }> {
  return Object.entries(versions ?? {})
    .map(([key, count]) => ({ version: key.replace(/_/g, '.'), count }))
    .sort((left, right) => compareVersions(right.version, left.version))
}

export type ErrorGroupSample = {
  fingerprint: string
  cls: AppErrorClass
  type: string
  /** Scrubbed message of this sample; only used when the group is created. */
  title: string
  topFrame?: string
  at: Date
  appVersion: string
}

export type ErrorGroupUpsert = {
  fingerprint: string
  /** True when this sample created the group. The triage job hooks onto this. */
  created: boolean
}

export async function upsertErrorGroup(sample: ErrorGroupSample): Promise<ErrorGroupUpsert> {
  const groups = mongoColl.appErrorGroups()

  const result = await groups.updateOne(
    { _id: sample.fingerprint },
    {
      $setOnInsert: {
        class: sample.cls,
        category: categoryForClass(sample.cls),
        type: sample.type,
        title: sample.title,
        status: 'new' satisfies ErrorGroupStatus,
        first_seen: sample.at,
        ...(sample.topFrame ? { top_frame: sample.topFrame } : {}),
      },
      $max: { last_seen: sample.at },
      $inc: { count: 1, [`versions.${versionKey(sample.appVersion)}`]: 1 },
    },
    { upsert: true },
  )

  const created = result.upsertedCount === 1
  if (!created) await markRegressed(sample.fingerprint, sample.appVersion)
  return { fingerprint: sample.fingerprint, created }
}

/**
 * `resolved` means the admin saw the fix land in `resolved_in_version`. The
 * comparison is done in JS because Mongo cannot compare dotted versions, and the
 * write is guarded on the status it read so a concurrent resolve is not undone.
 */
async function markRegressed(fingerprint: string, appVersion: string): Promise<void> {
  const groups = mongoColl.appErrorGroups()
  const current = await groups.findOne(
    { _id: fingerprint },
    { projection: { status: 1, resolved_in_version: 1 } },
  )
  if (!current || current.status !== 'resolved' || !current.resolved_in_version) return
  if (compareVersions(appVersion, current.resolved_in_version) <= 0) return

  try {
    await groups.updateOne(
      { _id: fingerprint, status: 'resolved' },
      { $set: { status: 'regressed' } },
    )
  } catch (error) {
    // A group that failed to flip is still counting; losing the flip is better
    // than losing the sample that caused it.
    log.error('telemetry: group regression flip failed', {
      fingerprint,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
