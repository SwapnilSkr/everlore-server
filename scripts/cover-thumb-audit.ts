/**
 * COVER THUMB ON SAVE: every saved cover carries its 540 px WebP, and a backfill
 * gives one to the covers already stored.
 *
 * A full cover is up to 2048 px (~300 KB); four onboarding cards would pull
 * ~1.3 MB. `makeCoverThumb` makes the small copy, and every save site writes it
 * in the same write as the cover. This audit pins, with fakes only:
 *
 *   (a) `makeCoverThumb` chooses the `.w540.webp` sibling and uploads it as WebP;
 *   (b) an empty, default, foreign or non-WebP url is null — never a fetch, never
 *       an invented object;
 *   (c) a fetch, encode or upload failure is null and does not throw;
 *   (d) an oversized body is refused before decode;
 *   (e) `coverWrite` puts the key in the save only when one was made, and removes
 *       it otherwise — never an explicit null;
 *   (f) both save sites (creator update, admin update) go through `coverWrite`
 *       and `$unset` the key when there is none; create spreads it only when set;
 *   (g) the backfill's filter is our CDN + WebP + no thumb, and it writes nothing
 *       without `--apply`, fences every write on the cover, and a second run
 *       finds nothing;
 *   (h) each of these is shown to bite on a mutated copy.
 *
 *   bun --no-env-file run scripts/cover-thumb-audit.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'

const CDN = 'https://fixture.invalid'
mock.module('../src/config/env', () => ({ env: { CDN_BASE_URL: CDN } }))

const { makeCoverThumb, coverThumbKey, coverWrite, deleteReplacedThumb } = await import('../src/utils/cover-thumb')
const {
  backfillFilter, needsCoverThumb, parseOptions: parseBackfillOptions, runBackfill, thumbWrite,
} = await import('./backfill-cover-thumbs')

type Row = Record<string, unknown>
let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures++
    console.log(`FAIL ${name}: ${(error as Error).message}`)
  }
}

const cover = `${CDN}/media/cover.webp`
const thumb = `${CDN}/media/cover.w540.webp`
const defaultCover = `${CDN}/media/defaults/everlore-cover.webp`
const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

interface Seen { fetches: string[]; uploads: Array<{ key: string; type: string; bytes: number }>; encodes: number }
function deps(overrides: Row = {}) {
  const seen: Seen = { fetches: [], uploads: [], encodes: 0 }
  const base = {
    fetch: async (url: string) => { seen.fetches.push(url); return new Response(bytes, { status: 200 }) },
    encode: async () => { seen.encodes++; return bytes },
    upload: async (data: Buffer, type: string, opts: { key: string }) => {
      seen.uploads.push({ key: opts.key, type, bytes: data.length })
      return { url: `${CDN}/${opts.key}`, key: opts.key }
    },
    ...overrides,
  }
  return { seen, deps: base as never as Parameters<typeof makeCoverThumb>[1] }
}

// ── (a) the sibling key and the WebP upload ─────────────────────────────────
await check('(a) a cover gets its .w540.webp sibling, uploaded as WebP', async () => {
  const { seen, deps: injected } = deps()
  const url = await makeCoverThumb(cover, injected)
  assert.equal(url, thumb)
  assert.deepEqual(seen.fetches, [cover])
  assert.equal(seen.encodes, 1)
  assert.deepEqual(seen.uploads, [{ key: 'media/cover.w540.webp', type: 'image/webp', bytes: bytes.length }])
})

// ── (b) the four urls that can have no small copy ───────────────────────────
await check('(b) empty, default, foreign and non-WebP urls are null with no fetch', async () => {
  for (const url of ['', '   ', null, undefined, defaultCover, 'https://elsewhere.invalid/cover.webp', `${CDN}/media/cover.png`]) {
    const { seen, deps: injected } = deps()
    assert.equal(await makeCoverThumb(url as string, injected), null, `sent ${JSON.stringify(url)}`)
    assert.equal(seen.fetches.length, 0, `fetched for ${JSON.stringify(url)}`)
  }
  // The key it would use is the same test, exposed for the backfill.
  assert.equal(coverThumbKey(cover), 'media/cover.w540.webp')
  assert.equal(coverThumbKey(defaultCover), null)
  assert.equal(coverThumbKey(`${CDN}/media/cover.png`), null)
})

// ── (c) a step failing is null, never a throw ───────────────────────────────
await check('(c) a failed fetch, encode or upload is null and never throws', async () => {
  const cases: Array<[string, Row]> = [
    ['fetch throws', { fetch: async () => { throw new Error('network down') } }],
    ['fetch not ok', { fetch: async () => new Response('nope', { status: 404 }) }],
    ['encode throws', { encode: async () => { throw new Error('cannot decode') } }],
    ['upload throws', { upload: async () => { throw new Error('bucket refused') } }],
  ]
  for (const [name, override] of cases) {
    const { deps: injected } = deps(override)
    assert.equal(await makeCoverThumb(cover, injected), null, name)
  }
})

// ── (d) the bounded body ────────────────────────────────────────────────────
await check('(d) a declared body over the cap is refused before it is decoded', async () => {
  const { seen, deps: injected } = deps({
    fetch: async () => new Response(bytes, { status: 200, headers: { 'content-length': String(15 * 1024 * 1024 + 1) } }),
  })
  assert.equal(await makeCoverThumb(cover, injected), null)
  assert.equal(seen.encodes, 0, 'a too-large cover was decoded')
})

await check('(d) an undeclared body stops being read at the cap, so it is never decoded', async () => {
  // A wrong object behind a cover url, with no content-length to warn us.
  const chunk = new Uint8Array(1024 * 1024)
  let pulled = 0
  const { seen, deps: injected } = deps({
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        // 16 MB, one byte past the cap.
        if (pulled > 16) return controller.close()
        controller.enqueue(chunk)
      },
    }), { status: 200 }),
  })
  assert.equal(await makeCoverThumb(cover, injected), null)
  assert.equal(seen.encodes, 0, 'a too-large cover was decoded')
  assert.ok(pulled <= 17, `the whole body was read (${pulled} MB)`)
})

// ── (e) the field shaping both save sites share ─────────────────────────────
await check('(e) coverWrite sets the key only when a thumb exists, and unsets otherwise', async () => {
  const made = coverWrite(cover, thumb)
  assert.deepEqual(made.set, { image_url: cover, image_thumb_url: thumb })
  assert.deepEqual(made.unset, {})

  const none = coverWrite(cover, null)
  assert.deepEqual(none.set, { image_url: cover })
  assert.equal(Object.hasOwn(none.set, 'image_thumb_url'), false)
  assert.deepEqual(none.unset, { image_thumb_url: '' })
  // Never the explicit null that a client renders as a broken image.
  for (const write of [made, none]) {
    for (const value of Object.values(write.set)) assert.notEqual(value, null)
  }
})

await check('(e2) a replaced small copy is deleted best-effort, and the new one never is', async () => {
  const deleted: string[] = []
  const options = { keyFromUrl: (url: string) => url.startsWith(`${CDN}/`) ? url.slice(CDN.length + 1) : null, delete: (key: string) => { deleted.push(key) } }
  deleteReplacedThumb(`${CDN}/media/old.w540.webp`, thumb, options)
  assert.deepEqual(deleted, ['media/old.w540.webp'])
  deleteReplacedThumb(`${CDN}/media/old.w540.webp`, `${CDN}/media/old.w540.webp`, options)
  assert.deepEqual(deleted, ['media/old.w540.webp'], 'the copy just written was deleted')
  deleteReplacedThumb(defaultCover, thumb, options)
  assert.equal(deleted.length, 1, 'the shared default was deleted')
  deleteReplacedThumb(undefined, thumb, options)
  assert.equal(deleted.length, 1)
})

// ── (f) the save sites ─────────────────────────────────────────────────────
const templateSource = readFileSync(new URL('../src/services/template.service.ts', import.meta.url), 'utf8')
const adminSource = readFileSync(new URL('../src/services/admin.service.ts', import.meta.url), 'utf8')

/** What is wrong with one save site's cover write, as text, so a mutant tests it. */
function saveSiteProblems(source: string, site: 'create' | 'update' | 'admin'): string[] {
  const problems: string[] = []
  if (!source.includes('makeCoverThumb(')) problems.push('the site never makes a small copy')
  if (!source.includes('coverWrite(')) problems.push('the cover fields are shaped by hand, not by coverWrite')
  if (!/\$unset:\s*\{\s*image_thumb_url/.test(source)) problems.push('no $unset of image_thumb_url for a cover without one')
  if (site === 'create' && !/\.\.\.\(thumbUrl \? \{ image_thumb_url: thumbUrl \}/.test(source)) {
    problems.push('create writes image_thumb_url unconditionally')
  }
  if ((site === 'update' || site === 'admin') && !/deleteReplacedThumb\(existing\.image_thumb_url/.test(source)) {
    problems.push('the replaced small copy is left in the bucket')
  }
  return problems
}

await check('(f) create spreads the key only when a thumb was made', () => {
  const problems = saveSiteProblems(templateSource, 'create')
  assert.deepEqual(problems, [], problems.join('; '))
})

await check('(f) the creator update sets or unsets the key in the same write', () => {
  const problems = saveSiteProblems(templateSource, 'update')
  assert.deepEqual(problems, [], problems.join('; '))
})

await check('(f) the admin update sets or unsets the key in the same write', () => {
  const problems = saveSiteProblems(adminSource, 'admin')
  assert.deepEqual(problems, [], problems.join('; '))
})

// ── (g) the backfill ───────────────────────────────────────────────────────
await check('(g) the selection filter is our CDN, a WebP, not the default, and no small copy yet', () => {
  const filter = backfillFilter(CDN) as Record<string, unknown>
  const [pattern, notShared] = filter.$and as Array<Record<string, { $regex: string } | string>>
  const imageMatch = pattern.image_url as unknown as { $regex: string }
  assert.ok(imageMatch.$regex.startsWith(`^${CDN.replace(/\./g, '\\.')}/`), imageMatch.$regex)
  assert.ok(imageMatch.$regex.endsWith('\\.webp$'), imageMatch.$regex)
  const re = new RegExp(imageMatch.$regex)
  assert.ok(re.test(cover), 'a stored cover did not match')
  assert.equal(re.test(`${CDN}/media/cover.png`), false)
  assert.equal(re.test('https://elsewhere.invalid/cover.webp'), false)
  // The shared default matches the CDN+WebP regex, so it is excluded by its key.
  assert.ok(re.test(defaultCover), 'the default cover should match the regex')
  assert.deepEqual(notShared.image_url, { $ne: defaultCover })
  assert.deepEqual(filter.image_thumb_url, { $exists: false })
  // A base of nothing would make every cover look foreign, so it refuses.
  assert.throws(() => backfillFilter(''))
})

await check('(g) only a copyable cover is one the run picks up', () => {
  assert.equal(needsCoverThumb({ _id: new ObjectId(), image_url: cover }), true)
  for (const url of [undefined, '', defaultCover, `${CDN}/media/cover.png`, 'https://elsewhere.invalid/cover.webp']) {
    assert.equal(needsCoverThumb({ _id: new ObjectId(), image_url: url }), false, `sent ${JSON.stringify(url)}`)
  }
})

await check('(g) a write is fenced on the cover and touches only the small copy', () => {
  const write = thumbWrite(cover, thumb)
  assert.deepEqual(write.filter, { image_url: cover })
  assert.deepEqual(write.update, { $set: { image_thumb_url: thumb } })
})

/** The whole table, so a second pass over it is a real second run. */
function backfillRuntime(rows: Array<Row & { _id: ObjectId }>) {
  const writes: Array<{ id: string; image_url: string; thumb: string }> = []
  let thumbFor: (url: string) => string | null = (url) => url.replace(/\.webp$/, '.w540.webp')
  return {
    writes,
    runtime: {
      // The database narrowing, then the same predicate the script keeps.
      candidates: async (limit?: number) => {
        const filter = backfillFilter(CDN) as Record<string, unknown>
        const [pattern, notShared] = filter.$and as Array<Record<string, { $regex: string } | { $ne: string }>>
        const re = new RegExp((pattern.image_url as { $regex: string }).$regex)
        const excluded = (notShared.image_url as { $ne: string }).$ne
        const found = rows.filter((row) =>
          re.test(String(row.image_url)) && row.image_url !== excluded && !('image_thumb_url' in row))
        return (limit ? found.slice(0, limit) : found) as never
      },
      makeThumb: async (url: string) => thumbFor(url),
      setThumb: async (id: ObjectId, imageUrl: string, thumbUrl: string) => {
        const row = rows.find((candidate) => candidate._id.equals(id))
        // The fence: the cover must still be the one the copy was made from.
        if (!row || row.image_url !== imageUrl) return false
        row.image_thumb_url = thumbUrl
        writes.push({ id: id.toHexString(), image_url: imageUrl, thumb: thumbUrl })
        return true
      },
    },
  }
}

function table() {
  return [
    { _id: new ObjectId('000000000000000000000001'), title: 'Solo One', kind: 'world' as const, image_url: cover },
    { _id: new ObjectId('000000000000000000000002'), title: 'A Character', kind: 'character' as const, image_url: `${CDN}/media/hero.webp` },
    { _id: new ObjectId('000000000000000000000003'), title: 'A Group', kind: 'group' as const, image_url: `${CDN}/media/crew.webp` },
    { _id: new ObjectId('000000000000000000000004'), title: 'No Cover', kind: 'world' as const },
    { _id: new ObjectId('000000000000000000000005'), title: 'Shared Default', kind: 'world' as const, image_url: defaultCover },
    { _id: new ObjectId('000000000000000000000006'), title: 'Not Ours', kind: 'world' as const, image_url: 'https://elsewhere.invalid/cover.webp' },
    { _id: new ObjectId('000000000000000000000007'), title: 'Not WebP', kind: 'world' as const, image_url: `${CDN}/media/old.png` },
  ]
}

await check('(g) a dry run writes nothing, and reports every kind', async () => {
  const rows = table()
  const { runtime, writes } = backfillRuntime(rows)
  const lines: string[] = []
  const report = await runBackfill({ apply: false }, runtime, (text) => lines.push(text))
  assert.equal(report.candidates, 3, 'only rows with a copyable cover and no thumb are candidates')
  assert.deepEqual(report.perKind, { world: 1, character: 1, group: 1 })
  assert.equal(report.made, 0)
  assert.equal(writes.length, 0, 'a dry run wrote')
  assert.ok(lines[0].startsWith('[dry run]'), lines[0])
  assert.ok(lines.some((line) => line.includes('Solo One')), 'the first titles are not listed')
})

await check('(g) --apply writes each small copy, and a second run finds nothing', async () => {
  const rows = table()
  const { runtime, writes } = backfillRuntime(rows)
  const first = await runBackfill({ apply: true }, runtime, () => {})
  assert.equal(first.made, 3)
  assert.equal(first.skipped, 0)
  assert.equal(first.failed, 0)
  assert.equal(writes.length, 3)
  assert.deepEqual(writes.map((write) => write.thumb), [
    `${CDN}/media/cover.w540.webp`, `${CDN}/media/hero.w540.webp`, `${CDN}/media/crew.w540.webp`,
  ])
  // Never an explicit null, and nothing else on the row.
  for (const row of rows) {
    if ('image_thumb_url' in row) assert.equal(typeof row.image_thumb_url, 'string')
  }
  const second = await runBackfill({ apply: true }, runtime, () => {})
  assert.equal(second.candidates, 0, 'the second run still found work')
  assert.equal(second.made, 0)
  assert.equal(writes.length, 3)
})

await check('(g) a cover changed while the copy was made is skipped, not overwritten', async () => {
  const rows = table()
  const { runtime, writes } = backfillRuntime(rows)
  runtime.makeThumb = async (url: string) => {
    // Someone re-picks the cover in the middle of the run.
    rows[0]!.image_url = `${CDN}/media/newer.webp`
    return url.replace(/\.webp$/, '.w540.webp')
  }
  const report = await runBackfill({ apply: true }, runtime, () => {})
  assert.equal(report.skipped, 1)
  assert.equal(report.made, 2)
  assert.equal(writes.length, 2)
  assert.equal(writes.some((write) => write.id === rows[0]!._id.toHexString()), false)
  assert.equal('image_thumb_url' in rows[0]!, false, 'the changed cover got a stale copy')
})

await check('(g) a failed copy is counted, and its row keeps no key', async () => {
  const rows = table()
  const { runtime } = backfillRuntime(rows)
  runtime.makeThumb = async () => null
  const report = await runBackfill({ apply: true }, runtime, () => {})
  assert.equal(report.failed, 3)
  assert.equal(report.made, 0)
  assert.equal('image_thumb_url' in rows[0]!, false)
})

await check('(g) --limit narrows the table, and the flags are parsed', () => {
  assert.deepEqual(parseBackfillOptions(['--apply', '--limit', '5']), { apply: true, limit: 5 })
  assert.deepEqual(parseBackfillOptions([]), { apply: false })
  assert.throws(() => parseBackfillOptions(['--limit', '0']))
  assert.throws(() => parseBackfillOptions(['--limit', 'many']))
  assert.throws(() => parseBackfillOptions(['--all']))
})

// ── (h) every check above bites on a mutated copy ───────────────────────────
await check('bite: (e) a hand-shaped write that keeps the stale key fails (e)', () => {
  // The mutation the save sites must never make: keep the old key when none
  // was made. `coverWrite` has no way to say that, and a hand-shaped object
  // would leave `image_thumb_url` describing the previous cover.
  const wrong = { set: { image_url: cover }, unset: {} }
  const expected = coverWrite(cover, null)
  assert.notDeepEqual(wrong, expected)
  assert.deepEqual(expected.unset, { image_thumb_url: '' })
})

await check('bite: (f) a save site that dropped its $unset is rejected', () => {
  const broken = templateSource.replace(
    "dropThumb\n        ? { $set: updateFields, $unset: { image_thumb_url: '' as const } }\n        : { $set: updateFields },",
    '{ $set: updateFields },',
  )
  assert.notEqual(broken, templateSource, 'the update anchor moved; update this audit')
  assert.ok(saveSiteProblems(broken, 'update').includes('no $unset of image_thumb_url for a cover without one'))
})

await check('bite: (f) an admin site that stopped making a copy is rejected', () => {
  const broken = adminSource.replace('await makeCoverThumb(imageUrl)', 'null')
  assert.notEqual(broken, adminSource, 'the admin anchor moved; update this audit')
  assert.ok(saveSiteProblems(broken, 'admin').includes('the site never makes a small copy'))
})

await check('bite: (f) a create site that wrote the key unconditionally is rejected', () => {
  const broken = templateSource.replace(
    '...(thumbUrl ? { image_thumb_url: thumbUrl } : {}),',
    'image_thumb_url: thumbUrl,',
  )
  assert.notEqual(broken, templateSource, 'the create anchor moved; update this audit')
  assert.ok(saveSiteProblems(broken, 'create').length > 0)
})

await check('bite: (b) a plan that accepts a foreign url is rejected', () => {
  const brokenThumbKey = (url: string | null | undefined) => {
    // No CDN check: any url, an invented sibling.
    return url && url.trim() ? url.trim().replace(/\.webp$/, '.w540.webp') : null
  }
  assert.equal(brokenThumbKey('https://elsewhere.invalid/cover.webp'), 'https://elsewhere.invalid/cover.w540.webp')
  assert.equal(coverThumbKey('https://elsewhere.invalid/cover.webp'), null)
})

await check('bite: (g) a filter without the thumb clause is rejected', () => {
  const broken = { image_url: { $regex: `^${CDN}/\\.webp$` } }
  assert.notDeepEqual(broken, backfillFilter(CDN))
  assert.equal('image_thumb_url' in broken, false)
})

console.log(failures === 0 ? '\ncover-thumb: ALL GREEN' : `\ncover-thumb: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
