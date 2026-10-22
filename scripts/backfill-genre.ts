/**
 * Give every world a genre.
 *
 * A world is data, so a catalog world takes the genre of the batch folder it was
 * authored in. Everything else takes the voice-family fallback. Dry run by
 * default; `--apply` writes `genre` and `updated_at` and nothing else, so review
 * state is never touched and a second run writes nothing.
 *
 *   bun --no-env-file run scripts/backfill-genre.ts --catalog <dir> [--catalog <dir>] [--apply]
 *
 * Each `--catalog` may be the catalog root (its subfolders are the genres) or a
 * single genre batch folder, so a staged copy can be handed to prod.
 */
import { readdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { MongoClient, ObjectId } from 'mongodb'
import { deriveGenre, GENRES, isGenre, type Genre } from '../src/utils/genre'

export interface BackfillWorld {
  _id: ObjectId
  slug: string
  genre?: string | null
  narrative_style?: string | null
}

export interface BackfillRuntime {
  /** Only worlds that do not have a genre yet. */
  findMissingGenre(): Promise<BackfillWorld[]>
  setGenre(id: ObjectId, genre: Genre, updatedAt: Date): Promise<void>
}

export interface BackfillPlan {
  apply: boolean
  /** Catalog slug → genre, read before anything is written. */
  catalog: Map<string, Genre>
}

export interface BackfillReport {
  counts: Record<Genre, number>
  catalogMatches: number
  scanned: number
  written: number
}

export function parseOptions(args: string[]): { apply: boolean; catalog: string[] } {
  const options = { apply: false, catalog: [] as string[] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') continue
    if (arg === '--apply') options.apply = true
    else if (arg === '--catalog') {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error('Missing value for --catalog')
      options.catalog.push(resolve(value))
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

/** Genre-named folders under a root, or the root itself when it is one batch. */
async function genreDirs(root: string): Promise<string[]> {
  if (isGenre(basename(root))) return [root]
  const entries = await readdir(root, { withFileTypes: true })
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  const direct = dirs.filter(isGenre).map((name) => join(root, name))
  if (direct.length > 0) return direct
  // A parent of the catalog root (for example `launch/`) also resolves.
  const nested: string[] = []
  for (const name of dirs) {
    const child = join(root, name)
    const inner = (await readdir(child, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter(isGenre)
    for (const genre of inner) nested.push(join(child, genre))
  }
  return nested
}

/**
 * Which genre each catalog slug was authored under. Only the slug is read; the
 * rest of the catalog file is the seed script's business.
 */
export async function readCatalogGenres(roots: string[]): Promise<Map<string, Genre>> {
  const bySlug = new Map<string, Genre>()
  for (const root of roots) {
    for (const dir of await genreDirs(root)) {
      const genre = basename(dir) as Genre
      for (const file of (await readdir(dir)).sort()) {
        if (!file.endsWith('.json')) continue
        const raw = JSON.parse(await readFile(join(dir, file), 'utf8')) as { slug?: unknown }
        if (typeof raw?.slug !== 'string') continue
        const known = bySlug.get(raw.slug)
        if (known && known !== genre) {
          throw new Error(`${raw.slug}: catalog files disagree on genre (${known} vs ${genre})`)
        }
        bySlug.set(raw.slug, genre)
      }
    }
  }
  return bySlug
}

/** The exact write: a genre and a timestamp, never a review field. */
export function genreUpdate(genre: Genre, updatedAt: Date) {
  return { $set: { genre, updated_at: updatedAt } }
}

/** Only worlds with no genre yet; `null` also matches a missing field. */
export const MISSING_GENRE_FILTER = { genre: null } as const

export async function runBackfill(
  plan: BackfillPlan,
  runtime: BackfillRuntime,
  log: (text: string) => void = console.log,
  now: Date = new Date(),
): Promise<BackfillReport> {
  const worlds = await runtime.findMissingGenre()
  const counts = Object.fromEntries(GENRES.map(({ key }) => [key, 0])) as Record<Genre, number>
  let catalogMatches = 0
  let written = 0

  for (const world of worlds) {
    const fromCatalog = plan.catalog.get(world.slug)
    const genre = fromCatalog ?? deriveGenre(world.narrative_style)
    if (fromCatalog) catalogMatches++
    counts[genre]++
    if (plan.apply) {
      await runtime.setGenre(world._id, genre, now)
      written++
    }
  }

  const scanned = worlds.length
  log(`${plan.apply ? '' : '[dry-run] '}worlds without a genre: ${scanned}`)
  for (const { key, label } of GENRES) log(`  ${label}: ${counts[key]}`)
  log(`catalog matches: ${catalogMatches}`)
  log(`${plan.apply ? 'written' : 'would write'}: ${plan.apply ? written : scanned}`)
  return { counts, catalogMatches, scanned, written }
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  // Read the catalog before connecting, so a bad path fails on a read-only step.
  const catalog = await readCatalogGenres(options.catalog)
  if (options.catalog.length > 0 && catalog.size === 0) {
    throw new Error('No genre batch folders or catalog slugs were found under --catalog')
  }
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI must be supplied in the process environment')

  const client = new MongoClient(process.env.MONGODB_URI)
  await client.connect()
  try {
    const templates = client.db().collection('world_templates')
    const runtime: BackfillRuntime = {
      findMissingGenre: () => templates
        .find(
          MISSING_GENRE_FILTER,
          { projection: { slug: 1, genre: 1, narrative_style: 1 } },
        )
        .toArray() as Promise<BackfillWorld[]>,
      setGenre: async (id, genre, updatedAt) => {
        await templates.updateOne({ _id: id }, genreUpdate(genre, updatedAt))
      },
    }
    await runBackfill({ apply: options.apply, catalog }, runtime)
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
