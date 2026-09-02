/**
 * READ-ONLY census of what a replay corpus could actually be built from today.
 *
 * Answers three questions the de-regex sequencing depends on:
 *   1. How many turns of prose exist, and how are they distributed across worlds?
 *   2. How many carry the derived state a shadow-compare would diff against?
 *   3. Is signal_ledger actually populated, or is every counter zero?
 *
 * Writes nothing. Safe against prod.
 */
import { connectMongo, mongoColl } from '../src/config/mongo'

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`
}

async function main(): Promise<void> {
  await connectMongo()
  const events = mongoColl.events() as any
  const ledger = mongoColl.signalLedger() as any

  const total = await events.countDocuments({})
  const instances = (await events.distinct('instance_id')).length
  const withProse = await events.countDocuments({ 'data.ai_response': { $type: 'string', $ne: '' } })
  const withPlayerInput = await events.countDocuments({ 'data.player_input': { $type: 'string', $ne: '' } })
  const withSceneState = await events.countDocuments({ 'data.scene_state': { $exists: true } })
  const withPresent = await events.countDocuments({ 'data.present_characters.0': { $exists: true } })
  const withLocDeltas = await events.countDocuments({ 'data.location_deltas.0': { $exists: true } })
  const withVariants = await events.countDocuments({ 'data.replay_variants.0': { $exists: true } })

  console.log('=== events ===')
  console.log(`total events            ${total}`)
  console.log(`distinct instances      ${instances}  (avg ${(total / Math.max(1, instances)).toFixed(1)} turns)`)
  console.log(`has ai_response         ${withProse}  ${pct(withProse, total)}`)
  console.log(`has player_input        ${withPlayerInput}  ${pct(withPlayerInput, total)}`)
  console.log(`has scene_state         ${withSceneState}  ${pct(withSceneState, total)}`)
  console.log(`has present_characters  ${withPresent}  ${pct(withPresent, total)}`)
  console.log(`has location_deltas     ${withLocDeltas}  ${pct(withLocDeltas, total)}`)
  console.log(`has replay_variants     ${withVariants}  ${pct(withVariants, total)}`)

  // Turn-count distribution: a corpus needs LONG runs, not many 1-turn worlds.
  const byInstance = await events
    .aggregate([
      { $group: { _id: '$instance_id', turns: { $sum: 1 } } },
      { $bucket: {
          groupBy: '$turns',
          boundaries: [1, 2, 5, 10, 20, 50, 1000],
          default: 'other',
          output: { worlds: { $sum: 1 }, turns: { $sum: '$turns' } },
      } },
    ])
    .toArray()
  console.log('\n=== turns per world (corpus depth) ===')
  for (const b of byInstance) console.log(`  >=${b._id} turns: ${b.worlds} worlds, ${b.turns} turns`)

  const oldest = await events.find({}).sort({ created_at: 1 }).limit(1).toArray()
  const newest = await events.find({}).sort({ created_at: -1 }).limit(1).toArray()
  console.log(`\nspan: ${oldest[0]?.created_at?.toISOString?.() || '?'} .. ${newest[0]?.created_at?.toISOString?.() || '?'}`)

  // scene_state is recent; date it so "1 of N" is read as newness, not a bug.
  const ss = await events.find({ 'data.scene_state': { $exists: true } }).sort({ created_at: 1 }).limit(1).toArray()
  if (ss[0]) console.log(`first scene_state at: ${ss[0].created_at?.toISOString?.()}`)

  // === signal_ledger: aggregate, do not sample ===
  const ledgerTotal = await ledger.countDocuments({})
  console.log(`\n=== signal_ledger (${ledgerTotal} rows) ===`)
  const agg = await ledger
    .aggregate([
      {
        $group: {
          _id: null,
          corrected: { $sum: { $cond: ['$player_corrected', 1, 0] } },
          misses: { $sum: '$miss_candidates' },
          mvD: { $sum: '$signals.movement.detected' },
          mvC: { $sum: '$signals.movement.committed' },
          tD: { $sum: '$signals.time.detected' },
          tC: { $sum: '$signals.time.committed' },
          pD: { $sum: '$signals.party.detected' },
          pC: { $sum: '$signals.party.committed' },
          kD: { $sum: '$signals.kinship.detected' },
          kC: { $sum: '$signals.kinship.committed' },
          prD: { $sum: '$signals.presence.detected' },
          prC: { $sum: '$signals.presence.committed' },
          prCanon: { $sum: '$signals.presence.by_tier.canon' },
        },
      },
    ])
    .toArray()
  const a = agg[0] || {}
  console.log(`player_corrected rows   ${a.corrected ?? 0}`)
  console.log(`miss_candidates (sum)   ${a.misses ?? 0}`)
  console.log(`movement  detected ${a.mvD ?? 0} / committed ${a.mvC ?? 0}`)
  console.log(`time      detected ${a.tD ?? 0} / committed ${a.tC ?? 0}`)
  console.log(`party     detected ${a.pD ?? 0} / committed ${a.pC ?? 0}`)
  console.log(`kinship   detected ${a.kD ?? 0} / committed ${a.kC ?? 0}`)
  console.log(`presence  detected ${a.prD ?? 0} / committed ${a.prC ?? 0} (canon ${a.prCanon ?? 0})`)

  const nonZero = await ledger.countDocuments({
    $or: [
      { 'signals.movement.detected': { $gt: 0 } },
      { 'signals.time.detected': { $gt: 0 } },
      { 'signals.party.detected': { $gt: 0 } },
      { 'signals.kinship.detected': { $gt: 0 } },
      { 'signals.presence.detected': { $gt: 0 } },
      { miss_candidates: { $gt: 0 } },
    ],
  })
  console.log(`rows with ANY non-zero signal: ${nonZero} / ${ledgerTotal}  ${pct(nonZero, ledgerTotal)}`)

  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
