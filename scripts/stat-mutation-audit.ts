/**
 * Stat-mutation audit — the world's gauges (heat, reputation, intimacy, …) are
 * derived by the post-stream metadata pass, and for a long time that pass
 * returned `{}` on virtually every turn, so every world's stats sat frozen at
 * their template defaults forever.
 *
 * Part 1 is deterministic: the projection layer must apply what the extractor
 * reports (and must not silently drop a near-miss stat name).
 * Part 2 calls the real extractor with the real prompt: passages with an
 * unmistakable cause MUST move the matching gauge, and passages with no cause
 * MUST leave every gauge alone. Run with LIVE=1 to include it.
 */
import { applyStateMutations, resolveStatKey } from '../src/utils/state-mutator'
import { extractChoiceMetadata, statDescriptors } from '../worker/lib/metadata-extractor'

let failed = 0
function ok(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failed++
}

// ---------------------------------------------------------------- projection

const limits = { heat: { min: 0, max: 100 }, reputation: { min: 0, max: 100 } }
const base = { heat: 10, reputation: 50 }

ok(
  'add moves the gauge',
  applyStateMutations(base, { heat: { op: 'add', value: 12 } }, limits).heat === 22,
)
ok(
  'subtract moves the gauge',
  applyStateMutations(base, { heat: { op: 'subtract', value: 4 } }, limits).heat === 6,
)
ok(
  'set overwrites the gauge',
  applyStateMutations(base, { heat: { op: 'set', value: 77 } }, limits).heat === 77,
)
ok(
  'authored bounds clamp instead of the 0-100 default',
  applyStateMutations({ dread: 5 }, { dread: { op: 'add', value: 50 } }, { dread: { min: 0, max: 10 } }).dread === 10,
)
ok(
  'casing drift still lands on the tracked gauge',
  applyStateMutations(base, { Heat: { op: 'add', value: 5 } } as any, limits).heat === 15,
)
ok(
  'separator drift still lands on the tracked gauge',
  applyStateMutations({ street_cred: 20 }, { 'street cred': { op: 'add', value: 5 } } as any).street_cred === 25,
)
ok(
  'a genuinely untracked gauge is still dropped',
  JSON.stringify(applyStateMutations(base, { karma: { op: 'add', value: 9 } } as any, limits)) === JSON.stringify(base),
)
ok('resolveStatKey prefers the exact tracked name', resolveStatKey('heat', ['heat', 'Heat']) === 'heat')
ok('resolveStatKey refuses an ambiguous match', resolveStatKey('HEAT', ['heat', 'he_at']) === null)

// ------------------------------------------------------------- descriptors

const descriptors = statDescriptors({
  heat: { default: 10, min: 0, max: 100, description: 'How much attention the corps and cops are paying to you.' },
})
ok(
  'template descriptions and bounds reach the extractor',
  descriptors.length === 1 &&
    descriptors[0].max === 100 &&
    descriptors[0].description.startsWith('How much attention'),
)
ok(
  'a bare gauge map still yields usable descriptors',
  statDescriptors({ heat: 10 })[0]?.description === 'heat',
)

// -------------------------------------------------------------- live extractor

if (process.env.LIVE) {
  const stats = statDescriptors({
    reputation: { min: 0, max: 100, description: "How much the city's players respect or fear you." },
    heat: { min: 0, max: 100, description: 'How much attention the corps and cops are paying to you.' },
  })
  const worldContext = 'Neon Divide — a rain-soaked cyberpunk city of corps, gangs and cops.'

  const cases: Array<{ label: string; prose: string; expect: (m: Record<string, { op: string; value: number }>) => boolean }> = [
    {
      label: 'a firefight logged by every camera raises heat',
      prose: `*The detective puts three rounds through the Arasaka drone and drops two corp security men in the stairwell. The third gets a clean look at their face before the smoke swallows him. Every camera on the block logged the same silhouette; by morning the incident will sit on a Militech desk with a name attached.*`,
      expect: (m) => m.heat?.op === 'add' && m.heat.value > 0,
    },
    {
      label: 'a month underground lowers heat',
      prose: `*Three weeks pass in a coffin motel under a dead man's ID. No jobs, no calls, no faces. The bounty notice scrolls past the detective's photo one last time and then stops appearing at all.*`,
      expect: (m) => m.heat?.op === 'subtract' && m.heat.value > 0,
    },
    {
      label: 'a public win in front of the district raises reputation',
      prose: `*The detective walks out of the Kabuki arena with the fixer's marker in hand and half the district watching — the one who broke Torvald's crew in the open. By dusk three runners have left messages begging for a meet.*`,
      expect: (m) => m.reputation?.op === 'add' && m.reputation.value > 0,
    },
    {
      label: 'selling out a client lowers reputation',
      prose: `*The detective hands the client's real name to the Tyger Claws and walks away with the credits. The client turns up in a drainage canal two days later, and everyone in the Divide knows who sold them.*`,
      expect: (m) => m.reputation?.op === 'subtract' && m.reputation.value > 0,
    },
    {
      label: 'an idle conversation moves nothing',
      prose: `*They sit on the fire escape passing a cigarette back and forth, talking about the rain, an old song, a bar that closed years ago. Neither of them mentions the job.*`,
      expect: (m) => Object.keys(m).length === 0,
    },
  ]

  for (const testCase of cases) {
    const meta = await extractChoiceMetadata(testCase.prose, stats, [], {
      isSentient: false,
      protagonist: { name: 'the detective', aliases: [] },
      worldContext,
      playerInput: '',
    } as any)
    const mutations = (meta.state_mutations || {}) as Record<string, { op: string; value: number }>
    ok(testCase.label, testCase.expect(mutations), JSON.stringify(mutations))
    const untracked = Object.keys(mutations).filter((key) => !resolveStatKey(key, ['heat', 'reputation']))
    ok(`  …and invents no gauge (${testCase.label.slice(0, 24)}…)`, untracked.length === 0, untracked.join(', '))
  }
} else {
  console.log('\n(skipping live extractor checks — rerun with LIVE=1 to include them)')
}

console.log(`\nstat mutation audit: ${failed === 0 ? 'ALL GREEN' : `${failed} failure(s)`}`)
process.exit(failed ? 1 : 0)
