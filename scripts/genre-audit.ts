/**
 * Genre audit: derivation, the Explore filters, the For You interleave, the
 * shelf counts, review safety and the backfill.
 *
 * Pure: an in-memory world set stands in for Mongo, no environment file is
 * loaded, and nothing opens a socket or calls a model.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'
import { deriveGenre, forYouOrder, GENRES, isGenre, resolveGenre, type Genre } from '../src/utils/genre'
import { NARRATIVE_STYLE_PRESETS, STYLE_FAMILY } from '../src/utils/narrative-styles'
import { MEANINGFUL_WORLD_FIELDS } from '../src/utils/world-review'
import {
  genreUpdate,
  MISSING_GENRE_FILTER,
  parseOptions,
  readCatalogGenres,
  runBackfill,
  type BackfillRuntime,
  type BackfillWorld,
} from './backfill-genre'

// ── An in-memory world set ───────────────────────────────────────────────────
type Row = Record<string, any>
const users: Row[] = []
const worlds: Row[] = []
let writes = 0
let lastSet: Row | null = null

function equal(a: unknown, b: unknown): boolean {
  if (a instanceof ObjectId && b instanceof ObjectId) return a.equals(b)
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return isDeepStrictEqual(a, b)
}

function matches(row: Row, query: Row): boolean {
  return Object.entries(query).every(([key, condition]) => {
    if (key === '$and') return (condition as Row[]).every((part) => matches(row, part))
    if (key === '$or') return (condition as Row[]).some((part) => matches(row, part))
    const value = row[key]
    if (condition === null) return value === null || value === undefined
    if (condition && typeof condition === 'object' && !Array.isArray(condition) &&
      !(condition instanceof ObjectId) && !(condition instanceof Date)) {
      const expression = condition as Row
      if ('$exists' in expression) return (value !== undefined) === expression.$exists
      if ('$ne' in expression) return !equal(value, expression.$ne)
      if ('$in' in expression) return (expression.$in as unknown[]).some((item) => equal(value, item))
      if ('$nin' in expression) return !(expression.$nin as unknown[]).some((item) => equal(value, item))
      if ('$regex' in expression) {
        return new RegExp(String(expression.$regex), String(expression.$options ?? '')).test(String(value ?? ''))
      }
    }
    return equal(value, condition)
  })
}

function cursor(rows: Row[]) {
  let result = [...rows]
  const api = {
    sort(spec: Record<string, number>) {
      result = [...result].sort((a, b) => {
        for (const [key, direction] of Object.entries(spec)) {
          const left = a[key], right = b[key]
          const compared = left instanceof Date && right instanceof Date
            ? left.getTime() - right.getTime()
            : String(left ?? '').localeCompare(String(right ?? ''))
          if (compared !== 0) return compared * direction
        }
        return 0
      })
      return api
    },
    skip(count: number) {
      result = result.slice(count)
      return api
    },
    limit(count: number) {
      result = count > 0 ? result.slice(0, count) : result
      return api
    },
    toArray: async () => result,
  }
  return api
}

function collection(rows: Row[]) {
  return {
    find: (query: Row = {}) => cursor(rows.filter((row) => matches(row, query))),
    findOne: async (query: Row) => rows.find((row) => matches(row, query)) ?? null,
    countDocuments: async (query: Row = {}) => rows.filter((row) => matches(row, query)).length,
    insertOne: async (doc: Row) => { writes++; rows.push(doc); return { insertedId: doc._id } },
    updateOne: async (query: Row, update: { $set?: Row; $unset?: Row }) => {
      const row = rows.find((entry) => matches(entry, query))
      if (!row) return { matchedCount: 0 }
      writes++
      lastSet = update.$set ?? null
      Object.assign(row, update.$set)
      for (const key of Object.keys(update.$unset ?? {})) delete row[key]
      return { matchedCount: 1 }
    },
    aggregate: () => { throw new Error('The genre audit never uses an interest aggregate') },
  }
}

mock.module('../src/config/mongo', () => ({
  mongoColl: {
    users: () => collection(users),
    worldTemplates: () => collection(worlds),
  },
}))

const { Elysia, ValidationError } = await import('elysia')
const { templateRoutes } = await import('../src/routes/template.routes')
const { templateService } = await import('../src/services/template.service')
const { HttpError } = await import('../src/utils/http-error')
const { VALIDATION_MESSAGE } = await import('../src/utils/validation-response')

// ── Fixtures ─────────────────────────────────────────────────────────────────
const day = (dayOfMonth: number) => new Date(Date.UTC(2026, 9, dayOfMonth))

function world(overrides: Row): Row {
  return {
    _id: new ObjectId(),
    creator_id: new ObjectId(),
    title: 'Fixture',
    slug: 'fixture',
    description: 'A fixture world.',
    kind: 'world',
    is_published: true,
    visibility: 'public',
    review_status: 'approved',
    narrative_style: 'epic_fantasy',
    seed_prompt: 'A fixture world.',
    global_lore: '',
    base_stats_template: {},
    flag_definitions: {},
    scene_tags: [],
    model_preferences: {},
    max_context_memories: 25,
    max_lore_results: 10,
    created_at: day(1),
    updated_at: day(1),
    ...overrides,
  }
}

worlds.push(
  world({ slug: 'romance-world', genre: 'romance', kind: 'world', narrative_style: 'flirty', created_at: day(1) }),
  world({ slug: 'romance-character', genre: 'romance', kind: 'character', narrative_style: 'dark_romance', created_at: day(2) }),
  world({ slug: 'epic-world', genre: 'epic', kind: 'world', narrative_style: 'epic_fantasy', created_at: day(3) }),
  world({ slug: 'epic-world-2', genre: 'epic', kind: 'world', narrative_style: 'shonen', created_at: day(4) }),
  world({ slug: 'dark-character', genre: 'dark', kind: 'character', narrative_style: 'grimdark', created_at: day(5) }),
  world({ slug: 'horror-before-backfill', kind: 'world', narrative_style: 'horror', created_at: day(6) }),
  world({ slug: 'hidden', genre: 'romance', moderation_status: 'hidden', created_at: day(7) }),
  world({ slug: 'pending', genre: 'romance', review_status: 'pending', created_at: day(8) }),
)
// A pre-backfill world genuinely has no key, not an explicit null.
delete worlds[5].genre

/**
 * The app as `src/index.ts` composes it: a parent instance whose global onError
 * answers a schema failure with 422, with the routes registered inside it. That
 * parent handler claims the error before any route-local handler can, which is
 * exactly the composition the 400 rule has to survive — testing the router on
 * its own cannot see it.
 */
const app = new Elysia()
  .onError(({ error, code, set }) => {
    if (error instanceof HttpError) {
      set.status = error.statusCode
      return { error: error.message, ...(error.details || {}) }
    }
    if (error instanceof ValidationError) {
      set.status = error.status
      return { error: VALIDATION_MESSAGE }
    }
    if (code === 'VALIDATION') {
      set.status = 422
      return { error: VALIDATION_MESSAGE }
    }
  })
  .get('/', () => 'Everlore API')
  .use(templateRoutes)

async function get(path: string) {
  const response = await app.handle(new Request(`http://localhost${path}`))
  return { status: response.status, body: await response.json().catch(() => null) as Row }
}

let passed = 0
let failed = 0
function check(name: string, run: () => void | Promise<void>) {
  return (async () => {
    try {
      await run()
      console.log(`  PASS ${name}`)
      passed++
    } catch (error) {
      console.error(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
      failed++
    }
  })()
}
const quiet = () => {}

// ── 1. Derivation for every voice ────────────────────────────────────────────
await check('every voice derives its contract shelf, independently of the implementation', () => {
  // The contract's mapping, restated here so an accidental change in the
  // implementation cannot mask itself.
  const familyGenre: Record<string, Genre> = {
    romance_charged: 'romance',
    epic_adventure: 'epic',
    atmospheric_dark: 'dark',
    modern_everyday: 'modern',
    cozy_playful: 'cozy',
  }
  for (const family of new Set(Object.values(STYLE_FAMILY))) {
    assert(isGenre(familyGenre[family]), `unmapped voice family ${family}`)
  }
  for (const { key } of NARRATIVE_STYLE_PRESETS) {
    const expected = key === 'horror' ? 'horror' : (familyGenre[STYLE_FAMILY[key]] ?? 'epic')
    assert.equal(deriveGenre(key), expected, key)
  }
  for (const value of ['', undefined, null, 'not-a-voice']) assert.equal(deriveGenre(value), 'epic')
  assert.equal(deriveGenre('default'), 'epic')
  for (const { key } of GENRES) assert(isGenre(key))
  assert.equal(isGenre('sci-fi'), false)
})

await check('a stored genre wins and a missing one derives', () => {
  assert.equal(resolveGenre('horror', 'epic_fantasy'), 'horror')
  assert.equal(resolveGenre(undefined, 'horror'), 'horror')
  assert.equal(resolveGenre(null, 'flirty'), 'romance')
  assert.equal(resolveGenre('nonsense', 'grimdark'), 'dark')
})

// ── 2. The For You interleave ────────────────────────────────────────────────
function interleaveFixture(perGenre: number) {
  const candidates = []
  for (const [genre, voice] of [
    ['romance', 'flirty'],
    ['epic', 'epic_fantasy'],
    ['dark', 'grimdark'],
    ['cozy', 'cozy_comfort'],
  ] as const) {
    for (let i = 0; i < perGenre; i++) {
      candidates.push({
        id: `${genre}-${i}`,
        genre,
        narrative_style: voice,
        created_at: day(1 + i),
      })
    }
  }
  return candidates
}

await check('For You never runs three of one genre while others remain and doubles picked genres', () => {
  const candidates = interleaveFixture(50)
  const ordered = forYouOrder(candidates, ['flirty'], new Date(Date.UTC(2026, 0, 5)))
  assert.equal(ordered.length, candidates.length)
  const genres = ordered.map((candidate) => resolveGenre(candidate.genre, candidate.narrative_style))
  for (let i = 2; i < genres.length; i++) {
    assert.equal(
      genres[i] === genres[i - 1] && genres[i] === genres[i - 2],
      false,
      `three ${genres[i]} in a row at ${i}`,
    )
  }
  // Five places per round, two of them the picked shelf. Any 25 emissions are
  // five whole rounds, so supply never runs dry mid-measurement.
  const counts = new Map<Genre, number>()
  for (const genre of genres.slice(0, 25)) counts.set(genre, (counts.get(genre) ?? 0) + 1)
  assert.equal(counts.get('romance'), 10)
  assert.equal(counts.get('epic'), 5)
  assert.equal(counts.get('dark'), 5)
  assert.equal(counts.get('cozy'), 5)
})

await check('For You is deterministic for a day and rotates its start on the next', () => {
  const candidates = interleaveFixture(4)
  const first = forYouOrder(candidates, [], new Date(Date.UTC(2026, 0, 5)))
  const again = forYouOrder(candidates, [], new Date(Date.UTC(2026, 0, 5)))
  assert.deepEqual(first.map((candidate) => candidate.id), again.map((candidate) => candidate.id))
  const next = forYouOrder(candidates, [], new Date(Date.UTC(2026, 0, 6)))
  assert.notEqual(first[0].id, next[0].id)
})

await check('a candidate without a stored genre still joins the feed by its voice', () => {
  const candidates = [
    { id: 'a', genre: undefined, narrative_style: 'horror', created_at: day(1) },
    { id: 'b', genre: undefined, narrative_style: 'flirty', created_at: day(2) },
  ]
  const ordered = forYouOrder(candidates, [], new Date(Date.UTC(2026, 0, 5)))
  assert.deepEqual(ordered.map((candidate) => candidate.id).sort(), ['a', 'b'])
  assert.equal(resolveGenre(undefined, 'horror'), 'horror')
})

// ── 3. Query validation and the server-side filters ──────────────────────────
await check('a bad genre, kind, style list or sort is a 400 on the app as composed in src/index.ts', async () => {
  // Both the bare path and the trailing-slash form the server logs as
  // route=/templates/ are exercised: the app reaches either.
  for (const path of ['/templates', '/templates/']) {
    for (const query of ['genre=sci-fi', 'kind=book', 'styles=horror,nope', 'styles=', 'sort=random', 'genre=Romance']) {
      const { status, body } = await get(`${path}?${query}`)
      assert.equal(status, 400, `${path}?${query}`)
      assert.equal(body?.error, VALIDATION_MESSAGE, `${path}?${query} leaks a value`)
    }
  }
  // The status must come from the request check, not from the schema path
  // happening to be 400; a valid query still lists.
  const ok = await get('/templates/?limit=1')
  assert.equal(ok.status, 200)
})

await check('kind and genre narrow the total, and the filters are applied by the server', async () => {
  const all = await get('/templates?limit=50')
  const characters = await get('/templates?kind=character&limit=50')
  const romance = await get('/templates?genre=romance&limit=50')
  const horror = await get('/templates?genre=horror&limit=50')
  const voices = await get('/templates?styles=grimdark&limit=50')
  const newest = await get('/templates?sort=new&limit=50')

  assert.equal(all.status, 200)
  assert.equal(all.body.total, 6, 'hidden and pending worlds stay out')
  assert.equal(characters.body.total, 2)
  assert.equal(romance.body.total, 2)
  assert.equal(horror.body.total, 1, 'a pre-backfill horror world still reaches its shelf')
  assert.equal(voices.body.total, 1)
  assert.equal(newest.body.total, 6)

  assert(characters.body.templates.every((template: Row) => template.kind === 'character'))
  assert(romance.body.templates.every((template: Row) => template.genre === 'romance'))
  assert(horror.body.templates.every((template: Row) => template.slug === 'horror-before-backfill'))
  assert(voices.body.templates.every((template: Row) => template.narrative_style === 'grimdark'))

  const ordered = newest.body.templates.map((template: Row) => template.created_at)
  assert.deepEqual(ordered, [...ordered].sort().reverse(), 'sort=new is plain recency')
  const mixed = await get('/templates?limit=50')
  assert.deepEqual(mixed.body.templates.map((template: Row) => template.slug).sort(),
    newest.body.templates.map((template: Row) => template.slug).sort(), 'For You is a reorder, not a filter')
})

await check('the public projection carries genre', async () => {
  const { body } = await get('/templates?genre=romance&limit=50')
  for (const template of body.templates) assert(Object.hasOwn(template, 'genre'))
})

await check('a world written before kind existed still reads as a world', async () => {
  const legacy = world({ slug: 'legacy-kind', genre: 'epic' })
  delete legacy.kind
  worlds.push(legacy)
  try {
    const asWorld = await get('/templates?kind=world&limit=50')
    assert(asWorld.body.templates.some((template: Row) => template.slug === 'legacy-kind'))
    const asCharacter = await get('/templates?kind=character&limit=50')
    assert.equal(asCharacter.body.templates.some((template: Row) => template.slug === 'legacy-kind'), false)
  } finally {
    worlds.splice(worlds.indexOf(legacy), 1)
  }
})

// ── 4. Shelf counts ──────────────────────────────────────────────────────────
await check('GET /templates/genres counts exactly the listed set, per kind and voice', async () => {
  const { status, body } = await get('/templates/genres')
  assert.equal(status, 200)
  assert.deepEqual(body.genres.map((genre: Row) => genre.key), GENRES.map(({ key }) => key))
  assert.deepEqual(body.genres.map((genre: Row) => genre.label), GENRES.map(({ label }) => label))

  type VoiceCounts = { worlds: number; characters: number }
  const expected: Record<string, { worlds: number; characters: number; styles: Record<string, VoiceCounts> }> = {
    romance: {
      worlds: 1, characters: 1,
      styles: { flirty: { worlds: 1, characters: 0 }, dark_romance: { worlds: 0, characters: 1 } },
    },
    epic: {
      worlds: 2, characters: 0,
      styles: { epic_fantasy: { worlds: 1, characters: 0 }, shonen: { worlds: 1, characters: 0 } },
    },
    dark: { worlds: 0, characters: 1, styles: { grimdark: { worlds: 0, characters: 1 } } },
    horror: { worlds: 1, characters: 0, styles: { horror: { worlds: 1, characters: 0 } } },
    modern: { worlds: 0, characters: 0, styles: {} },
    cozy: { worlds: 0, characters: 0, styles: {} },
  }
  for (const genre of body.genres) {
    assert.deepEqual(
      { worlds: genre.worlds, characters: genre.characters, styles: genre.styles },
      expected[genre.key],
      genre.key,
    )
    const list = await get(`/templates?genre=${genre.key}&limit=50`)
    assert.equal(genre.worlds + genre.characters, list.body.total, `${genre.key} count matches its list`)

    // Each per-kind voice count must be the list filtered by kind AND styles:
    // that is the number the sheet uses to hide an interest with no match.
    for (const [voice, counts] of Object.entries(genre.styles as Record<string, VoiceCounts>)) {
      for (const kind of ['world', 'character'] as const) {
        const filtered = await get(`/templates?genre=${genre.key}&kind=${kind}&styles=${voice}&limit=50`)
        const expectedCount = kind === 'world' ? counts.worlds : counts.characters
        assert.equal(filtered.body.total, expectedCount, `${genre.key}/${voice}/${kind}`)
        assert(
          filtered.body.templates.every((template: Row) =>
            template.narrative_style === voice && (kind === 'character'
              ? template.kind === 'character'
              : template.kind !== 'character')),
          `${genre.key}/${voice}/${kind} returns a world outside the filter`,
        )
      }
    }
    // The voices partition their shelf: nothing is counted twice or dropped.
    const voices = Object.values(genre.styles as Record<string, VoiceCounts>)
    assert.equal(voices.reduce((sum, counts) => sum + counts.worlds, 0), genre.worlds, `${genre.key} worlds`)
    assert.equal(voices.reduce((sum, counts) => sum + counts.characters, 0), genre.characters, `${genre.key} characters`)
  }
})

// ── 5. Review safety ─────────────────────────────────────────────────────────
await check('moving a world between shelves never sends it back to review', async () => {
  assert.equal((MEANINGFUL_WORLD_FIELDS as readonly string[]).includes('genre'), false)

  const approved = world({
    slug: 'approved-world', genre: 'epic', is_published: true, visibility: 'public', review_status: 'approved',
  })
  worlds.push(approved)
  await templateService.update(approved._id.toHexString(), approved.creator_id.toHexString(), { genre: 'cozy' })
  assert.equal(lastSet?.genre, 'cozy')
  assert.equal(lastSet?.review_status, undefined, 'a genre edit must not request review')
  assert.equal(approved.review_status, 'approved')

  // A pre-backfill world follows a voice change, but an authored genre is kept.
  const legacy = world({ slug: 'legacy-world', narrative_style: 'flirty' })
  delete legacy.genre
  worlds.push(legacy)
  await templateService.update(legacy._id.toHexString(), legacy.creator_id.toHexString(), { narrative_style: 'horror' })
  assert.equal(legacy.genre, 'horror')

  await templateService.update(approved._id.toHexString(), approved.creator_id.toHexString(), { narrative_style: 'grimdark' })
  assert.equal(approved.genre, 'cozy', 'an authored shelf survives a voice change')

  worlds.splice(worlds.indexOf(approved), 1)
  worlds.splice(worlds.indexOf(legacy), 1)
})

// ── 6. Backfill ──────────────────────────────────────────────────────────────
await check('the backfill reads catalog batches, writes only genre and updated_at, and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'everlore-genre-audit-'))
  try {
    await mkdir(join(root, 'romance'))
    await writeFile(join(root, 'romance', 'catalog-one.json'), JSON.stringify({ slug: 'catalog-one' }))
    const catalog = await readCatalogGenres([root])
    assert.equal(catalog.get('catalog-one'), 'romance')
    assert.deepEqual(await readCatalogGenres([join(root, 'romance')]), catalog, 'a single batch folder also works')

    const rows: BackfillWorld[] = [
      { _id: new ObjectId(), slug: 'catalog-one', narrative_style: 'horror' },
      { _id: new ObjectId(), slug: 'derived-romance', narrative_style: 'flirty' },
      { _id: new ObjectId(), slug: 'derived-dark', narrative_style: 'grimdark' },
    ]
    const runtime: BackfillRuntime = {
      findMissingGenre: async () => rows.filter((row) => matches(row, MISSING_GENRE_FILTER as Row)),
      setGenre: async (id, genre) => {
        const row = rows.find((entry) => entry._id.equals(id))!
        row.genre = genre
      },
    }

    const dry = await runBackfill({ apply: false, catalog }, runtime, quiet, day(9))
    const writesBeforeBackfill = writes
    assert.deepEqual(dry, {
      counts: { romance: 2, epic: 0, dark: 1, horror: 0, modern: 0, cozy: 0 },
      catalogMatches: 1,
      scanned: 3,
      written: 0,
    })
    assert(rows.every((row) => row.genre == null), 'a dry run writes nothing')

    const applied = await runBackfill({ apply: true, catalog }, runtime, quiet, day(9))
    assert.equal(applied.written, 3)
    assert.deepEqual(rows.map((row) => row.genre), ['romance', 'romance', 'dark'])
    assert.equal(writes, writesBeforeBackfill, 'the in-memory runtime did not touch the world collection')

    const second = await runBackfill({ apply: true, catalog }, runtime, quiet, day(10))
    assert.deepEqual(second, {
      counts: { romance: 0, epic: 0, dark: 0, horror: 0, modern: 0, cozy: 0 },
      catalogMatches: 0,
      scanned: 0,
      written: 0,
    })
    assert.equal(rows[0].genre, 'romance', 'a second run never rewrites an authored genre')
    assert.deepEqual(Object.keys(genreUpdate('romance', day(9)).$set).sort(), ['genre', 'updated_at'])
    // The selector is what makes a second run a no-op.
    assert.equal(matches({ genre: 'epic' }, MISSING_GENRE_FILTER as Row), false)
    assert.equal(matches({}, MISSING_GENRE_FILTER as Row), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('backfill CLI parses repeatable catalogs and rejects typos', () => {
  const options = parseOptions(['--', '--catalog', 'one', '--catalog', 'two', '--apply'])
  assert.equal(options.apply, true)
  assert.deepEqual(options.catalog.map((path) => path.split('/').pop()), ['one', 'two'])
  assert.throws(() => parseOptions(['--catalog']))
  assert.throws(() => parseOptions(['--aply']))
})

if (process.argv.includes('--sample')) {
  for (const path of [
    '/templates?limit=2',
    '/templates?genre=romance&limit=2',
    '/templates?kind=character&limit=2',
    '/templates?styles=flirty&limit=2',
    '/templates?sort=new&limit=2',
    '/templates/genres',
  ]) {
    const { status, body } = await get(path)
    console.log(`\nGET ${path} -> ${status}\n${JSON.stringify(body, null, 2)}`)
  }
}

console.log(`genre audit: ${passed}/${passed + failed} passed (in-memory world set; no environment, network or database)`)
process.exit(failed === 0 ? 0 : 1)
