import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { mock } from 'bun:test'
import { ObjectId } from 'mongodb'
import sharp from 'sharp'
import type { UserDoc, UserInsertDoc } from '../src/models/user.model'
import type { WorldTemplateDoc } from '../src/models/world-template.model'
import { parseOptions, readCatalog, runCatalog, validateEntry, type Runtime } from './seed-catalog'

// These maps are the entire database. Importing an environment or connecting a
// client is an audit failure, even if the test host happens to have credentials.
const users: UserDoc[] = [], worlds: WorldTemplateDoc[] = []
const objects = new Map<string, Buffer>()
let writes = 0, uploads = 0, casts = 0, embeddings = 0, approvals = 0
const unavailable = (): never => { throw new Error('External dependency reached in seed audit') }
type Row = Record<string, unknown>
function equal(a: unknown, b: unknown): boolean {
  return a instanceof ObjectId && b instanceof ObjectId ? a.equals(b) : isDeepStrictEqual(a, b)
}
function matches(row: Row, query: Row): boolean {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$or') return (value as Row[]).some(part => matches(row, part))
    if (value && typeof value === 'object' && '$exists' in value) return Object.hasOwn(row, key) === value.$exists
    return equal(row[key], value)
  })
}
function collection<T extends object>(rows: T[]) {
  return {
    findOne: async (query: Row) => rows.find(row => matches(row as Row, query)) || null,
    insertOne: async (doc: T) => { writes++; rows.push(doc); return { insertedId: (doc as Row)._id } },
    updateOne: async (query: Row, update: { $set?: Row; $unset?: Row }) => {
      const row = rows.find(row => matches(row as Row, query))
      if (!row) return { matchedCount: 0 }
      writes++
      Object.assign(row, update.$set)
      for (const key of Object.keys(update.$unset || {})) delete (row as Row)[key]
      return { matchedCount: 1 }
    },
    findOneAndUpdate: async (query: Row, update: { $set?: Row; $unset?: Row }) => {
      const row = rows.find(row => matches(row as Row, query))
      if (!row) return null
      writes++; approvals++
      Object.assign(row, update.$set)
      for (const key of Object.keys(update.$unset || {})) delete (row as Row)[key]
      return row
    },
  }
}
mock.module('../src/config/env', () => ({ env: new Proxy({ CDN_BASE_URL: 'https://fixture.invalid' }, {
  get: (target, key) => { if (key === 'CDN_BASE_URL') return target.CDN_BASE_URL; return unavailable() },
}) }))
mock.module('../src/config/mongo', () => ({ mongoColl: { users: () => collection(users), worldTemplates: () => collection(worlds) } }))
mock.module('../src/services/vector-store', () => ({ vectorStore: { replaceLore: async () => {} } }))
mock.module('../src/ai', () => ({ embed: async () => { embeddings++; return [0.1] }, generateImage: unavailable }))
mock.module('../src/utils/protagonist', () => ({ deriveProtagonist: unavailable }))
mock.module('../worker/lib/template-cast-extractor', () => ({ extractTemplateCast: async () => { casts++; return [{ name: 'Fixture Cast', persona: 'An adult traveller.' }] } }))
mock.module('../src/services/moderation.service', () => ({ moderationService: {} }))
mock.module('../src/services/deletion.service', () => ({ deletionService: {} }))
mock.module('../src/services/pinecone-cleanup.service', () => ({ deletePineconeVector: unavailable }))
mock.module('../src/providers/auth.provider', () => ({ sendPhoneOtp: unavailable, verifyPhoneOtp: unavailable }))
mock.module('../src/providers/firebase-auth.provider', () => ({ verifyFirebaseIdToken: unavailable }))
mock.module('../src/utils/can-forge', () => ({ canForge: unavailable }))
mock.module('../src/services/storage.service', () => ({ storageService: {
  upload: async (data: Buffer, type: string, opts: { prefix: string }) => {
    assert.equal(type, 'image/webp'); assert.equal(opts.prefix, 'previews')
    writes++; uploads++
    const url = `https://fixture.invalid/previews/${uploads}.webp`
    objects.set(url, data)
    return { url, key: `previews/${uploads}.webp` }
  },
  promote: async (url: string) => {
    if (!url.includes('/previews/')) return url
    writes++
    const target = url.replace('/previews/', '/media/')
    objects.set(target, objects.get(url)!)
    return target
  },
  keyFromUrl: (url: string) => new URL(url).pathname.slice(1),
  delete: async () => {},
} }))
const { templateService } = await import('../src/services/template.service')
const { imageService } = await import('../src/services/image.service')
const { adminService } = await import('../src/services/admin.service')
const { defaultUserPreferences } = await import('../src/services/auth.service')
const runtime: Runtime = {
  findUsers: async () => users.filter(user => /^everlore$/i.test(user.username)),
  insertUser: async (doc: UserInsertDoc) => { writes++; const user = { ...doc, _id: new ObjectId() }; users.push(user); return user },
  findSlug: async slug => worlds.find(world => world.slug === slug) || null,
  findTitle: async (owner, title) => worlds.find(world => world.creator_id.equals(owner) && world.title === title) || null,
  readCover: async url => { const image = objects.get(url); if (!image) throw new Error('Missing fixture cover'); return image },
  defaults: defaultUserPreferences,
  upload: imageService.uploadUserImage.bind(imageService),
  create: templateService.create.bind(templateService), update: templateService.update.bind(templateService),
  publish: templateService.publish.bind(templateService), approve: id => adminService.reviewWorld(id, 'approved', 'catalog-seed'),
  get: async id => worlds.find(world => world._id.toHexString() === id) || null,
}
const root = await mkdtemp(join(tmpdir(), 'everlore-seed-audit-'))
const catalog = join(root, 'catalog'), covers = join(root, 'covers')
await mkdir(catalog); await mkdir(covers)
const options = { catalog, covers, apply: true, allowDefaultCover: false }
const character = {
  slug: 'fixture-character', cover: 'character.png', title: 'Fixture Character', description: 'An adult guide awaits.',
  kind: 'character', is_sentient: true, is_nsfw_capable: false, seed_prompt: 'You are an adult guide to this quiet valley.',
  global_lore: 'The guide is thirty years old.', narrative_style: 'cozy_comfort', genre: 'romance',
  protagonist: { name: 'Fixture Guide', persona: 'An adult guide.', appearance: 'A blue cloak.' },
  opening_line: 'Welcome to the valley.', base_stats_template: {}, image_prompt: 'A valley guide.',
}
const world = {
  ...character, slug: 'fixture-world', cover: 'world.png', title: 'Different Initial Title', kind: 'world', is_sentient: false,
  protagonist: undefined, base_stats_template: { resolve: { default: 5, min: 0, max: 10, description: 'Resolve' } },
}
const save = (name: string, value: unknown) => writeFile(join(catalog, `${name}.json`), JSON.stringify(value))
const snapshot = () => JSON.stringify({ users, worlds, objects: [...objects], writes, uploads, casts, embeddings, approvals })
const quiet = () => {}
let passed = 0
async function check(name: string, run: () => Promise<void> | void) {
  await run(); passed++; console.log(`PASS ${name}`)
}
try {
  const png = await sharp({ create: { width: 16, height: 24, channels: 3, background: '#778899' } }).png().toBuffer()
  await writeFile(join(covers, 'character.png'), png); await writeFile(join(covers, 'world.png'), png)
  await save('character', character); await save('world', world)
  await check('dry run plans creates and writes nothing, including no account', async () => {
    const before = snapshot()
    assert.deepEqual((await runCatalog({ ...options, apply: false }, runtime, quiet)).map(r => r.outcome), ['create', 'create'])
    assert.equal(snapshot(), before)
  })
  await check('first run creates N public approved worlds owned by non-login Everlore via real services', async () => {
    const result = await runCatalog(options, runtime, quiet)
    assert.deepEqual(result.map(r => r.outcome), ['create', 'create'])
    assert.equal(worlds.length, 2); assert.equal(users.length, 1)
    assert.equal(users[0].username, 'Everlore'); assert.equal(users[0].preferences.player_name, 'Everlore')
    assert.equal(users[0].password_hash, ''); assert.deepEqual(users[0].providers, [])
    for (const field of ['email', 'phone', 'google_sub', 'firebase_uid']) assert.equal(Object.hasOwn(users[0], field), false)
    assert.equal(users[0].tier, 'creator')
    for (const stored of worlds) {
      assert(stored.creator_id.equals(users[0]._id)); assert.equal(stored.is_published, true)
      assert.equal(stored.visibility, 'public'); assert.equal(stored.review_status, 'approved'); assert.equal(stored.reviewed_by, 'catalog-seed')
      assert.equal(stored.seed_cast?.[0].name, 'Fixture Cast'); assert(stored.image_url?.includes('/media/'))
      // An authored genre reaches the world even though its voice is cozy.
      assert.equal(stored.genre, 'romance'); assert.equal(Object.hasOwn(stored, 'cover'), false)
    }
    assert.equal(uploads, 2); assert(casts >= 2); assert(embeddings >= 2); assert.equal(approvals, 2)
    assert(worlds.some(stored => stored.slug === 'fixture-world' && stored.title === 'Different Initial Title'))
  })
  await check('second run is all unchanged and byte-identical with zero writes or model/storage calls', async () => {
    const before = snapshot()
    assert.deepEqual((await runCatalog(options, runtime, quiet)).map(r => r.outcome), ['unchanged', 'unchanged'])
    assert.equal(snapshot(), before)
  })
  await check('one edited file (including title) gives exactly one update that ends approved', async () => {
    await save('character', { ...character, title: 'A Renamed Character', description: 'A changed adult guide awaits.' })
    const oldId = worlds.find(w => w.slug === character.slug)!._id.toHexString()
    const beforeApprovals = approvals
    const results = await runCatalog(options, runtime, quiet)
    assert.deepEqual(results.map(r => r.outcome), ['update', 'unchanged'])
    assert.equal(worlds.length, 2); assert.equal(results[0].id, oldId)
    assert.equal(worlds.find(w => w.slug === character.slug)!.review_status, 'approved'); assert.equal(approvals, beforeApprovals + 1)
    assert.deepEqual((await runCatalog(options, runtime, quiet)).map(r => r.outcome), ['unchanged', 'unchanged'])
  })
  await check('a sentient world fails validation before any write, even outside --only', async () => {
    await save('world', { ...world, is_sentient: true })
    const before = snapshot()
    await assert.rejects(runCatalog({ ...options, only: [character.slug] }, runtime, quiet), /only GM worlds/)
    assert.equal(snapshot(), before); await save('world', world)
  })
  await check('a missing cover skips with no account/world writes; default cover requires explicit override', async () => {
    const missing = { ...character, slug: 'fixture-missing', title: 'Missing Cover', cover: 'missing.png' }
    await save('missing', missing)
    const before = snapshot()
    assert.deepEqual((await runCatalog({ ...options, only: [missing.slug] }, runtime, quiet)).map(r => r.outcome), ['skip (no cover)'])
    assert.equal(snapshot(), before)
    assert.equal((await runCatalog({ ...options, only: [missing.slug], allowDefaultCover: true }, runtime, quiet))[0].outcome, 'create')
    assert.equal(worlds.find(w => w.slug === missing.slug)!.image_url, 'https://fixture.invalid/media/defaults/everlore-cover.webp')
  })
  await check('changed cover updates once through normalization and promotion', async () => {
    const image = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#ccbb00' } }).png().toBuffer()
    await writeFile(join(covers, 'world.png'), image)
    const before = uploads
    assert.equal((await runCatalog({ ...options, only: [world.slug] }, runtime, quiet))[0].outcome, 'update')
    assert.equal(uploads, before + 1)
    assert.equal((await runCatalog({ ...options, only: [world.slug] }, runtime, quiet))[0].outcome, 'unchanged')
  })
  await check('foreign ownership and occupied official identity fail closed', async () => {
    const stored = worlds.find(w => w.slug === world.slug)!, owner = stored.creator_id
    stored.creator_id = new ObjectId()
    try { await assert.rejects(runCatalog(options, runtime, quiet), /another creator/) } finally { stored.creator_id = owner }
    users[0].email = 'fixture@example.invalid'
    try { await assert.rejects(runCatalog(options, runtime, quiet), /sign-in capable/) } finally { delete users[0].email }
  })
  await check('field limits, kind requirements, stats, style, duplicate keys/titles and bad images gate writes', async () => {
    for (const patch of [
      { title: 'x'.repeat(81) }, { description: 'x'.repeat(601) }, { seed_prompt: 'short' }, { seed_prompt: 'x'.repeat(2501) },
      { global_lore: 'x'.repeat(3001) }, { opening_line: 'x'.repeat(601) }, { image_prompt: 'x'.repeat(1401) }, { style_notes: 'x'.repeat(501) },
      { protagonist: { name: 'x'.repeat(81) } }, { protagonist: { name: 'Guide', persona: 'x'.repeat(401) } },
      { protagonist: { name: 'Guide', appearance: 'x'.repeat(401) } }, { protagonist: {} }, { narrative_style: 'unknown' },
      { genre: 'sci-fi' }, { genre: 'Romance' },
      { kind: 'world', is_sentient: false, base_stats_template: {} }, { creator_id: new ObjectId() }, { cover: '../secret.png' },
    ]) assert.throws(() => validateEntry({ ...character, ...patch }, 'fixture'))
    const before = snapshot()
    await save('duplicate', { ...character, slug: world.slug })
    await assert.rejects(runCatalog(options, runtime, quiet), /Duplicate/)
    await save('duplicate', { ...world, slug: 'different-key' })
    await assert.rejects(runCatalog(options, runtime, quiet), /Duplicate/)
    await rm(join(catalog, 'duplicate.json'))
    await writeFile(join(covers, 'world.png'), 'invalid image')
    await assert.rejects(runCatalog(options, runtime, quiet))
    assert.equal(snapshot(), before)
  })
  await check('a catalog file without a genre seeds the one its voice implies', () => {
    const { genre, ...voiced } = character
    assert.equal(validateEntry(voiced, 'fixture').body.genre, 'cozy')
    assert.equal(validateEntry({ ...voiced, genre: 'romance' }, 'fixture').body.genre, 'romance')
  })
  await check('CLI parsing supports Bun separator and rejects typos', () => {
    assert.deepEqual(parseOptions(['--', '--catalog', catalog, '--covers', covers, '--only', 'a,b']).only, ['a', 'b'])
    assert.throws(() => parseOptions(['--catalog', catalog, '--covers', covers, '--aply']))
  })
  if (process.argv.includes('--catalog-fixtures')) {
    const launch = join(import.meta.dir, '../../everlore-docs/launch/catalog/romance')
    const real = await readCatalog({ ...options, catalog: launch, covers: join(root, 'absent') })
    assert.equal(real.length, 25)
    console.log(`PASS launch romance validation: ${real.length} files`)
  }
  console.log(`seed-catalog audit: ${passed}/${passed} passed (isolated in-memory DB; no environment, network or paid calls)`)
} finally { await rm(root, { recursive: true, force: true }) }
