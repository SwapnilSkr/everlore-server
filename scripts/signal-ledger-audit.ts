/**
 * Pure-function audit for the FP/FN signal ledger builder (no DB / no LLM).
 * Run: bun run audit:signal-ledger
 */
import { buildSignalLedger, type SignalLedgerInput } from '../worker/lib/signal-ledger'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else { fail++; console.log(`  FAIL ${label}\n       got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`) }
}

const base: SignalLedgerInput = {
  movement: { detected: false, committed: false },
  time: { detected: false, committed: false },
  party: { detected: 0, committedConfidences: [] },
  kinship: { detected: 0, committed: 0 },
  presence: { confirmed: 0, probable: 0, mentioned: 0 },
  playerCorrected: false,
  missCandidates: 0,
}

console.log('movement/time — single hard-committed facts record provenance, no tier:')
const mv = buildSignalLedger({
  ...base,
  movement: { detected: true, committed: true, source: 'player_narration', confidence: 0.95 },
}).signals.movement
check('committed move → detected/committed 1, source+confidence, no by_tier', mv, {
  detected: 1, committed: 1, source: 'player_narration', confidence: 0.95,
})
const mvDetectedOnly = buildSignalLedger({
  ...base,
  movement: { detected: true, committed: false, source: 'narrator', confidence: 0.9 },
}).signals.movement
check('detected-but-not-committed move → no source/confidence leaked', mvDetectedOnly, { detected: 1, committed: 0 })

console.log('party — committed count + tier rollup over fresh-join confidences:')
const party = buildSignalLedger({
  ...base,
  party: { detected: 3, committedConfidences: [0.9, 0.5, 0.35] }, // canon, hint, hidden
}).signals.party
check('3 detected, 3 committed, tiers split', party, {
  detected: 3, committed: 3, by_tier: { canon: 1, hint: 1, hidden: 1 },
})
const partyNone = buildSignalLedger({ ...base, party: { detected: 2, committedConfidences: [] } }).signals.party
check('detected joins all gated out → committed 0, no by_tier', partyNone, { detected: 2, committed: 0 })

console.log('kinship — detected assertions vs committed edges (+optional tier mix):')
const kin = buildSignalLedger({
  ...base,
  kinship: { detected: 4, committed: 2, committedConfidences: [0.9, 0.4] },
}).signals.kinship
check('4 detected, 2 committed, tiers from edge confidences', kin, {
  detected: 4, committed: 2, by_tier: { canon: 1, hint: 1, hidden: 0 },
})

console.log('presence — confirmed→canon, probable→hint, mentioned→hidden:')
const pres = buildSignalLedger({
  ...base,
  presence: { confirmed: 2, probable: 1, mentioned: 3 },
}).signals.presence
check('committed = confirmed+probable; by_tier maps the three tiers', pres, {
  detected: 6, committed: 3, by_tier: { canon: 2, hint: 1, hidden: 3 },
})

console.log('ground-truth flags — player_corrected (precision) + miss_candidates (recall):')
const flags = buildSignalLedger({ ...base, playerCorrected: true, missCandidates: 2 })
check('player_corrected passthrough', flags.player_corrected, true)
check('miss_candidates passthrough', flags.miss_candidates, 2)
check('miss_candidates clamped at 0', buildSignalLedger({ ...base, missCandidates: -5 }).miss_candidates, 0)

console.log('empty turn — every signal present, all zero:')
const empty = buildSignalLedger(base)
check('movement zeroed', empty.signals.movement, { detected: 0, committed: 0 })
check('time zeroed', empty.signals.time, { detected: 0, committed: 0 })
check('all five signals emitted', Object.keys(empty.signals).sort(), ['kinship', 'movement', 'party', 'presence', 'time'])

console.log(`\nsignal ledger audit: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
