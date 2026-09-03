/**
 * Run every pure-function audit. Excludes LIVE=1 LLM audits and anything that
 * needs Mongo. Used by `bun run audit:all` and CI.
 */
const PURE_AUDITS = [
  'audit:review-access',
  'audit:choice-grounding',
  'audit:movement',
  'audit:narrated-arrival',
  'audit:thread-closure',
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
  'audit:character-lifecycle',
  'audit:opening-place',
  'audit:time-evidence',
  'audit:durability',
  'audit:place-promotion',
  'audit:carding-routing',
  'audit:entity-adjudication',
  'audit:firebase-auth',
  'audit:input-guard',
  'audit:stat-mutations',
  'audit:bond-meters',
] as const

let failed = 0
for (const script of PURE_AUDITS) {
  console.log(`\n──────── ${script} ────────`)
  const proc = Bun.spawn(['bun', 'run', script], {
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
