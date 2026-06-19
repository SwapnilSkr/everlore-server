/**
 * Pure-function audit for the kinship graph's deterministic layers — ontology
 * (src/utils/kinship-ontology.ts), Stage-1 hygiene (worker/lib/kinship-hygiene.ts),
 * and the choice-grounding integration. No DB / no LLM. Run: bun run audit:kinship
 */
import {
  INVERSE_KIND, isSymmetric, surfaceToKind, isFigurativeKinship, RELATION_KINDS,
} from '../src/utils/kinship-ontology'
import { hygieneStage1, type ResolvedAssertion } from '../worker/lib/kinship-hygiene'
import { groundChoices } from '../worker/lib/choice-grounding'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else { fail++; console.log(`  FAIL ${label}\n       got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`) }
}

console.log('ontology — every kind has a well-formed inverse:')
for (const k of RELATION_KINDS) {
  check(`inverse(inverse(${k}))==${k}`, INVERSE_KIND[INVERSE_KIND[k]], k)
}
check('sibling_of symmetric', isSymmetric('sibling_of'), true)
check('partner_of symmetric', isSymmetric('partner_of'), true)
check('parent_of asymmetric', isSymmetric('parent_of'), false)

console.log('ontology — surface terms map to structural kind (+gender):')
check('brother', surfaceToKind('brother'), { kind: 'sibling_of', gender: 'm' })
check('sister', surfaceToKind('sister'), { kind: 'sibling_of', gender: 'f' })
check('dad≡father (parent_of)', surfaceToKind('dad')?.kind, surfaceToKind('father')?.kind)
check('clone-sister → sibling_of', surfaceToKind('broodmate')?.kind, 'sibling_of')
check('liege → superior_of', surfaceToKind('liege')?.kind, 'superior_of')
check('unknown term → null', surfaceToKind('zorblax'), null)

console.log('ontology — figurative detection:')
check('like a brother', isFigurativeKinship('he is like a brother to me'), true)
check('father figure', isFigurativeKinship('a father figure'), true)
check('literal "my brother" not figurative', isFigurativeKinship('my brother'), false)

console.log('hygiene — inverse closure (parent_of writes child_of):')
{
  const a: ResolvedAssertion[] = [
    { fromId: 'P', toId: 'C', kind: 'parent_of', label: 'mother', gender: 'f', polarity: 'assert', source: 'narrator' },
  ]
  const { edges } = hygieneStage1(a)
  const fwd = edges.find((e) => e.fromId === 'P' && e.toId === 'C')
  const inv = edges.find((e) => e.fromId === 'C' && e.toId === 'P')
  check('forward parent_of', fwd?.kind, 'parent_of')
  check('inverse child_of', inv?.kind, 'child_of')
}

console.log('hygiene — symmetric closure + label carry (sibling_of):')
{
  const { edges } = hygieneStage1([
    { fromId: 'A', toId: 'B', kind: 'sibling_of', label: 'sister', gender: 'f', polarity: 'assert', source: 'narrator' },
  ])
  check('two edges', edges.length, 2)
  check('both sibling_of', edges.every((e) => e.kind === 'sibling_of'), true)
  check('label carried both ways (symmetric)', edges.every((e) => e.label === 'sister'), true)
}

console.log('hygiene — drops self-loop + figurative label:')
{
  const { edges } = hygieneStage1([
    { fromId: 'X', toId: 'X', kind: 'sibling_of', polarity: 'assert', source: 'narrator' },
    { fromId: 'A', toId: 'B', kind: 'sibling_of', label: 'like a brother', polarity: 'assert', source: 'narrator' },
  ])
  check('all dropped', edges.length, 0)
}

console.log('hygiene — kind repair from label, 1-hop sibling→child inference:')
{
  const { edges } = hygieneStage1([
    // mislabeled kind: label says sister but kind parent_of → repaired to sibling_of
    { fromId: 'A', toId: 'B', kind: 'parent_of', label: 'sister', gender: 'f', polarity: 'assert', source: 'narrator' },
    // A is child_of P; A & C are siblings → infer C child_of P
    { fromId: 'A', toId: 'P', kind: 'child_of', polarity: 'assert', source: 'narrator' },
    { fromId: 'A', toId: 'C', kind: 'sibling_of', polarity: 'assert', source: 'narrator' },
  ])
  check('A→B repaired to sibling_of', edges.find((e) => e.fromId === 'A' && e.toId === 'B')?.kind, 'sibling_of')
  const inferred = edges.find((e) => e.fromId === 'C' && e.toId === 'P' && e.kind === 'child_of')
  check('inferred C child_of P exists', !!inferred, true)
  check('inferred tagged', inferred?.source, 'inferred')
}

console.log('choice-grounding — graphLabels source (perspective-correct):')
{
  // Player has ONLY a sister per the GRAPH. "brother" must drop, "sister" survive,
  // even with NO cast role text and NO prose mention.
  const r = groundChoices(
    [
      { label: 'Encourage my brother', kind: 'say', send: 'You should go.' },
      { label: 'Comfort my sister', kind: 'act', send: '*I hold her.*' },
    ],
    [], '', ['sister'],
  )
  check('brother dropped via graph', r.dropped.map((d) => d.choice.label), ['Encourage my brother'])
  check('sister kept via graph', r.choices.map((c) => c.label), ['Comfort my sister'])
}

console.log('choice-grounding — fresh kin perspective anchoring:')
{
  const unanchored = groundChoices(
    [{ label: 'Ask my sister', kind: 'say', send: 'What happened?' }],
    [],
    "Mara's sister steps into the hall.",
    [],
    '',
    { protagonist: { name: 'Kael', aliases: [] }, isSentient: false },
  )
  check('Mara sister does not license my sister', unanchored.dropped.map((d) => d.term), ['perspective:sister'])

  const anchored = groundChoices(
    [{ label: 'Ask my sister', kind: 'say', send: 'What happened?' }],
    [],
    "Kael's sister steps into the hall.",
    [],
    '',
    { protagonist: { name: 'Kael', aliases: [] }, isSentient: false },
  )
  check('protagonist sister licenses my sister', anchored.choices.map((c) => c.label), ['Ask my sister'])

  const your = groundChoices(
    [{ label: 'Ask my sister', kind: 'say', send: 'What happened?' }],
    [],
    'Your sister steps into the hall.',
    [],
    '',
    { protagonist: { name: 'Kael', aliases: [] }, isSentient: false },
  )
  check('your sister licenses my sister', your.choices.map((c) => c.label), ['Ask my sister'])
}

console.log('choice-grounding — supernatural reification (world-gated):')
{
  const ghostChoice = [
    { label: 'Ask her about the ghost', kind: 'say', send: 'What did you see in the doorway?' },
    { label: 'Reassure her', kind: 'say', send: 'You know they care.' },
  ]
  // grounded drama: premise has no supernatural markers → ghost choice dropped
  const grounded = groundChoices(ghostChoice, [], '', [], 'A cold, immaculate modern home; an adult unseen by their family; an adored twin sister; polished social circles.')
  check('grounded world drops ghost choice', grounded.dropped.map((d) => d.choice.label), ['Ask her about the ghost'])
  check('grounded world keeps the rest', grounded.choices.map((c) => c.label), ['Reassure her'])
  // negation-aware: a premise that DENIES the supernatural still gets the guard
  const denied = groundChoices(ghostChoice, [], '', [], 'A grounded crime drama. No magic, no monsters, nothing supernatural — just people and their secrets.')
  check('negated-supernatural premise still drops ghost', denied.dropped.map((d) => d.choice.label), ['Ask her about the ghost'])
  // horror world: premise names ghosts → literal ghost choice kept
  const horror = groundChoices(ghostChoice, [], '', [], 'A haunted manor where restless ghosts and vengeful spirits walk among the living.')
  check('horror world keeps ghost choice', horror.dropped.length, 0)
  // literal ghost carded as an entity → kept even without premise mention
  const carded = groundChoices(ghostChoice, ['The Grey Ghost', 'spirit'], '', [], 'A modern city.')
  check('carded ghost entity keeps choice', carded.dropped.length, 0)
  // tight lexicon: "monster"/"angel" for a real person are NOT policed
  const personMeta = groundChoices([{ label: 'Confront the monster', kind: 'say', send: 'Why are you so cruel?' }], [], '', [], 'A grounded family drama.')
  check('"monster" (person metaphor) not dropped', personMeta.dropped.length, 0)

  // FANTASY realm that never says "ghost" but is clearly supernatural-capable →
  // a ghost may freely come up (world markers: magic/dragons) — NOT policed.
  const fantasy = groundChoices(ghostChoice, [], '', [], 'A high-fantasy realm of magic, warring kingdoms, and ancient dragons.')
  check('fantasy realm keeps ghost (world-capable)', fantasy.dropped.length, 0)
  // SCI-FI world (starships) → an "alien" choice is allowed even if premise never said alien
  const scifi = groundChoices([{ label: 'Hail the alien', kind: 'say', send: 'Identify yourself.' }], [], '', [], 'A galaxy of starships and interstellar trade wars.')
  check('sci-fi world keeps alien choice', scifi.dropped.length, 0)
  // realist world that EXPLICITLY establishes a literal ghost in its premise → kept
  const realGhost = groundChoices(ghostChoice, [], '', [], 'A modern town that is genuinely haunted: the ghost of a drowned girl walks the pier.')
  check('realist world w/ explicit premise ghost keeps it', realGhost.dropped.length, 0)
}

console.log(`\nkinship audit: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
