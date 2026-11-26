/**
 * Give every saved cover its 540 px WebP.
 *
 * A world saved before covers carried a small copy has none, so its card on a
 * phone downloads the full 2048 px image. This finds those worlds — any kind —
 * and makes the copy the save paths now make (`makeCoverThumb`). A world whose
 * cover is not ours, not WebP, or is the shared default is left alone: there is
 * nothing to copy.
 *
 * Dry run by default. `--apply` writes only `image_thumb_url`, under a filter
 * that still requires the cover it was made from, so a cover changed while this
 * ran keeps its own and is skipped. Re-runnable: a second run finds nothing.
 *
 *   bun run scripts/backfill-cover-thumbs.ts [--apply] [--limit N]
 */
import { MongoClient, type ObjectId } from 'mongodb'
import { DEFAULT_COVER_KEY, isDefaultCoverUrl } from '../src/constants/default-cover'
import { coverThumbKey, makeCoverThumb } from '../src/utils/cover-thumb'

export interface CoverRow {
  _id: ObjectId
  title?: string
  kind?: 'world' | 'character' | 'group'
  image_url?: string
}

export interface BackfillRuntime {
  /** Worlds with a cover and no small copy, narrowed in the database. */
  candidates(limit?: number): Promise<CoverRow[]>
  makeThumb(imageUrl: string): Promise<string | null>
  /** Write the small copy, fenced on the cover it was made from. */
  setThumb(id: ObjectId, imageUrl: string, thumbUrl: string): Promise<boolean>
}

export interface BackfillOptions {
  apply: boolean
  limit?: number
}

export interface BackfillReport {
  candidates: number
  perKind: Record<'world' | 'character' | 'group', number>
  made: number
  skipped: number
  failed: number
  /** True when the run only planned (no `--apply`). */
  planned: boolean
}

export function parseOptions(args: string[]): BackfillOptions {
  const options: BackfillOptions = { apply: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') continue
    if (arg === '--apply') options.apply = true
    else if (arg === '--limit') {
      const value = Number(args[++i])
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('--limit needs a positive whole number')
      options.limit = value
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

/** Escape a literal for use inside a Mongo regex. */
function regexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The database's narrowing of the same test `needsCoverThumb` makes: our CDN,
 * a WebP, not the shared default, and no small copy yet. A non-WebP cover and a
 * foreign one fail the regex, and the default is excluded by its own key, so a
 * second run of the backfill finds nothing left.
 */
export function backfillFilter(cdnBaseUrl: string): Record<string, unknown> {
  const base = cdnBaseUrl.replace(/\/+$/, '')
  if (!base) throw new Error('CDN_BASE_URL is not configured; every cover would look foreign')
  const shared = `${base}/${DEFAULT_COVER_KEY}`
  return {
    $and: [
      { image_url: { $regex: `^${regexLiteral(base)}/.+\\.webp$` } },
      { image_url: { $ne: shared } },
    ],
    image_thumb_url: { $exists: false },
  }
}

/**
 * Whether this row is one to copy. A cover off our storage, the shared default,
 * or not WebP has no small copy to make, so it is not one; `makeCoverThumb`
 * would answer null for it anyway and the run would report it as a skip.
 */
export function needsCoverThumb(row: CoverRow): boolean {
  const url = (row.image_url || '').trim()
  if (!url || isDefaultCoverUrl(url)) return false
  return coverThumbKey(url) !== null
}

/**
 * The fence: `$set` the small copy on the row the check saw, and only while its
 * cover is still that same url. Never an explicit null, never another field.
 */
export function thumbWrite(imageUrl: string, thumbUrl: string) {
  return {
    filter: { image_url: imageUrl },
    update: { $set: { image_thumb_url: thumbUrl } },
  }
}

const KIND_LABEL: Record<'world' | 'character' | 'group', string> = {
  world: 'worlds',
  character: 'characters',
  group: 'groups',
}

export async function runBackfill(
  options: BackfillOptions,
  runtime: BackfillRuntime,
  log: (text: string) => void = console.log,
): Promise<BackfillReport> {
  const rows = await runtime.candidates(options.limit)
  const todo = rows.filter(needsCoverThumb)
  const perKind: BackfillReport['perKind'] = { world: 0, character: 0, group: 0 }
  for (const row of todo) perKind[row.kind ?? 'world']++

  log(`${options.apply ? '' : '[dry run] '}covers without a small copy: ${todo.length}`)
  for (const kind of ['world', 'character', 'group'] as const) {
    log(`  ${KIND_LABEL[kind]}: ${perKind[kind]}`)
  }
  for (const row of todo.slice(0, 10)) log(`  - ${row.title || row._id.toHexString()}`)

  const report: BackfillReport = {
    candidates: rows.length, perKind, made: 0, skipped: 0, failed: 0, planned: !options.apply,
  }
  if (!options.apply) return report

  // One at a time: each cover is a full-size decode, and the bucket takes a
  // steady stream better than a burst of four.
  for (const row of todo) {
    const imageUrl = (row.image_url || '').trim()
    const thumbUrl = await runtime.makeThumb(imageUrl)
    if (!thumbUrl) {
      report.failed++
      log(`  failed: ${row.title || row._id.toHexString()} — no small copy could be made`)
      continue
    }
    if (await runtime.setThumb(row._id, imageUrl, thumbUrl)) {
      report.made++
    } else {
      report.skipped++
      log(`  skipped: ${row.title || row._id.toHexString()} — its cover changed meanwhile`)
    }
  }

  log(`made: ${report.made}`)
  log(`skipped: ${report.skipped}`)
  log(`failed: ${report.failed}`)
  return report
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI must be supplied in the process environment')
  const filter = backfillFilter(process.env.CDN_BASE_URL || '')
  // The mode is printed before connecting, so a dry run says so even offline.
  console.log(`${options.apply ? 'apply' : 'dry run'}${options.limit ? ` (limit ${options.limit})` : ''}`)
  const client = new MongoClient(process.env.MONGODB_URI)
  await client.connect()
  try {
    const templates = client.db().collection<CoverRow>('world_templates')
    const runtime: BackfillRuntime = {
      candidates: (limit) => {
        const cursor = templates.find(filter, { projection: { title: 1, kind: 1, image_url: 1 } })
        return (limit ? cursor.limit(limit) : cursor).toArray()
      },
      makeThumb: (imageUrl) => makeCoverThumb(imageUrl),
      setThumb: async (id, imageUrl, thumbUrl) => {
        const write = thumbWrite(imageUrl, thumbUrl)
        const result = await templates.updateOne({ _id: id, ...write.filter }, write.update)
        return result.matchedCount === 1
      },
    }
    await runBackfill(options, runtime)
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
