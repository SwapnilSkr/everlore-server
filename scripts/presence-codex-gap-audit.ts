/**
 * Pure-function audit for the shared WITNESS -> ENTITY-STUB -> CANON gap
 * detector. No DB / no LLM. Run: bun run audit:presence-codex-gap
 */
import { classifyPresenceCodexGaps, detectPresenceCodexGaps, isActionableMention } from '../worker/lib/presence-gap-detector'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else {
    fail++
    console.log(`  FAIL ${label}\n       got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`)
  }
}

console.log('gap detector - visible & tracked -> no gap:')
{
  const prose = `*Mara set down her cup and met Bram's gaze across the table.* The Sister nodded slowly.`
  check(
    'Mara+Bram+Sister all tracked (present+codex+stub)',
    detectPresenceCodexGaps(prose, { present: ['Mara', 'Bram', 'Sister'], codex: ['Mara'], stubs: ['Sister'] }).sort(),
    [],
  )
}

console.log('gap detector - visible & absent everywhere -> gap:')
{
  const prose = `*Bram rose, bowed stiffly, and strode from the hall.*`
  check('Bram visible, untracked -> gap', detectPresenceCodexGaps(prose, {}), ['bram'])
}

console.log('gap detector - passer-by descriptors are NOT gaps:')
{
  const prose = `*The merchant bowed.* An old woman shuffled past. A hooded figure watched from the doorway.`
  check('merchant/old woman/figure filtered', detectPresenceCodexGaps(prose, {}), [])
}

console.log('gap detector - present family role covered by stub -> no gap:')
{
  const prose = `Father sat at the head of the table, silent.`
  check('Father present + stubbed -> no gap', detectPresenceCodexGaps(prose, { present: ['Father'], stubs: ['Father'] }), [])
}

console.log('gap detector - visible family role, untracked -> gap:')
{
  const prose = `Father sat at the head of the table, silent.`
  check('Father visible, untracked -> gap', detectPresenceCodexGaps(prose, {}), ['father'])
}

console.log('gap detector - visible titled NPC, untracked -> gap:')
{
  const prose = `The Butler poured the wine. The King rose to speak.`
  check(
    'Butler+King visible, untracked -> gaps',
    detectPresenceCodexGaps(prose, {}).sort(),
    ['butler', 'king'],
  )
}

console.log('gap detector - titled NPC present + stubbed -> no gap:')
{
  const prose = `The Butler poured the wine. The King rose to speak.`
  check(
    'Butler+King present + stubbed -> no gap',
    detectPresenceCodexGaps(prose, { present: ['Butler', 'King'], stubs: ['butler', 'king'] }),
    [],
  )
}

console.log('gap detector - child/self-facing labels are NOT candidates:')
{
  const prose = `The son watched his father leave.`
  check('son excluded, father covered', detectPresenceCodexGaps(prose, { present: ['Father'], stubs: ['Father'] }), [])
}

console.log('gap detector - bare abstract mentions are not actionable:')
{
  const prose = `Silence is the only thing the neglected son owns in this house.`
  check(
    'Silence is only mentioned_only, not an actionable gap',
    classifyPresenceCodexGaps(prose, {}).map((m) => `${m.key}:${m.tier}`),
    ['silence:mentioned_only'],
  )
}

console.log('gap detector - repeated capitalized adverb is NOT an actionable person:')
{
  // "Downstairs" capitalizes sentence-initially and repeats, so it lands in `probable`
  // on capitalization alone — but it never occupies a person slot, so the person-signal
  // gate must keep it out of the actionable (stub/present/trackable) set. A real walk-on
  // in the same prose earns a `confirmed` action signal and stays actionable.
  const prose = `Downstairs, a door slammed. Downstairs, the noise grew. *Bram stepped into the hall.*`
  const actionable = classifyPresenceCodexGaps(prose, {})
    .filter(isActionableMention)
    .map((m) => m.key)
    .sort()
  check('Downstairs excluded, Bram kept', actionable, ['bram'])
}

console.log('gap detector - family role synonyms are covered:')
{
  const prose = `"Did you see the latest post, Dad?" the girl asks.`
  check('Father present covers Dad mention', detectPresenceCodexGaps(prose, { present: ['Father'] }), [])
}

console.log('gap detector - robust to prose-hygiene pronoun substitution:')
{
  const prose = `*Mara set down her cup.* She did not look up.`
  check('single Mara anchor still covered', detectPresenceCodexGaps(prose, { codex: ['Mara'] }), [])
}

console.log(`\npresence/codex/stub gap audit: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
