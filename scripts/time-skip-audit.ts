/**
 * Pure-function audit for the deterministic time-skip backstop
 * (worker/lib/time-skip-signal.ts). No DB. Run: bun run audit:time-skip
 * The returned label is fed to time.service `advanceDays`; we assert detection +
 * (for a few) that the label carries the expected unit.
 */
import { detectNarratedTimeSkip } from '../worker/lib/time-skip-signal'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else { fail++; console.log(`  FAIL ${label}\n       got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}
function checkUnit(input: string, unit: string) {
  const got = detectNarratedTimeSkip(input)
  const ok = typeof got === 'string' && new RegExp(`\\b${unit}s?\\b`, 'i').test(got)
  if (ok) pass++
  else { fail++; console.log(`  FAIL "${input}" → expected a label containing "${unit}", got ${JSON.stringify(got)}`) }
}

console.log('SKIPS (expect a non-null label):')
checkUnit('*Weeks pass. I spend them in the garden.*', 'week')
checkUnit('Three days later, I return to the hall.', 'day')
checkUnit('I wait three days preparing.', 'day')
checkUnit('A few hours later, the storm breaks.', 'hour')
checkUnit('Years later, the wound still aches.', 'year') // "years"+later → "years" (advanceDays → 365)
// enrichment (June 26): more unambiguous passage idioms (gated by a leading span)
checkUnit('The weeks flew by in a blur.', 'week')
checkUnit('The days wore on as we marched.', 'day')
checkUnit('Hours ticked by in the cell.', 'hour')
checkUnit('The long months stretched on.', 'month')
// symmetric named-period markers + bare "hours later"
checkUnit('Hours later, I woke in the dark.', 'hour') // caught as an hour-scale span
// first-person deliberate spans only (gated by amount+unit)
checkUnit('I stay three days at the inn.', 'day')
checkUnit('I remain in the city for a month.', 'month')
checkUnit('We linger two weeks in the valley.', 'week')

console.log('NON-SKIPS (expect null):')
for (const t of [
  'For years I have wanted to say this.',     // a feeling, not a skip
  'I train every day to get stronger.',       // habitual, not a single skip
  'I reach for my plate at the table.',
  'I have a few coins left in my pocket.',     // "few" but no time unit
  'Why are you so focused on your phone?',
  'I think about the long days ahead.',        // contemplation, no passage
  // new passage verbs must NOT fire without a leading time-unit (no false positives)
  'Birds fly by the window as I watch.',       // "fly by" but no duration
  'I wear on a heavy cloak against the cold.', // "wear on" but no duration
  'I stretch on the cold stone floor.',        // "stretch on" but no duration
  'The clock ticks by on the wall.',           // "ticks by" but "clock" is no unit
  'I stay calm and remain at the table.',      // stay/remain but no amount+unit
  'I linger by the window for a while.',        // "a while" is no time unit
  // homograph FPs fixed this pass (must NOT advance the calendar)
  'I worry about tomorrow constantly.',         // "about tomorrow" = a concept
  'Tomorrow is another problem.',               // a topic, not a skip
  'By dawn, I will decide.',                    // a future plan, not elapsed time
  'The next morning is too soon.',              // a future reference, not a skip
  'I live like there is no tomorrow.',          // "no tomorrow" = idiom
  'It was an overnight success to celebrate.',  // "overnight" = adjective
  'I pack an overnight bag for the trip.',      // "overnight bag" = adjective
  "I spend three days' wages on it.",           // "days' wages" = money, not a span
  'I spent a year of my life fearing this.',     // backstory, not current passage
  '',
]) check(t, detectNarratedTimeSkip(t), null)

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
