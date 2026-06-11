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
checkUnit('I spend three days preparing.', 'day')
checkUnit('After a month of training, I feel ready.', 'month')
checkUnit('Over the next week I rebuild the wall.', 'week')
checkUnit('A few hours later, the storm breaks.', 'hour')
check('the next morning', detectNarratedTimeSkip('The next morning, I wake early.'), 'the next morning')
check('overnight', detectNarratedTimeSkip('I let it rest overnight.'), 'overnight')
check('tomorrow', detectNarratedTimeSkip('I will deal with it tomorrow.'), 'tomorrow')
checkUnit('Years later, the wound still aches.', 'year') // "years"+later → "years" (advanceDays → 365)

console.log('NON-SKIPS (expect null):')
for (const t of [
  'For years I have wanted to say this.',     // a feeling, not a skip
  'I train every day to get stronger.',       // habitual, not a single skip
  'I reach for my plate at the table.',
  'I have a few coins left in my pocket.',     // "few" but no time unit
  'Why are you so focused on your phone?',
  'I think about the long days ahead.',        // contemplation, no passage
  '',
]) check(t, detectNarratedTimeSkip(t), null)

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
