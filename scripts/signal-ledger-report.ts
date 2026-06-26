/**
 * FP/FN signal ledger REPORT — the read side of the measurement substrate. Reads
 * signal_ledger rows and prints, per detector, the proxies you tune enrichment by:
 *   - commit rate  (committed / detected)  — how often a candidate becomes canon
 *   - tier mix     (canon / hint / hidden) — how confident the commits are
 *   - miss rate    (turns with FN candidates / turns) — recall gap
 *   - correction rate (player_corrected turns / turns) — precision pressure
 *
 * Run a baseline BEFORE enriching a detector, enrich, then run again on fresh play:
 * misses should fall without corrections rising. That delta is the whole point.
 *
 *   bun run scripts/signal-ledger-report.ts [instanceId]   # omit = all instances
 */
import { ObjectId } from 'mongodb'
import { connectMongo, mongoColl } from '../src/config/mongo'
import type { LedgerSignalType, SignalLedgerDoc } from '../src/models/signal-ledger.model'

const INSTANCE = process.argv[2] || null
const SIGNALS: LedgerSignalType[] = ['movement', 'time', 'party', 'kinship', 'presence']

function pct(n: number, d: number): string {
  return d === 0 ? '  n/a' : `${((100 * n) / d).toFixed(0).padStart(4)}%`
}

async function main() {
  await connectMongo()
  const q = INSTANCE ? { instance_id: new ObjectId(INSTANCE) } : {}
  const rows = (await mongoColl.signalLedger().find(q).sort({ sequence: 1 }).toArray()) as SignalLedgerDoc[]

  if (!rows.length) {
    console.log(`No signal_ledger rows${INSTANCE ? ` for instance ${INSTANCE}` : ''}. Play some turns first.`)
    process.exit(0)
  }

  const turns = rows.length
  const correctedTurns = rows.filter((r) => r.player_corrected).length
  const missTurns = rows.filter((r) => (r.miss_candidates || 0) > 0).length
  const missTotal = rows.reduce((a, r) => a + (r.miss_candidates || 0), 0)

  console.log(`\nSignal ledger — ${turns} turn(s)${INSTANCE ? ` · instance ${INSTANCE}` : ' · ALL instances'}`)
  console.log(`Recall pressure:    ${missTurns}/${turns} turns had a miss candidate (${missTotal} total)  [${pct(missTurns, turns)}]`)
  console.log(`Precision pressure: ${correctedTurns}/${turns} turns were player corrections  [${pct(correctedTurns, turns)}]`)
  console.log('')
  console.log('  signal     detected  committed  commit%   canon  hint  hidden')
  console.log('  ' + '-'.repeat(62))

  for (const sig of SIGNALS) {
    let det = 0, com = 0, canon = 0, hint = 0, hidden = 0
    for (const r of rows) {
      const t = r.signals?.[sig]
      if (!t) continue
      det += t.detected || 0
      com += t.committed || 0
      if (t.by_tier) { canon += t.by_tier.canon; hint += t.by_tier.hint; hidden += t.by_tier.hidden }
    }
    console.log(
      `  ${sig.padEnd(10)} ${String(det).padStart(8)} ${String(com).padStart(10)}   ${pct(com, det)}   ${String(canon).padStart(5)} ${String(hint).padStart(5)} ${String(hidden).padStart(6)}`,
    )
  }
  console.log('')
  console.log('  note: kinship committed counts directed EDGES (inverse-closed ⇒ ~2× asserted')
  console.log('        ties), so its commit% reads ~200% by design — read it as a trend, not')
  console.log('        an absolute, and don\'t cross-compare it to the other signals.')
  console.log('')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
