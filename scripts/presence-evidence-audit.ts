/**
 * Phantom-presence + adjacency fixtures for the citation-scoped verifier.
 *
 * The identity half of `hasSceneParticipationGrammar` admits a dead or
 * long-absent person from a passing mention. Action-only rejects those.
 * The opening-cast seeder still needs the full gate because no judge reads
 * authored seed prose.
 *
 *   bun run audit:presence-evidence
 */
import { hasSceneParticipationGrammar } from '../worker/lib/presence-gap-detector'
import {
  evaluatePresenceCitation,
  citationAdmitsToPresent,
  mergePresenceCandidates,
  showsParticipationInPassage,
} from '../worker/lib/scene-endpoint-adjudicator'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else {
    fail++
    console.log(`  FAIL ${label}\n       got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
  }
}

const full = (name: string, prose: string) => hasSceneParticipationGrammar(name, prose)
const action = (name: string, prose: string) => hasSceneParticipationGrammar(name, prose, { evidence: 'action' })

console.log('phantom presence — identity patterns admit the absent; action-only does not:')
{
  const cases: Array<[string, string]> = [
    ['Rhea', 'The letter mentioned Captain Rhea, who had died at sea two winters before.'],
    ['Mara', 'He still kept the locket. Mara, my sister, had been gone for years.'],
    ['Mara', 'I never speak of my sister Mara any more, not since the burial.'],
  ]
  for (const [name, prose] of cases) {
    check(`full admits ${name}`, full(name, prose), true)
    check(`action-only rejects ${name}`, action(name, prose), false)
  }
}

console.log('subject-verb adjacency — one adverb defeats ACTION_VERBS; title-name rescues Isolde:')
check('Isolde glances (adjacent) is action', action('Isolde', 'Queen Isolde glances at you across the royal table.'), true)
check(
  'Isolde barely glances — full admits via title-name',
  full('Isolde', 'Queen Isolde barely glances at you across the royal table.'),
  true,
)
check(
  'Isolde barely glances — action-only fails (adverb)',
  action('Isolde', 'Queen Isolde barely glances at you across the royal table.'),
  false,
)
check('Bram finally said — action-only fails', action('Bram', 'Bram finally said nothing at all.'), false)
check('Bram finally said — full also fails (no identity rescue)', full('Bram', 'Bram finally said nothing at all.'), false)
check('Bram, still furious, said — action-only fails', action('Bram', 'Bram, still furious, said nothing.'), false)
check('Mara almost nodded — action-only fails', action('Mara', 'Mara almost nodded, then stopped.'), false)

console.log('citation stack — (a) fabrication, (b) name in excerpt, (c) action grammar, advisory:')
{
  const prose = 'Bram nodded and set his cup down. Later they spoke of Rhea.'
  const present = evaluatePresenceCitation({
    name: 'Bram',
    evidence: 'Bram nodded and set his cup down',
    prose,
  })
  check('present citation passes a+b+c', { a: present.a, b: present.b, c: present.c, rejected: present.rejected }, {
    a: true, b: true, c: true, rejected: [],
  })

  const fabricated = evaluatePresenceCitation({
    name: 'Bram',
    evidence: 'Bram drew his sword in the courtyard',
    prose,
  })
  check('fabricated excerpt fails a', fabricated.a, false)
  check('fabricated excerpt lists a', fabricated.rejected.includes('a'), true)

  const unnamed = evaluatePresenceCitation({
    name: 'Bram',
    evidence: 'they spoke of Rhea',
    prose,
  })
  check('excerpt that does not name Bram fails b', unnamed.b, false)

  const identityOnly = evaluatePresenceCitation({
    name: 'Rhea',
    evidence: 'they spoke of Rhea',
    prose,
  })
  check('named-but-not-acting fails c only', { a: identityOnly.a, b: identityOnly.b, c: identityOnly.c, rejected: identityOnly.rejected }, {
    a: true, b: true, c: false, rejected: ['c'],
  })
}

console.log('citation (c) structural — aux/adverb/participle pass; phantoms and remote mentions still fail:')
{
  const shape = (name: string, evidence: string) =>
    evaluatePresenceCitation({ name, evidence, prose: evidence })

  check(
    'Tomas hasn\'t moved — structural (c) passes (was live FN)',
    shape('Tomas', "Tomas hasn't moved from the center of the room").c,
    true,
  )
  check(
    'Tomas standing by — structural (c) passes (participle FN)',
    shape('Tomas', 'Tomas standing by the cold hearth, his silhouette stark against the grey stone.').c,
    true,
  )
  check(
    'Bram finally said — structural (c) passes (adverb FN)',
    shape('Bram', 'Bram finally said nothing at all.').c,
    true,
  )
  check(
    'Mara almost nodded — structural (c) passes',
    shape('Mara', 'Mara almost nodded, then stopped.').c,
    true,
  )
  check(
    'Queen Isolde barely glances — structural (c) passes without title-name identity',
    shape('Isolde', 'Queen Isolde barely glances at you across the royal table.').c,
    true,
  )
  check(
    'Aldric\'s jaw tightened — still passes via body-part possessive list',
    shape('Aldric', "Aldric's jaw tightened, the weary lines around his eyes deepening.").c,
    true,
  )
  check(
    'Tomas\'s weary gaze — one adjective between \'s and body-part (live FN seq 19)',
    shape('Tomas', "Tomas's weary gaze doesn't leave the cold hearth.").c,
    true,
  )
  check(
    "steward's low voice — one-modifier body-part, same class as weary gaze",
    shape('the steward', "The steward's low voice is barely more than a breath.").c,
    true,
  )
  check(
    "Bram's down there — distal locative is not endpoint presence",
    shape('Bram', "Bram's down there now, with his ledgers.").c,
    false,
  )
  check(
    'Soren\'s inside — locative copula, not Bram\'s numbers',
    shape('Soren', "Soren's inside. He's pouring something dark for the regulars.").c,
    true,
  )
  check(
    'Soren\'s behind the bar — locative preposition, same class as inside',
    shape('Soren', "Soren's behind the bar, wiping a glass with a slow, practiced motion.").c,
    true,
  )
  check(
    'curly apostrophe locative still passes (c)',
    shape('Soren', 'Soren’s behind the bar, wiping a glass with a slow, practiced motion.').c,
    true,
  )
  check(
    'Bram\'s numbers — remote mention still fails (c)',
    shape('Bram', "You'll want to see Bram's numbers next.").c,
    false,
  )
  check(
    'things Tomas didn\'t say — name is not the excerpt subject, fails (c)',
    shape('Tomas', "it's a presence, thick with weeks of waiting and the things Tomas didn't say outright.").c,
    false,
  )
  check(
    'Cedric, who stood — relative still fails (c); judge must quote a main clause',
    shape('Cedric', 'Cedric, who stood silent and pale by the window').c,
    false,
  )
  check(
    'dead Rhea relative — still fails (c)',
    shape('Rhea', 'Captain Rhea, who had died at sea two winters before.').c,
    false,
  )
  check(
    'Mara, my sister — identity appositive still fails (c)',
    shape('Mara', 'Mara, my sister, had been gone for years.').c,
    false,
  )
}

console.log('citation (a) — wrapping quotes and curly apostrophes are normalization, not fabrication:')
{
  const prose = "He stays by the cold hearth, a tired silhouette watching the back of Kael's head."
  const wrapped = evaluatePresenceCitation({
    name: 'Tomas',
    evidence: '"He stays by the cold hearth, a tired silhouette watching the back of Kael\'s head."',
    prose,
  })
  check('wrapping ASCII quotes still pass (a)', wrapped.a, true)

  const curly = evaluatePresenceCitation({
    name: 'Aldric',
    evidence: 'Aldric’s jaw tightened, the weary lines around his eyes deepening.',
    prose: "Aldric's jaw tightened, the weary lines around his eyes deepening.",
  })
  check('curly apostrophe in name-possessive still passes (a)', curly.a, true)
  check('curly apostrophe citation still names Aldric (b)', curly.b, true)

  const commaContinued = evaluatePresenceCitation({
    name: 'Tomas',
    evidence: "Tomas's eyes drift toward the far stone wall.",
    prose: "*Tomas's eyes drift toward the far stone wall, the one that faces the mist road.",
  })
  check('trailing period vs comma-continuation still passes (a) (live FN seq 20)', commaContinued.a, true)
}

console.log('paid-then-dropped classes the prompt now forbids (pronoun / first-person as a name):')
{
  const pronoun = evaluatePresenceCitation({
    name: 'Tomas',
    evidence: 'He placed it on the worn table between them.',
    prose: 'He placed it on the worn table between them.',
  })
  check('pronoun span fails (b) — model quoted the wrong sentence, not a verifier bug', pronoun.b, false)

  const firstPerson = evaluatePresenceCitation({
    name: 'Reese',
    evidence: 'I watch you settle on the other end of the stained couch',
    prose: 'I watch you settle on the other end of the stained couch',
  })
  check('first-person I is not Reese — (b) correctly fails; prompt must cite Reese by name', firstPerson.b, false)

  const wrongPersonPronoun = evaluatePresenceCitation({
    name: 'the steward',
    evidence: 'He stays perfectly still for another breath, then gives a low, flat exhale.',
    prose: 'Tomas’s eyes don’t leave the cold hearth. He stays perfectly still for another breath, then gives a low, flat exhale.',
  })
  check('pronoun span about Tomas does not name the steward — (a) pass, (b) fail', {
    a: wrongPersonPronoun.a,
    b: wrongPersonPronoun.b,
    c: wrongPersonPronoun.c,
  }, { a: true, b: false, c: false })

  const cityArticle = evaluatePresenceCitation({
    name: 'The City',
    evidence: 'The neon from the Split Lamp is a distant smear of color across the water now.',
    prose: 'The neon from the Split Lamp is a distant smear of color across the water now.',
  })
  check(
    'The City is not proven by the article in "The neon" — (b) must not treat "the" as a name surface',
    cityArticle.b,
    false,
  )
  const cityNamed = evaluatePresenceCitation({
    name: 'The City',
    evidence: 'the city feels it like a slow breath in the dark.',
    prose: 'the city feels it like a slow breath in the dark.',
  })
  check('The City still matches when the excerpt actually says city', cityNamed.b, true)
}

console.log('Phase 1 — present[] admits only (a)∧(b)∧(c); continuations carry prior + endpoint:')
{
  const kept = evaluatePresenceCitation({
    name: 'Tomas',
    evidence: "Tomas hasn't moved from the center of the room",
    prose: "Tomas hasn't moved from the center of the room",
  })
  check('Tomas hasn\'t moved admits to present[]', citationAdmitsToPresent(kept), true)

  const remote = evaluatePresenceCitation({
    name: 'Bram',
    evidence: "You'll want to see Bram's numbers next.",
    prose: "You'll want to see Bram's numbers next.",
  })
  check('Bram\'s numbers does not admit to present[]', citationAdmitsToPresent(remote), false)

  const pronoun = evaluatePresenceCitation({
    name: 'the steward',
    evidence: 'He stays perfectly still for another breath, then gives a low, flat exhale.',
    prose: 'He stays perfectly still for another breath, then gives a low, flat exhale.',
  })
  check('pronoun span does not admit to present[]', citationAdmitsToPresent(pronoun), false)

  // These return CANDIDATES — names the caller will look for evidence about, not
  // names it will admit. `deriveSceneState` refuses any newcomer the prose does
  // not show acting (`uncorroborated_arrival`), which is where the Isolde/Lyra
  // property is actually enforced and where `audit:scene-state` pins it. Keeping
  // the witness off the CANDIDATE list as well meant that when the judge named
  // nobody, nobody was even considered — and the player stood in a cellar with
  // Bram over his ledger while the room came back empty.
  check(
    'a continuation keeps the quiet prior cast and considers both namers',
    mergePresenceCandidates({
      sceneBroke: false,
      endpointAvailable: true,
      endpointPresent: ['Tomas'],
      priorPresent: ['Cedric'],
      witnessPresent: ['Isolde', 'Lyra'],
      partyNames: [],
    }),
    ['Cedric', 'Tomas', 'Isolde', 'Lyra'],
  )
  check(
    'a scene break drops the old room and considers both namers',
    mergePresenceCandidates({
      sceneBroke: true,
      endpointAvailable: true,
      endpointPresent: ['Mara'],
      priorPresent: ['Isolde', 'Lyra'],
      witnessPresent: ['Isolde'],
      partyNames: [],
    }),
    ['Mara', 'Isolde'],
  )
  check(
    'the endpoint judge is listed FIRST, so its verified name wins a collision',
    mergePresenceCandidates({
      sceneBroke: true,
      endpointAvailable: true,
      endpointPresent: ['Bram'],
      priorPresent: ['Tomas'],
      witnessPresent: ['Bram', 'Tomas'],
      partyNames: [],
    })[0],
    'Bram',
  )
  check(
    'judge outage falls back to witness on continuation',
    mergePresenceCandidates({
      sceneBroke: false,
      endpointAvailable: false,
      endpointPresent: [],
      priorPresent: ['Cedric'],
      witnessPresent: ['Isolde'],
      partyNames: [],
    }),
    ['Cedric', 'Isolde'],
  )
}

// ── WHOLE-PASSAGE CORROBORATION IS STRUCTURAL, NOT A VERB LIST ──────────────
// scene-state admission used to ask whether the name sat next to a listed verb
// anywhere in the passage. That admits every phantom the identity patterns were
// built from, and misses the aux/adverb/participle shapes the list cannot reach.
{
  const shows = (name: string, prose: string) => showsParticipationInPassage(name, prose)

  check('the dead are not corroborated by a mention',
    shows('Rhea', 'The letter mentioned Captain Rhea, who had died at sea two winters before.'), false)
  check('an appositive about someone long gone is not corroboration',
    shows('Mara', 'He still kept the locket. Mara, my sister, had been gone for years.'), false)
  check('a possessive kinship mention is not corroboration',
    shows('Mara', 'I never speak of my sister Mara any more, not since the burial.'), false)
  check('a remembered remark is not corroboration',
    shows('Bram', 'He thought again of the untouched rations Bram had noted.'), false)
  check('possessed property is not the person',
    shows('Bram', "You'll want to see Bram's numbers next."), false)

  check('an auxiliary between subject and verb still corroborates',
    shows('Tomas', "The fire had burned low. Tomas hasn't moved from the center of the room."), true)
  check('an adverb between subject and verb still corroborates',
    shows('Bram', 'Bram finally said nothing at all.'), true)
  check('a mid-clause interjection still corroborates',
    shows('Mara', 'Mara almost nodded, then stopped.'), true)
  check('a body-part possessive still corroborates',
    shows('Aldric', "Aldric's jaw tightened."), true)
  check('a locative copula still corroborates',
    shows('Soren', "Soren's inside. He's pouring something amber."), true)
  check('a title before the name still corroborates',
    shows('Isolde', 'Queen Isolde barely glances at you across the royal table.'), true)
  check('a name in a later sentence is found',
    shows('Tomas', 'The hall was cold and empty of talk. Tomas watched the exchange without a word.'), true)
}

console.log('\nreported speech is what somebody SAID, not what happened here:')
check(
  'a memory told in dialogue does not put its subject in the room',
  showsParticipationInPassage(
    'Jax',
    'I look back at you, the cigarette forgotten. "The last tour ended in a motel outside Boise. Jax drove the whole night while I stared at the ceiling of the van."',
  ) === false,
  true,
)
check(
  'the attribution around a quote still counts — it is narration',
  showsParticipationInPassage('Tomas', '"The road stays empty," Tomas repeats, his voice flat.'),
  true,
)
check(
  'narration outside any quote is untouched',
  showsParticipationInPassage('Tomas', "Tomas hasn't moved. He stands by the cold hearth."),
  true,
)
check(
  'an unbalanced quote cannot swallow the passage',
  showsParticipationInPassage('Tomas', 'Tomas sets the cup down. "You already know that'),
  true,
)

console.log('\na distal deictic is a report of position, not presence:')
const cite = (name: string, evidence: string) =>
  citationAdmitsToPresent(evaluatePresenceCitation({ name, evidence, prose: evidence }))
check('"Jax is out there" is a man somewhere else', cite('Jax', 'Jax is out there.') === false, true)
check('"Bram is down there" likewise', cite('Bram', 'Bram is down there with the ledgers.') === false, true)
check('"Tomas is still there" is the same spot, not a distal report',
  cite('Tomas', 'Tomas is still there, seated on the same bench.'), true)
check('an ordinary action is untouched', cite('Tomas', "Tomas hasn't moved from the hearth."), true)

console.log('\na relative clause is not a main clause:')
check('"the van where Jax is waiting" does not admit him',
  cite('Jax', 'It is the long way around to the van where Jax is waiting, engine off.') === false, true)
check('a TITLE in the same position still does', cite('Isolde', 'Queen Isolde barely glances at you across the table.'), true)

console.log('\na citation drawn from inside a quotation is reported speech:')
{
  const prose =
    '*The damp air swallowed his words.* "Just me," *Marn\'s voice came from the shadowed mouth of a low tunnel.* "Deshi send you down here to get your boots wet, or is this your own bright idea?"'
  check(
    'a name spoken by the person who IS here does not admit the person who is not',
    citationAdmitsToPresent(
      evaluatePresenceCitation({ name: 'Deshi', evidence: 'Deshi send you down here to get your boots wet', prose }),
    ),
    false,
  )
  check(
    'the speaker is still admitted by the attribution, which is narration',
    citationAdmitsToPresent(
      evaluatePresenceCitation({ name: 'Marn', evidence: "Marn's voice came from the shadowed mouth of a low tunnel", prose }),
    ),
    true,
  )
  check(
    'a span straddling the quote and its attribution survives',
    citationAdmitsToPresent(
      evaluatePresenceCitation({
        name: 'Tomas',
        evidence: 'Tomas repeats, his voice flat',
        prose: '"The road stays empty," Tomas repeats, his voice flat.',
      }),
    ),
    true,
  )
  check(
    'narration is untouched',
    citationAdmitsToPresent(
      evaluatePresenceCitation({
        name: 'Tomas',
        evidence: "Tomas hasn't moved from the hearth.",
        prose: "Tomas hasn't moved from the hearth. \"Midnight's closer than you think.\"",
      }),
    ),
    true,
  )
}

console.log(`\npresence evidence audit: ${fail === 0 ? 'ALL GREEN' : `${fail} FAILED`} (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
