/**
 * The authored opening's place, and what it is allowed to establish.
 *
 * The extraction is a model call; this pins the VERIFICATION, which is the half
 * that decides. Two rules, and they are the same two the rest of the branch
 * uses: the name must be the author's own words, and it must be a room.
 *
 *   bun run audit:opening-place
 */
import { verifyOpeningPlace } from '../src/services/opening-place.service'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`)
  }
}
const accepted = (claimed: string, opening: string) => verifyOpeningPlace(claimed, opening).place?.name ?? null
const reason = (claimed: string, opening: string) => verifyOpeningPlace(claimed, opening).reason

console.log('\nthe place the author wrote:')
check(
  'the room the opening establishes',
  accepted('Counting House', 'The Counting House smelled of wet rope and tallow.'),
  'Counting House',
)
// The name is taken from the LINE, not from the model's transcription of it,
// so a model that lowercases what it copies still yields the author's casing.
check(
  'a lowercase claim comes back in the author\u2019s own casing',
  accepted('counting house', 'The Counting House smelled of wet rope and tallow.'),
  'Counting House',
)
check(
  'a multi-word name',
  accepted('the Long Pier', 'Rain came sideways across the Long Pier, and nobody had come to meet her.'),
  'the Long Pier',
)

console.log('\nit must be the author’s own words:')
// The whole reason to read the opening is that it is authored canon. A name the
// author did not write is the model's invention, which is the thing the witness
// already does and the thing this exists to pre-empt.
check(
  'a plausible name the line never contains is refused',
  accepted('Harbourmaster office', 'Ollen turned his head from the window, his expression flat.'),
  null,
)
check('…and says why', reason('Harbourmaster office', 'Ollen turned his head from the window.'), 'not_verbatim')
check(
  'a paraphrase of a place that IS there is still refused',
  accepted('the counting room', 'The Counting House smelled of wet rope and tallow.'),
  null,
)

console.log('\nit must be a room, not part of one:')
check('furniture', accepted('the table', 'The table was already laid when she came down.'), null)
check('a pronoun', accepted('here', 'It was colder here than she had been promised.'), null)
// The narrowest useful rule refuses a genuinely authored lowercase place too.
// That loses an improvement; it cannot cause a wrong one, because the world
// then opens exactly as it does today.
check(
  'a lowercase authored place is refused rather than guessed at',
  accepted('the tide-stair', 'Weed slicked the tide-stair, and the water was already climbing.'),
  null,
)
check(
  'a whole sentence returned as a name',
  accepted(
    'The Counting House smelled of wet rope',
    'The Counting House smelled of wet rope and tallow.',
  ),
  null,
)

console.log('\nnothing is not a failure:')
// An opening that names no place must open the world exactly as it does today.
check('an empty claim', accepted('', 'Somewhere, a bell was ringing.'), null)
check('a null-ish claim', accepted('null', 'Somewhere, a bell was ringing.'), null)
check('an empty opening line', accepted('Counting House', ''), null)
check('and the reason is legible', reason('', 'Somewhere, a bell was ringing.'), 'no_claim')

console.log('\nwhat it establishes is PROVISIONAL:')
// An authored opening says where the player IS. It does not say the world has a
// map yet — the place earns the atlas by being entered, left and entered again,
// exactly like every other place.
check(
  'the anchor is never minted',
  verifyOpeningPlace('Counting House', 'The Counting House smelled of wet rope and tallow.').place?.entity_id,
  null,
)
check(
  'and it carries a normalised key for the cursor to compare against',
  verifyOpeningPlace('Counting House', 'The Counting House smelled of wet rope and tallow.').place
    ?.name_normalized,
  'counting house',
)

console.log(`\nopening place audit: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
