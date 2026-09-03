/**
 * THE SAME SUGGESTION, OVER AND OVER.
 *
 * Over one live 83-turn save the choice half offered 323 suggestions, 242 of
 * them distinct, and "Challenge Isolde's authority" came up SIXTEEN times
 * across the scene it belonged to — long after the player had declined it. It
 * is not a stuck loop (only 5 of 82 consecutive turn-pairs shared two labels);
 * it is a generator with no memory of its own output re-deriving the same
 * obvious move from the same standing situation.
 *
 * Telling the model about it was tried and MEASURED: listing the labels as "do
 * not repeat these" made repetition worse over the same 20 turns (5 repeats
 * blind, 13 informed) — naming them anchors on them. So it is arithmetic here.
 *
 * Applied to that save's shipped choices: 81 repeats -> 26, worst 16x -> 4x,
 * with all 242 distinct labels retained.
 *
 *   bun run audit:choice-repetition
 */
import { dropRepeatedChoices } from '../worker/lib/metadata-extractor'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`) }
}
const c = (...labels: string[]) => labels.map((label) => ({ label }))
const labels = (out: { label?: string }[]) => out.map((x) => x.label)

console.log('\nwhat the player has already passed on:')
check(
  'a repeat is dropped',
  labels(dropRepeatedChoices(c('Challenge Isolde’s authority', 'Read the report aloud', 'Leave the chamber'), ['Challenge Isolde’s authority'])),
  ['Read the report aloud', 'Leave the chamber'],
)
check(
  'casing and punctuation drift do not smuggle it back',
  labels(dropRepeatedChoices(c('challenge isoldes authority!', 'Read the report aloud', 'Leave the chamber'), ['Challenge Isolde’s authority'])),
  ['Read the report aloud', 'Leave the chamber'],
)
check(
  'a duplicate within one turn’s own set goes too',
  labels(dropRepeatedChoices(c('Wait', 'Wait', 'Speak', 'Leave'), [])),
  ['Wait', 'Speak', 'Leave'],
)
check('nothing recent, nothing dropped', labels(dropRepeatedChoices(c('A', 'B'), [])), ['A', 'B'])

console.log('\nthe set may shrink, never disappear:')
// A turn where the model produced only repeats must still offer the player
// something. Two is the floor, and the restored options are the ones it ranked
// first, not an arbitrary pair.
check(
  'a floor of two holds when every option is a repeat',
  labels(dropRepeatedChoices(c('A', 'B', 'C'), ['A', 'B', 'C'])),
  ['A', 'B'],
)
check(
  'a single fresh option is topped up to two',
  labels(dropRepeatedChoices(c('A', 'B', 'Fresh'), ['A', 'B'])),
  ['Fresh', 'A'],
)
check('a set already at the floor is untouched', labels(dropRepeatedChoices(c('A', 'B'), ['A', 'B'])), ['A', 'B'])
check('an empty set stays empty', labels(dropRepeatedChoices([], ['A'])), [])

console.log('\nit never invents or reorders the survivors:')
check(
  'surviving order is preserved',
  labels(dropRepeatedChoices(c('A', 'Keep1', 'B', 'Keep2'), ['A', 'B'])),
  ['Keep1', 'Keep2'],
)
check(
  'a blank label is not treated as a repeat of another blank',
  labels(dropRepeatedChoices([{ label: '' }, { label: '' }], [])),
  ['', ''],
)

console.log(`\nchoice repetition audit: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
