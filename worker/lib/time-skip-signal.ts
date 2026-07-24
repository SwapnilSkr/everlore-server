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
 * on an explicit duration in a passage context or a first-person deliberate span.
 * Relative/future markers such as "tomorrow" and "the next morning" are plans or
 * topics often enough that they deliberately do not advance the calendar.
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
//    Every verb here is an UNAMBIGUOUS passage idiom, and the leading ${DURATION}
//    (amount + time-unit) gate means it can only fire after a real span — "the weeks
//    flew by" matches, "birds fly by"/"I wear a coat" never do (no unit before them).
const DURATION_PASSAGE = new RegExp(
  `\\b(${DURATION})\\s+(?:later|pass|passes|passed|go by|goes by|going by|went by|gone by|elapse|elapses|elapsed|slip by|slips by|slipped by|slip past|drift by|drifted by|drag on|dragged on|drag by|crawl by|crawled by|roll by|rolled by|fly by|flies by|flew by|flying by|tick by|ticks by|ticked by|ticking by|wear on|wears on|wore on|wearing on|stretch on|stretches on|stretched on|stretching on)\\b`,
)
// 2. A present-tense, first-person deliberate wait/rest/training span. Past-tense
//    reflections ("I spent a year of my life...") are intentionally excluded: a
//    false calendar advance is worse than asking the player to make the passage
//    explicit. The trailing guards reject possessives and "of my life" backstory.
const SPEND_DURATION = new RegExp(
  `\\b(?:i|we)\\s+(?:wait|sleep|rest|train|labor|labour|toil|stay|remain|linger)(?:\\s+\\w+){0,4}?\\s+(${AMOUNT}\\s+${UNIT})(?!['’])(?!(?:\\s+of\\b))\\b`,
)

/**
 * A time-skip label parsed from the player's narrated action, or null. The string
 * is meant to feed `advanceDays` (bare units, worded amounts, and "next morning"
 * are all understood there); hour/night-scale skips resolve to 0 calendar days but
 * still mark a scene break.
 */
export function detectNarratedTimeSkip(playerInput: string | null | undefined): string | null {
  const t = clean(playerInput || '')
  if (!t) return null
  const m = t.match(DURATION_PASSAGE) || t.match(SPEND_DURATION)
  if (m) return m[1].trim()
  return null
}
