/**
 * Character lifecycle — the one extractor whose write cannot be undone.
 *
 * `applyLifecycleDeltas` sets `life_state: 'deceased'` and only an explicit
 * resurrection may clear it. A dead card is dropped from the context packet
 * entirely, so the person stops being a KNOWN character: they can no longer be
 * admitted to a scene, they vanish from Bonds, and every later turn treats them
 * as an unknown walk-on. Being wrong here is permanent and total.
 *
 * Every case below is a real live turn. All three killed a character who was
 * alive and speaking, and one of them buried a man on a sentence about a
 * different person entirely.
 */
import { verifyDeathCitation } from '../worker/lib/character-lifecycle-extractor'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else {
    fail++
    console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`)
  }
}

console.log('the excerpt must name the person it buries:')
check(
  'a pronoun about a PILING does not kill the harbourmaster',
  verifyDeathCitation({
    name: 'Ollen',
    aliases: ['Harbourmaster'],
    evidence: 'The mud took it last full moon.',
    prose: 'Wick looked at the gap in the pilings. The mud took it last full moon.',
  }),
  false,
)
check(
  'a sentence about ANOTHER character does not kill this one',
  verifyDeathCitation({
    name: 'Marn',
    aliases: ['mudlark'],
    evidence: "The Harbourmaster's gone, remember?",
    prose: 'The mudlark shrugged. "The Harbourmaster\'s gone, remember?"',
  }),
  false,
)

console.log('\na death asserted only in dialogue is a claim, not a fact:')
check(
  'a floor manager who walked upstairs is not dead',
  verifyDeathCitation({
    name: 'Deshi',
    aliases: ['Deshi'],
    evidence: "Deshi's gone back up.",
    prose: 'Marn glanced at the stair. "Deshi\'s gone back up."',
  }),
  false,
)
check(
  'a character claiming a death in dialogue does not establish it',
  verifyDeathCitation({
    name: 'Ollen',
    aliases: [],
    evidence: 'Ollen is dead.',
    prose: 'Marn spat into the water. "Ollen is dead. Has been for a week."',
  }),
  false,
)

console.log('\nthe death must be predicated of the person, not of the furniture:')
check(
  'a steward left alone by a DEAD HEARTH is not dead',
  verifyDeathCitation({
    name: 'Tomas',
    aliases: ['the steward'],
    evidence: "The sound of Kael's footsteps fades down the stone stairwell, leaving the steward alone by the dead hearth.",
    prose: "The sound of Kael's footsteps fades down the stone stairwell, leaving the steward alone by the dead hearth.",
  }),
  false,
)
check(
  'a mortician is not a corpse',
  verifyDeathCitation({
    name: 'Rhea',
    aliases: [],
    evidence: "Rhea's busy with the dead.",
    prose: "He shrugged. \"Rhea's busy with the dead.\"",
  }),
  false,
)
check(
  'a ledger that will not matter does not kill its owner',
  verifyDeathCitation({
    name: 'Bram',
    aliases: [],
    evidence: "Bram's numbers won't matter.",
    prose: "\"Midnight,\" he said. \"Bram's numbers won't matter.\"",
  }),
  false,
)

console.log('\nwhat a real narrated death still looks like:')
check(
  'the narrator killing a named character passes',
  verifyDeathCitation({
    name: 'Ollen',
    aliases: ['Harbourmaster'],
    evidence: 'Ollen died before the tide turned',
    prose: 'Ollen died before the tide turned, and no one came to move him.',
  }),
  true,
)
check(
  'an alias in the narration is enough',
  verifyDeathCitation({
    name: 'Ollen',
    aliases: ['Harbourmaster'],
    evidence: 'The Harbourmaster was dead when they found him',
    prose: 'The Harbourmaster was dead when they found him, still holding the seal.',
  }),
  true,
)
check(
  'a span straddling a quote and its narration still counts',
  verifyDeathCitation({
    name: 'Tomas',
    aliases: [],
    evidence: 'Tomas was already cold',
    prose: '"Too late," she said. Tomas was already cold by the time they reached the hearth.',
  }),
  true,
)

// A death is narrated by naming the person ONCE and then pronouncing them, so
// the sentence that names them is rarely the one the excerpt opens on. Testing
// the excerpt whole anchored the subject-predicate check to its head and
// refused a beam-crushing death the model reported at confidence 1.0 — found
// live, on a turn written to be as unambiguous as a death can be.
check(
  'the naming sentence need not be the first one in the excerpt',
  verifyDeathCitation({
    name: 'Marn',
    aliases: ['mudlark'],
    evidence:
      'He didn\u2019t cry out; he just went still. Wick knelt in the settling dust, his hands already slick with something warm and dark. Marn\u2019s sharp eyes were open, fixed on nothing.',
    prose:
      'It struck Marn squarely across the shoulders, driving him into the granary floor. He didn\u2019t cry out; he just went still. Wick knelt in the settling dust, his hands already slick with something warm and dark. Marn\u2019s sharp eyes were open, fixed on nothing.',
  }),
  true,
)
// …and widening the excerpt must not widen what qualifies: the name and the
// predicate have to land in the SAME sentence, or "Marn stood by the door"
// beside any dying thing at all would bury him.
check(
  'a paragraph of pronouns that never names them is still refused',
  verifyDeathCitation({
    name: 'Marn',
    aliases: [],
    evidence: 'He didn\u2019t cry out; he just went still. The dust settled over him.',
    prose: 'He didn\u2019t cry out; he just went still. The dust settled over him.',
  }),
  false,
)

// Asked for a contiguous span, the model returns the death's sentences with the
// scene-setting between them dropped — real sentences joined by a seam that was
// never in the prose. Requiring the whole excerpt to be verbatim recorded ZERO
// of two unambiguous live deaths. Per sentence, the fabricated join is the only
// thing discarded.
check(
  'a stitched excerpt still counts through the sentences that are real',
  verifyDeathCitation({
    name: 'Deshi',
    aliases: [],
    evidence:
      'Deshi\u2019s footing was already gone. The surface closed over him without a ripple. Deshi did not come up.',
    prose:
      'Wick turned toward him, but Deshi\u2019s footing was already gone. He didn\u2019t shout. The surface closed over him without a ripple. Wick stood alone on the stair. Deshi did not come up.',
  }),
  true,
)
// …but a sentence the narrator never wrote cannot bury anyone, however real the
// rest of the excerpt is.
check(
  'a fabricated sentence in the excerpt buries nobody on its own',
  verifyDeathCitation({
    name: 'Ollen',
    aliases: [],
    evidence: 'The tide was out. Ollen was dead by morning.',
    prose: 'The tide was out. Wick counted the seals alone.',
  }),
  false,
)

// Asked for one sentence, the model returns a clause with a period stuck on the
// end. The span must still be the narrator's own words.
check(
  'a trailing period the model added does not break the excerpt',
  verifyDeathCitation({
    name: 'Marn',
    aliases: [],
    evidence: 'Marn did not come up.',
    prose: 'Wick stood alone on the stair. Marn did not come up, and the tide went on ebbing.',
  }),
  true,
)
// Where the narrator only shows someone ELSE looking at the body, this abstains
// — the subject of "Bryn's body slumped against the crates" is the body, and
// Maker is the one doing the seeing. Reaching that death would mean teaching the
// predicate check which nouns are parts of a person, which is the content-list
// judgement this whole stack exists to avoid, and it is the same reach that let
// a DEAD HEARTH bury a living steward. The codex still carries the death in
// prose; the ledger abstains. Deaths cannot be undone by a later turn, so the
// ledger's default is to say nothing.
check(
  'a body observed by someone else is not a citation',
  verifyDeathCitation({
    name: 'Bryn',
    aliases: [],
    evidence: 'Bryn\u2019s body slumped against the crates.',
    prose: 'Maker froze, his eyes locked on Bryn\u2019s body slumped against the crates.',
  }),
  false,
)
check(
  'trimming punctuation does not let a rewritten span through',
  verifyDeathCitation({
    name: 'Bryn',
    aliases: [],
    evidence: 'Bryn\u2019s body lay against the crates.',
    prose: 'Maker froze, his eyes locked on Bryn\u2019s body slumped against the crates.',
  }),
  false,
)

console.log(`\ncharacter lifecycle audit: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
