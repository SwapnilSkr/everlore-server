/** Pure billing contract audit against an in-memory ledger. No database or provider calls. */
import { ObjectId } from 'mongodb'
import { mongoColl } from '../src/config/mongo'
import { env } from '../src/config/env'
import { billingService } from '../src/services/billing.service'
import { StoryRestingError } from '../src/utils/story-resting-error'
import { toClientError } from '../src/utils/ws-error'

type Row = {
  player_id: ObjectId
  delta: number
  reason: string
  reference?: string
  idempotency_key: string
  created_at: Date
}
const rows: Row[] = []
const samePlayer = (a: ObjectId, b: ObjectId) => a.toString() === b.toString()
const ledger = {
  findOne: async (query: { player_id: ObjectId; idempotency_key: string }) =>
    rows.find((row) => samePlayer(row.player_id, query.player_id) && row.idempotency_key === query.idempotency_key) ?? null,
  insertOne: async (row: Row) => {
    if (rows.some((existing) => samePlayer(existing.player_id, row.player_id) && existing.idempotency_key === row.idempotency_key)) {
      throw Object.assign(new Error('duplicate'), { code: 11000 })
    }
    rows.push(row)
    return { acknowledged: true }
  },
  updateOne: async (query: { player_id: ObjectId; idempotency_key: string }, update: { $setOnInsert: Row }) => {
    if (!rows.some((row) => samePlayer(row.player_id, query.player_id) && row.idempotency_key === query.idempotency_key)) {
      rows.push(update.$setOnInsert)
    }
    return { acknowledged: true }
  },
  aggregate: (pipeline: Array<Record<string, unknown>>) => ({
    toArray: async () => {
      const match = pipeline[0].$match as { player_id: ObjectId; reason?: string; reference?: string; created_at?: { $gte: Date } }
      const selected = rows.filter((row) => samePlayer(row.player_id, match.player_id)
        && (!match.reason || row.reason === match.reason)
        && (!match.reference || row.reference === match.reference)
        && (!match.created_at || row.created_at >= match.created_at.$gte))
      const group = pipeline[1].$group as Record<string, unknown>
      if ('balance' in group) return [{ balance: selected.reduce((sum, row) => sum + row.delta, 0) }]
      return [{ reserved: selected.length }]
    },
  }),
}
Object.assign(mongoColl, {
  inkLedger: () => ledger,
  billingConfig: () => ({ findOne: async () => null }),
  billingEntitlements: () => ({ findOne: async () => null }),
  users: () => ({ findOne: async () => ({ tier: 'free' }) }),
})

const player = new ObjectId()
const paidPlayer = new ObjectId()
const id = player.toString()
const paidId = paidPlayer.toString()
rows.push({ player_id: player, delta: 10, reason: 'adjustment', idempotency_key: 'seed', created_at: new Date() })
const originalPromo = env.INK_PROMO_UNLIMITED
const originalCap = env.INK_PROMO_DAILY_TURN_CAP
const originalEnforcement = env.BILLING_ENFORCEMENT_ENABLED
const failures: string[] = []
function check(ok: boolean, label: string) {
  if (ok) console.log(`PASS ${label}`)
  else { failures.push(label); console.error(`FAIL ${label}`) }
}
async function resting(call: () => Promise<unknown>, label: string) {
  let error: unknown
  try { await call() } catch (caught) { error = caught }
  const nextMidnight = new Date()
  nextMidnight.setUTCHours(24, 0, 0, 0)
  const wire = toClientError(error)
  check(error instanceof StoryRestingError && wire.code === 'STORY_RESTING'
    && wire.message === 'Your story rests until tomorrow.'
    && wire.resets_at === nextMidnight.toISOString(), label)
}
try {
  env.INK_PROMO_UNLIMITED = true
  env.INK_PROMO_DAILY_TURN_CAP = 500
  env.BILLING_ENFORCEMENT_ENABLED = false
  check((await billingService.wallet(id, 'free')).unlimited_ink === true, 'wallet marks unlimited Ink on')
  for (let turn = 1; turn <= 3; turn++) {
    const result = await billingService.reserve(id, 'story_turn', `promo-${turn}`)
    check(result.cost === 0 && result.balance === 10, `promo turn ${turn} costs zero and preserves balance`)
  }
  const repeat = await billingService.reserve(id, 'story_turn', 'promo-1')
  check(repeat.cost === 0 && rows.filter((row) => row.reference === 'story_turn' && samePlayer(row.player_id, player)).length === 3,
    'promo retry is idempotent')
  await billingService.release(id, repeat.reservation_id)
  await billingService.settle(id, repeat.reservation_id)
  check(rows.filter((row) => samePlayer(row.player_id, player)).every((row) => row.idempotency_key === 'seed' || row.delta === 0),
    'promo creates no balance-changing ledger row')
  const preview = await billingService.reserve(id, 'image_preview', 'preview')
  check(preview.cost === 0 && preview.balance === 10, 'other promo actions cost zero')
  for (let turn = 4; turn <= 500; turn++) await billingService.reserve(id, 'story_turn', `promo-${turn}`)
  await resting(() => billingService.reserve(id, 'story_turn', 'promo-501'), 'turn 501 rests until next UTC midnight')
  await billingService.release(id, (await billingService.reserve(id, 'story_turn', 'promo-500')).reservation_id)
  await resting(() => billingService.reserve(id, 'story_turn', 'promo-after-release'), 'release does not uncount a turn')
  check((await billingService.wallet(id, 'free')).balance === 10, 'balance unchanged after 500 promo turns')

  env.BILLING_ENFORCEMENT_ENABLED = true
  env.INK_PROMO_DAILY_TURN_CAP = 1
  const enforcedPlayer = new ObjectId().toString()
  const enforcedTurn = await billingService.reserve(enforcedPlayer, 'story_turn', 'enforced-1')
  check(enforcedTurn.cost === 0, 'promo remains free with billing enforcement on')
  await resting(() => billingService.reserve(enforcedPlayer, 'story_turn', 'enforced-2'),
    'promo cap applies with billing enforcement on')

  env.INK_PROMO_UNLIMITED = false
  env.BILLING_ENFORCEMENT_ENABLED = true
  check((await billingService.wallet(paidId, 'free')).unlimited_ink === false, 'wallet marks unlimited Ink off')
  const before = (await billingService.wallet(paidId, 'free')).balance
  const first = await billingService.reserve(paidId, 'story_turn', 'paid-1')
  check(first.cost === 1 && first.balance === before - 1, 'ordinary story turn charges one Ink')
  await billingService.release(paidId, first.reservation_id)
  await billingService.release(paidId, first.reservation_id)
  await billingService.settle(paidId, first.reservation_id)
  await billingService.settle(paidId, first.reservation_id)
  check((await billingService.wallet(paidId, 'free')).balance === before, 'ordinary release restores balance')
  check(rows.filter((row) => samePlayer(row.player_id, paidPlayer) && row.reason === 'release').length === 1
    && rows.filter((row) => samePlayer(row.player_id, paidPlayer) && row.reason === 'settle').length === 1,
    'release and settle stay idempotent')
  for (let turn = 2; turn <= 25; turn++) await billingService.reserve(paidId, 'story_turn', `paid-${turn}`)
  await resting(() => billingService.reserve(paidId, 'story_turn', 'paid-26'), 'ordinary free-tier cap is 25 and uses STORY_RESTING')
} finally {
  env.INK_PROMO_UNLIMITED = originalPromo
  env.INK_PROMO_DAILY_TURN_CAP = originalCap
  env.BILLING_ENFORCEMENT_ENABLED = originalEnforcement
}
console.log(`ink-promo audit: ${failures.length ? `${failures.length} failed` : 'all checks passed'}`)
if (failures.length) process.exit(1)
