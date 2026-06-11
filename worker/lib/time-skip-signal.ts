/**
 * Deterministic time-skip backstop for the calendar seam — the time twin of
 * worker/lib/movement-signal.ts `detectNarratedMovement`.
 *
 * `extractSceneMetadata` reads only the AI NARRATIVE, so when the player writes
 * "Weeks pass." but the narrator's prose doesn't restate the skip, `time_elapsed`
 * comes back null and the calendar never advances — the time-analog of the
 * `viewpoint_moved` loss P2.6 fixed. The player's own input is the reliable signal;
 * this reads it deterministically and returns a label the calendar's `advanceDays`
 * already understands ("weeks", "three days", "the next morning"). Used only as a
 * fallback: a model-reported `time_elapsed` always wins.
 *
 * Conservative by design — a spurious skip mutates the story date, so it fires only
 * on an explicit duration in a PASSAGE context (so "for years I've wanted this", a
 * feeling not a skip, never matches) or a named next-period marker.
 */

function clean(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[*_~`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const UNIT = '(?:hour|day|night|week|fortnight|month|season|year|decade|century)s?'
const AMOUNT =
  '(?:\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple|few|several|many|countless)'
/** A duration phrase: up to two amount words then a unit ("a few days", "weeks"). */
const DURATION = `(?:${AMOUNT}\\s+){0,2}${UNIT}`

// 1. duration immediately followed by a passage verb: "weeks pass", "three days later".
const DURATION_PASSAGE = new RegExp(
  `\\b(${DURATION})\\s+(?:later|pass|passes|passed|go by|goes by|going by|went by|gone by|elapse|elapses|elapsed|slip by|slips by|slipped by|slip past|drift by|drifted by|drag on|dragged on|drag by|crawl by|crawled by|roll by|rolled by)\\b`,
)
// 2. spending/waiting an EXPLICIT amount of time: "I spend three days", "waited a week".
//    Requires an amount (not bare "spend weeks") to avoid habitual "train every day".
const SPEND_DURATION = new RegExp(
  `\\b(?:spend|spends|spent|wait|waits|waited|sleep|sleeps|slept|rest|rests|rested|train|trains|trained|labor|labour|laboured|toil|toiled)\\b(?:\\s+\\w+){0,4}?\\s+(${AMOUNT}\\s+${UNIT})\\b`,
)
// 3. an explicit forward range: "after three weeks", "over the next month".
const RANGE_DURATION = new RegExp(
  `\\b(?:after|over the next|over the coming|for the next|across the next|throughout the next|in the following|in the next)\\s+(${DURATION})\\b`,
)
// 4. named next-period markers (advanceDays maps these to ~1 day; "overnight" etc.).
const NAMED_PERIOD =
  /\b(?:the next morning|next morning|the following morning|the following day|the next day|by morning|by dawn|by daybreak|by nightfall|come morning|come dawn|overnight|tomorrow|the following week|the following month|the following year|the next week|the next month|the next year|weeks later|days later|months later|years later)\b/

/**
 * A time-skip label parsed from the player's narrated action, or null. The string
 * is meant to feed `advanceDays` (bare units, worded amounts, and "next morning"
 * are all understood there); hour/night-scale skips resolve to 0 calendar days but
 * still mark a scene break.
 */
export function detectNarratedTimeSkip(playerInput: string | null | undefined): string | null {
  const t = clean(playerInput || '')
  if (!t) return null
  const m =
    t.match(DURATION_PASSAGE) ||
    t.match(SPEND_DURATION) ||
    t.match(RANGE_DURATION)
  if (m) return m[1].trim()
  const named = t.match(NAMED_PERIOD)
  if (named) return named[0].trim()
  return null
}
