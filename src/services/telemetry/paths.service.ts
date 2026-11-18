import { mongoColl } from '../../config/mongo'
import type { ReviewersMode } from '../reviewer-accounts'
import { insightDays, sessionScope, windowStart } from '../admin-insights'

/**
 * `GET /admin/analytics/paths` (`everlore-docs/phases/admin-insights.md`,
 * "Contract, part 2").
 *
 * The common ways a session begins and ends, from the stored `screen_path`:
 *
 *  - `starts` is the first four screens, and only a session with **fewer than
 *    100 steps** can contribute — `screen_path` keeps its last 100, so a longer
 *    session's beginning is gone and a path read from it would be a lie.
 *  - `exits` is the last three screens before the session ended, which any
 *    session has: the tail is exactly what is kept.
 *
 * Consecutive repeats of a screen collapse to one, so a tab tapped twice is one
 * step. A session with a single screen is a path of one.
 *
 * The read is one windowed pass over `app_sessions` by `last_at`, narrowed by the
 * optional `app_version` and by the reviewer scope the funnel uses (account and
 * install), and nothing else is read.
 */

const MAX_STEPS = 100
const START_DEPTH = 4
const EXIT_DEPTH = 3
const TOP_PATHS = 15

/** Collapse runs of the same screen; `['a','a','b']` is `['a','b']`. */
export function collapseRepeats(steps: string[]): string[] {
  return steps.filter((step, index) => step !== steps[index - 1])
}

/** The path a session started on, or null when its start is no longer stored. */
export function startSteps(path: string[]): string[] | null {
  if (path.length >= MAX_STEPS) return null
  const collapsed = collapseRepeats(path)
  return collapsed.length === 0 ? null : collapsed.slice(0, START_DEPTH)
}

/** The path a session ended on, or null when it recorded no screen. */
export function exitSteps(path: string[]): string[] | null {
  const collapsed = collapseRepeats(path)
  return collapsed.length === 0 ? null : collapsed.slice(-EXIT_DEPTH)
}

function tally(paths: Array<string[] | null>): Array<{ steps: string[]; sessions: number }> {
  const counts = new Map<string, { steps: string[]; sessions: number }>()
  for (const path of paths) {
    if (!path) continue
    const key = path.join('\u0000')
    const entry = counts.get(key) ?? { steps: path, sessions: 0 }
    entry.sessions++
    counts.set(key, entry)
  }
  return [...counts.values()]
    .sort((left, right) => right.sessions - left.sessions || left.steps.join('\n').localeCompare(right.steps.join('\n')))
    .slice(0, TOP_PATHS)
}

export const pathInsights = {
  async paths(
    daysValue?: string,
    appVersion?: string,
    mode: ReviewersMode = 'exclude',
    now = new Date(),
  ) {
    const days = insightDays(daysValue)
    const from = windowStart(days, now)
    const scope = await sessionScope(mode)

    const match: Record<string, unknown> = { last_at: { $gte: from, $lte: now } }
    if (appVersion) match.app_version = appVersion
    const filter = scope.length > 0 ? { $and: [match, ...scope] } : match

    const rows = await mongoColl.appSessions()
      .find(filter, { projection: { screen_path: 1 } })
      .toArray()

    const starts: Array<string[] | null> = []
    const exits: Array<string[] | null> = []
    for (const row of rows) {
      const path = (row.screen_path ?? []).map((step) => step.screen).filter((screen) => Boolean(screen))
      starts.push(startSteps(path))
      exits.push(exitSteps(path))
    }

    return {
      days,
      sessions: rows.length,
      starts: tally(starts),
      exits: tally(exits),
    }
  },
}
