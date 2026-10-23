/**
 * Run every pure-function audit. Excludes LIVE=1 LLM audits and anything that
 * needs Mongo. Used by `bun run audit:all` and CI.
 */
const PURE_AUDITS = [
  'audit:media',
  'audit:openrouter-routing',
  'audit:error-clarity',
  'audit:ink-promo',
  'audit:admin-ops',
  'audit:review-access',
  'audit:world-review',
  'audit:genre',
  'audit:template-privacy',
  'audit:choice-grounding',
  'audit:movement',
  'audit:narrated-arrival',
  'audit:thread-closure',
  'audit:choice-repetition',
  'audit:narrator-harness',
  'audit:codex-promotion',
  'audit:identity-promotion',
  'audit:identity-scope',
  'audit:name-promotion',
  'audit:alias-hygiene',
  'audit:party-signal',
  'audit:time-skip',
  'audit:signal-ledger',
  'audit:kinship',
  'audit:scene-state',
  'audit:presence-codex-gap',
  'audit:presence-evidence',
  'audit:location-evidence',
  'audit:location-decision',
  'audit:travel-intent',
  'audit:character-lifecycle',
  'audit:opening-place',
  'audit:time-evidence',
  'audit:durability',
  'audit:projection-fence',
  'audit:place-promotion',
  'audit:carding-routing',
  'audit:entity-adjudication',
  'audit:firebase-auth',
  'audit:input-guard',
  'audit:stat-mutations',
  'audit:bond-meters',
  'audit:embedding-latency',
  'audit:tail-stages',
  'audit:keep-warm',
  'audit:narration-hedge',
  'audit:choice-hedge',
] as const

const { scripts } = await Bun.file(new URL('../package.json', import.meta.url)).json() as { scripts: Record<string, string> }

let failed = 0
for (const script of PURE_AUDITS) {
  console.log(`\n──────── ${script} ────────`)
  const command = scripts[script].match(/^bun (?:--no-env-file )?run (scripts\/[\w-]+\.ts)$/)
  if (!command) throw new Error(`Not a pure audit entry: ${script}`)
  const proc = Bun.spawn(['bun', '--no-env-file', 'run', command[1]], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'ignore',
  })
  const code = await proc.exited
  if (code !== 0) {
    failed++
    console.log(`FAILED ${script} (exit ${code})`)
  }
}

console.log(`\n${failed === 0 ? 'ALL GREEN' : 'FAILURES'}: ${PURE_AUDITS.length - failed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
