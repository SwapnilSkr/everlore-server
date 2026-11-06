/**
 * Rename signed-in accounts that still carry the minted `guest_<hex>` username.
 *
 * Sign-in now replaces that name, but accounts claimed before the fix keep it.
 * A dry run is the default and prints only counts and user ids — never emails
 * or phones. `--apply` writes, and only when `--yes-db <dbname>` names the
 * database the process is actually connected to, so a mistyped shell cannot
 * rename a production account by accident. `updated_at` moves with the name;
 * nothing else is touched.
 *
 *   bun --no-env-file run scripts/fix-guest-usernames.ts [--apply --yes-db <dbname>]
 */
import { MongoClient, ObjectId, type Collection, type Document } from 'mongodb'
import { usernameFromSeed } from '../src/services/guest.service'

export const GUEST_USERNAME_FILTER = { guest: { $ne: true }, username: { $regex: '^guest_' } }

export interface RepairTarget {
  apply: boolean
  yesDb?: string
  /** The database this process is connected to, as Mongo reports it. */
  dbName: string
}

export interface RepairResult {
  selected: number
  ids: string[]
  renamed: number
}

/** The same seed rule sign-in uses: the email's local part, else a neutral base. */
export function repairSeed(row: { email?: unknown }): string {
  return typeof row.email === 'string' && row.email.includes('@') ? row.email.split('@')[0]! : 'player'
}

/** Applying is the destructive step, so it must name its target explicitly. */
export function assertRepairTarget(options: RepairTarget): void {
  if (options.apply && options.yesDb !== options.dbName) {
    throw new Error(`--apply needs --yes-db ${options.dbName}`)
  }
}

function duplicateKey(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 11000
}

async function renameOne(users: Collection<Document>, row: Document, seed: string): Promise<boolean> {
  // The first suffix is the shared rule; the second is fresh, for a collision.
  for (const suffix of [undefined, new ObjectId().toHexString().slice(0, 10)]) {
    try {
      const result = await users.updateOne(
        { _id: row._id, username: row.username, guest: { $ne: true } },
        { $set: { username: usernameFromSeed(seed, suffix), updated_at: new Date() } },
      )
      return result.modifiedCount === 1
    } catch (error) {
      if (!duplicateKey(error)) throw error
    }
  }
  return false
}

export async function repairGuestUsernames(users: Collection<Document>, options: RepairTarget): Promise<RepairResult> {
  assertRepairTarget(options)
  const rows = await users.find(GUEST_USERNAME_FILTER, { projection: { username: 1, email: 1 } }).toArray()
  const ids = rows.map(row => String(row._id))
  let renamed = 0
  if (options.apply) for (const row of rows) if (await renameOne(users, row, repairSeed(row))) renamed++
  return { selected: rows.length, ids, renamed }
}

async function main() {
  const args = process.argv.slice(2)
  const value = (flag: string) => {
    const at = args.indexOf(flag)
    return at === -1 ? undefined : args[at + 1]
  }
  const apply = args.includes('--apply')
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI must be supplied in the process environment')
  const client = new MongoClient(process.env.MONGODB_URI)
  await client.connect()
  try {
    const db = client.db()
    const result = await repairGuestUsernames(db.collection('users'), { apply, yesDb: value('--yes-db'), dbName: db.databaseName })
    console.log(`${apply ? 'renamed' : 'would rename'}: ${result.selected}`)
    for (const id of result.ids) console.log(id)
  } finally {
    await client.close()
  }
}

if (import.meta.main) {
  try {
    await main()
    process.exit(0)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
