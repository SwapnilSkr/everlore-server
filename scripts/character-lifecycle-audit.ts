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

console.log(`\ncharacter lifecycle audit: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
