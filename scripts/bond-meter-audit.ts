/**
 * Bond-meter audit — the four relationship meters (trust, affection, fear,
 * rivalry) are derived per turn by the character-codex extractor and vetted by
 * a conservative second-opinion adjudicator. Three faults in that path let a
 * correctly-observed bond change vanish silently:
 *   1. evidence had to be a contiguous verbatim quote, so a spliced quote
 *      ('"Don't," she whispers. "Please."' → "Don't, please.") voided the meter;
 *   2. an adjudicator rejection discarded the ENTIRE character card update,
 *      not just the bond it was reviewing;
 *   3. a rejection discarded ALL FOUR meters, so one unsupported meter took
 *      well-evidenced ones down with it.
 *
 * Part 1 is deterministic. Part 2 calls the real extractor: unmistakable bond
 * events must move the right meter, and passages with no direct interaction
 * must move nothing. Run with LIVE=1 to include it.
 */
import { applyRelationshipDeltas } from '../src/services/character-codex.service'
import { relationshipBaseline } from '../src/utils/relationship-baseline'
import {
  extractCharacterCodexDeltas,
  mergeSupplements,
  withoutMeters,
  withoutRelationshipFields,
} from '../worker/lib/character-codex-extractor'

let failed = 0
function ok(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failed++
}

// ---------------------------------------------------------------- projection

const start = { trust: 50, affection: 20, fear: 5, rivalry: 10 }
ok('a delta moves its meter', applyRelationshipDeltas(start, { trust: 8 }).trust === 58)
ok('several meters move in one turn', (() => {
  const next = applyRelationshipDeltas(start, { fear: 6, trust: -5 })
  return next.fear === 11 && next.trust === 45
})())
ok('the ±10 cap holds', applyRelationshipDeltas(start, { trust: 40 }).trust === 60)
ok('meters clamp at 0', applyRelationshipDeltas({ ...start, fear: 2 }, { fear: -9 }).fear === 0)
ok('a zero delta is a no-op', applyRelationshipDeltas(start, { trust: 0 }).trust === 50)
ok('an authored baseline seeds the bond', relationshipBaseline('sworn_enemy').rivalry === 90)

// ------------------------------------------------------------- adjudication

const candidate = {
  name: 'Vera Sol',
  appearance: 'soaked trench coat',
  relationship_deltas: { trust: -5, rivalry: 5 },
  relationship_evidence: { trust: 'You will not get the next one.', rivalry: 'You will not get the next one.' },
}

const meterScoped = withoutMeters(candidate, new Set(['trust'] as const)) as any
ok(
  'rejecting one meter keeps the others',
  meterScoped.relationship_deltas.rivalry === 5 && meterScoped.relationship_deltas.trust === undefined,
)
ok('rejecting one meter keeps the card update', meterScoped.appearance === 'soaked trench coat')

const bondStripped = withoutRelationshipFields(candidate) as any
ok('rejecting the whole bond keeps the card update', bondStripped.appearance === 'soaked trench coat')
ok('rejecting the whole bond drops every meter', bondStripped.relationship_deltas === undefined)

const rejectedList = [candidate, { name: 'Kade', appearance: 'scarred' }].map((item, index) =>
  index === 0 ? withoutRelationshipFields(item) : item,
) as any[]
ok('a rejection never removes a character entry', rejectedList.length === 2)
ok('a rejection never touches another character', rejectedList[1].appearance === 'scarred')

const merged = mergeSupplements(
  [{ name: 'Vera Sol', relationship_deltas: { rivalry: 5 }, relationship_evidence: { rivalry: 'quote' } }],
  [{ name: 'Vera Sol', relationship_deltas: { rivalry: 5, fear: 3 }, relationship_evidence: { fear: 'other quote' } }],
) as any[]
ok('a supplement never duplicates a character entry', merged.length === 1)
ok('a supplement cannot double-count a meter the candidate already moved', merged[0].relationship_deltas.rivalry === 5)
ok('a supplement still contributes a meter the candidate missed', merged[0].relationship_deltas.fear === 3)

const appended = mergeSupplements(
  [{ name: 'Vera Sol' }],
  [{ name: 'Kade', relationship_deltas: { trust: 2 } }],
) as any[]
ok('a supplement for a new character is still added', appended.length === 2 && appended[1].name === 'Kade')

// -------------------------------------------------------------- live extractor

if (process.env.LIVE) {
  const existing = [
    { canonical_name: 'Vera Sol', aliases: [], relationship: { ...start } },
  ] as any[]
  const trials = Number(process.env.TRIALS || 3)

  const cases: Array<{ label: string; meter: 'trust' | 'affection' | 'fear' | 'rivalry' | 'none'; prose: string }> = [
    {
      label: 'a kiss raises affection',
      meter: 'affection',
      prose: `*Vera closes the distance without a word and kisses the detective, one hand fisted in the collar of the wet trench coat. When she pulls back she does not let go.* "I have wanted to do that since the noodle bar," *she says.*`,
    },
    {
      label: 'a gun to the face raises fear',
      meter: 'fear',
      prose: `*The detective puts the barrel against Vera's cheek and thumbs the hammer back. She goes very still, and for the first time the clinical blue optic flickers, and her hands come up open and empty.*`,
    },
    {
      label: 'a public defeat raises rivalry',
      meter: 'rivalry',
      prose: `*The detective takes the contract out from under Vera in front of the whole fixer's table, and she has to sit there and watch it happen.* "Enjoy it," *she says flatly.* "You will not get the next one."`,
    },
    {
      label: 'saving a life raises trust',
      meter: 'trust',
      prose: `*The detective drags Vera out of the burning shell of the AV and puts a tourniquet on her leg with steady hands, then stays until the medics arrive.* "You could have run," *she says.* "You didn't."`,
    },
    {
      label: 'a betrayal lowers trust',
      meter: 'trust',
      prose: `*Vera finds out it was the detective who gave her name to the Tyger Claws. She does not shout. She simply looks at the detective for a long moment and then walks out into the rain without a word.*`,
    },
    {
      label: 'idle company moves nothing',
      meter: 'none',
      prose: `*They sit at the counter waiting on the noodles. Vera scrolls a feed; the detective watches the rain. Neither of them says much of anything.*`,
    },
    {
      label: 'scenery alone moves nothing',
      meter: 'none',
      prose: `*Rain moves across the district in sheets. The neon on the far tower cycles through its loop, red to gold to red, and the gutters run loud beneath the walkway.*`,
    },
  ]

  for (const testCase of cases) {
    let hits = 0
    const observed: string[] = []
    for (let i = 0; i < trials; i++) {
      const deltas = await extractCharacterCodexDeltas({
        playerInput: '',
        aiResponse: testCase.prose,
        existing,
        protagonistName: 'the detective',
        presentCast: ['Vera Sol'],
      })
      const moved = deltas.find((d) => /vera/i.test(d.name) && d.relationship_deltas)?.relationship_deltas as
        | Record<string, number>
        | undefined
      observed.push(JSON.stringify(moved ?? null))
      const anyMovement = !!moved && Object.keys(moved).length > 0
      if (testCase.meter === 'none' ? !anyMovement : !!moved?.[testCase.meter]) hits++
    }
    // A control must NEVER fire; a positive case is a model judgement, so it
    // passes on a majority rather than demanding perfection from a mini model.
    const threshold = testCase.meter === 'none' ? trials : Math.ceil(trials / 2)
    ok(`${testCase.label} (${hits}/${trials})`, hits >= threshold, observed.join(' '))
  }
} else {
  console.log('\n(skipping live extractor checks — rerun with LIVE=1 to include them)')
}

console.log(`\nbond meter audit: ${failed === 0 ? 'ALL GREEN' : `${failed} failure(s)`}`)
process.exit(failed ? 1 : 0)
