/**
 * Flag the Google Play review and pre-launch test accounts that are already in
 * the database.
 *
 * The hourly sweep catches accounts as they appear, but the accounts that were
 * already there when it shipped need one pass. Dry run by default: it prints
 * each matching account and the count. `--apply` writes exactly what the sweep
 * writes, then prints how many were flagged. `--reroll` (with `--apply`) re-runs
 * the daily rollup for every day already stored, so the stored player numbers
 * leave the newly flagged accounts out.
 *
 *   bun --no-env-file run scripts/flag-reviewers.ts [--review-phone <number>] [--apply [--reroll]]
 *
 * Without `--review-phone` only the number-shaped-name rule is applied, because
 * the local env has no REVIEW_DEMO_PHONE. Never run with a real connection from
 * an agent's session: the orchestrator runs it.
 */
import { MongoClient, type Collection, type Document, type ObjectId } from 'mongodb'
import { env } from '../src/config/env'
import {
  reviewerReason,
  reviewerSweepFilter,
  reviewerSweepUpdate,
} from '../src/services/reviewer-accounts'

export type FlagOptions = { reviewPhone?: string; apply: boolean; reroll: boolean }

export function parseFlagArgs(args: string[]): FlagOptions {
  const options: FlagOptions = { apply: false, reroll: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') continue
    if (arg === '--apply') options.apply = true
    else if (arg === '--reroll') options.reroll = true
    else if (arg === '--review-phone') {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error('Missing value for --review-phone')
      options.reviewPhone = value
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  if (options.reroll && !options.apply) throw new Error('--reroll is only allowed with --apply')
  return options
}

/** A phone number with all but its last four digits hidden. */
export function maskPhone(phone?: string | null): string | null {
  const digits = (phone || '').replace(/\D/g, '')
  if (!digits) return null
  return `+${'•'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`
}

export type Candidate = {
  _id: ObjectId
  username?: string
  phone?: string
  created_at?: Date
  preferences?: { player_name?: string }
}

/** What the sweep would do to these rows, so a dry run and `--apply` agree. */
export type FlagPlan = {
  candidates: Array<{ _id: ObjectId; username: string; reason: string; created_at: Date | null; phone: string | null }>
  count: number
}

export function planFlags(rows: Candidate[], reviewPhone?: string): FlagPlan {
  const candidates = rows.map((row) => ({
    _id: row._id,
    username: row.username || '',
    // The same rule the sweep's filter selects on, so a row printed here is a
    // row `--apply` writes.
    reason: reviewerReason({ phone: row.phone, player_name: row.preferences?.player_name }, reviewPhone),
    created_at: row.created_at ?? null,
    phone: maskPhone(row.phone),
  })).filter((row): row is typeof row & { reason: string } => row.reason !== null)
  return { candidates, count: candidates.length }
}

/** The collections this script touches, so the audit can drive it in memory. */
export type FlagStore = {
  users: Collection<Document>
  appDaily: Collection<Document>
  rollupDay(day: string): Promise<unknown>
}

export async function flagReviewers(store: FlagStore, options: FlagOptions, log = console.log) {
  const filter = reviewerSweepFilter(options.reviewPhone ?? env.REVIEW_DEMO_PHONE)
  const rows = await store.users
    .find(filter, { projection: { username: 1, phone: 1, created_at: 1, preferences: 1 } })
    .toArray()
  const plan = planFlags(rows, options.reviewPhone ?? env.REVIEW_DEMO_PHONE)

  if (!options.apply) {
    for (const row of plan.candidates) {
      log([
        `_id=${row._id.toHexString()}`,
        `username=${row.username}`,
        `reason=${row.reason}`,
        `created=${row.created_at ? row.created_at.toISOString() : 'unknown'}`,
        `phone=${row.phone ?? '-'}`,
      ].join(' '))
    }
    log(`Dry run: ${plan.count} matching account${plan.count === 1 ? '' : 's'}. Re-run with --apply to flag them.`)
    return { ...plan, flagged: 0, rolled: 0 }
  }

  const result = await store.users.updateMany(filter, reviewerSweepUpdate(new Date(), options.reviewPhone ?? env.REVIEW_DEMO_PHONE))
  log(`Flagged ${result.modifiedCount} account${result.modifiedCount === 1 ? '' : 's'}.`)

  let rolled = 0
  if (options.reroll) {
    const days = await store.appDaily.find({}, { projection: { _id: 1 } }).sort({ _id: 1 }).toArray()
    for (const row of days) {
      await store.rollupDay(String(row._id))
      rolled++
    }
    log(`Re-rolled ${rolled} day${rolled === 1 ? '' : 's'}.`)
  }

  return { ...plan, flagged: result.modifiedCount, rolled }
}

if (import.meta.main) {
  let options: FlagOptions
  try {
    options = parseFlagArgs(Bun.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  const uri = process.env.MONGODB_URI
  if (!uri) {
    console.error('MONGODB_URI is not set.')
    process.exit(1)
  }
  const { appDailyRollupService } = await import('../src/services/telemetry/rollup.service')
  // The rollup reads through the app's shared client, so a re-roll needs it
  // connected. Only then: connecting also syncs the app's indexes.
  if (options.reroll) await (await import('../src/config/mongo')).connectMongo()
  const client = new MongoClient(uri)
  try {
    await client.connect()
    const db = client.db()
    await flagReviewers({
      users: db.collection('users'),
      appDaily: db.collection('app_daily'),
      rollupDay: (day) => appDailyRollupService.rollupDay(day),
    }, options)
  } finally {
    await client.close()
  }
  // The shared client from a re-roll would otherwise hold the process open.
  process.exit(0)
}
