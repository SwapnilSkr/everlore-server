/**
 * Deterministic audit for the choice-grounding REPAIR layer (§9). Pure — no LLM,
 * no DB. Asserts that ungrounded choices are repaired (not just dropped) and that
 * grounded choices pass through untouched.
 *
 *   bun run scripts/choice-grounding-audit.ts
 */
import { auditChoices } from '../worker/lib/choice-grounding-audit'

let pass = 0
let fail = 0
function ok(label: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  cond ? pass++ : fail++
}

const C = (label: string, send: string, kind = 'act') => ({ label, kind, send })

console.log('choice-grounding repair audit:\n')

// 1. Grounded choice with an EXISTING relative survives untouched.
{
  const r = auditChoices([C('Hug my sister', '*I pull my sister close.*')], ['Mara (sister)'], 'My sister Mara smiles.')
  ok('grounded kin choice kept untouched', r.choices.length === 1 && r.repairedCount === 0)
  ok('grounded kin marked grounded', r.results[0]?.grounded === true)
}

// 2. Fabricated kin (no brother anywhere) is REPAIRED, not dropped.
{
  const r = auditChoices([C('Encourage my brother', '*I clap my brother on the back.*')], ['Mara (sister)'], 'Mara stands alone.')
  ok('fabricated kin repaired (kept)', r.choices.length === 1 && r.repairedCount === 1, JSON.stringify(r.choices))
  ok('fabricated kin no longer references brother', !/brother/i.test(`${r.choices[0]?.label} ${r.choices[0]?.send}`))
  ok('kin issue typed', ['fabricated_kin', 'perspective_kin'].includes(r.results[0]?.issues[0]?.type as string))
}

// 3. Reified metaphor being in a GROUNDED world is dropped, not repaired into
// another generic chip that keeps the category error alive.
{
  const r = auditChoices(
    [C('Attack the ghost', '*I lunge at the ghost.*')],
    [],
    'The ghost in the doorway watches.',
    [],
    'A grounded family drama. No magic, nothing supernatural.',
  )
  ok('ungrounded being dropped', r.choices.length === 0 && r.dropped.length === 1, JSON.stringify(r))
  ok('being was not template-repaired', r.repairedCount === 0)
  ok('being issue typed', r.results[0]?.issues[0]?.type === 'ungrounded_being')
}

// 4. Real ghost in a SUPERNATURAL world is left alone.
{
  const r = auditChoices(
    [C('Attack the ghost', '*I lunge at the ghost.*')],
    [],
    'The ghost lunges.',
    [],
    'A haunted manor where restless ghosts and vengeful spirits walk among the living.',
  )
  ok('being in supernatural world untouched', r.choices.length === 1 && r.repairedCount === 0 && r.results[0]?.grounded === true)
}

// 5. Two fabricated-kin choices don't both repair to the same label (one drops).
{
  const r = auditChoices(
    [C('Encourage my brother', '*I nod to my brother.*'), C('Warn my brother', '*I grab my brother.*')],
    ['Mara (sister)'],
    'Mara stands alone.',
  )
  const labels = r.choices.map((c) => c.label.toLowerCase())
  ok('no duplicate repaired labels', new Set(labels).size === labels.length, JSON.stringify(labels))
}

// 6. GM premise kinship ("your twin sister") licenses first-person sibling choices
// before the codex/kinship graph has caught up on this first scene.
{
  const r = auditChoices(
    [C('Confront my sister', 'Why do you pretend I am not here?', 'say')],
    [],
    'The sister leans into their father, showing him something on her phone.',
    [],
    'You are unseen by your father, your mother, and your twin sister.',
    { protagonist: { name: 'Swapnil', aliases: [] }, isSentient: false },
  )
  ok('GM premise licenses my sister choice', r.choices.length === 1 && r.repairedCount === 0 && r.results[0]?.grounded === true)
}

console.log(`\nchoice-grounding repair audit: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
