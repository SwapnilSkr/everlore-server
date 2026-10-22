import { readdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Value } from '@sinclair/typebox/value'
import type { Static } from '@sinclair/typebox'
import { MongoClient, ObjectId } from 'mongodb'
import sharp from 'sharp'
import { CreateTemplateBody } from '../src/schemas/template.schema'
import { NARRATIVE_STYLE_PRESETS } from '../src/utils/narrative-styles'
import { deriveGenre } from '../src/utils/genre'
import { encodeUserImage } from '../src/utils/image-encoding'
import type { UserDoc, UserInsertDoc } from '../src/models/user.model'
import type { WorldTemplateDoc } from '../src/models/world-template.model'

type Body = Static<typeof CreateTemplateBody>
export type Options = { catalog: string; covers: string; apply: boolean; only?: string[]; allowDefaultCover: boolean }
export type Entry = { slug: string; cover: string; body: Body; image?: Buffer; normalized?: Buffer }
type Outcome = 'create' | 'update' | 'unchanged' | 'skip (no cover)'
export type Result = { slug: string; outcome: Outcome; id?: string; image_url?: string }
export interface Runtime {
  findUsers(): Promise<UserDoc[]>
  insertUser(doc: UserInsertDoc): Promise<UserDoc>
  findSlug(slug: string): Promise<WorldTemplateDoc | null>
  findTitle(owner: ObjectId, title: string): Promise<WorldTemplateDoc | null>
  readCover(url: string): Promise<Buffer>
  defaults(): UserDoc['preferences']
  upload(file: File): Promise<{ url: string }>
  create(owner: string, data: Body): Promise<WorldTemplateDoc>
  update(id: string, owner: string, data: Record<string, unknown>): Promise<WorldTemplateDoc>
  publish(id: string, owner: string, visibility: 'public'): Promise<unknown>
  approve(id: string): Promise<unknown>
  get(id: string): Promise<WorldTemplateDoc | null>
}

export function parseOptions(args: string[]): Options {
  const options: Options = { catalog: '', covers: '', apply: false, allowDefaultCover: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') continue
    if (arg === '--apply') options.apply = true
    else if (arg === '--allow-default-cover') options.allowDefaultCover = true
    else if (['--catalog', '--covers', '--only'].includes(arg)) {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
      if (arg === '--only') options.only = value.split(',')
      else if (arg === '--catalog') options.catalog = resolve(value)
      else options.covers = resolve(value)
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!options.catalog || !options.covers) throw new Error('Usage: --catalog <dir> --covers <dir> [--apply] [--only <slug,...>] [--allow-default-cover]')
  return options
}

export function validateEntry(raw: unknown, filename: string): Entry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${filename}: expected an object`)
  const { slug, cover, ...body } = raw as Record<string, unknown>
  const fail = (message: string): never => { throw new Error(`${filename}: ${message}`) }
  if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) fail('invalid slug')
  if (typeof cover !== 'string' || !cover || basename(cover) !== cover || /[\\/]/.test(cover) || !/\.(png|jpe?g|webp|heic|heif)$/i.test(cover)) fail('cover must be a file name')
  for (const key of Object.keys(body)) {
    if (!Object.hasOwn(CreateTemplateBody.properties, key)) fail(`unknown field ${key}`)
  }
  if (!Value.Check(CreateTemplateBody, body)) {
    fail([...Value.Errors(CreateTemplateBody, body)].map(e => `${e.path}: ${e.message}`).join('; '))
  }
  const data = body as Body
  if (!data.title.trim() || !data.description.trim() || data.seed_prompt.trim().length < 10) fail('title, description and seed_prompt must contain text')
  if (!data.kind) fail('kind is required')
  if (data.is_sentient !== (data.kind === 'character')) fail('only GM worlds and sentient characters are allowed')
  if (data.kind === 'character' && !data.protagonist?.name.trim()) fail('character requires protagonist.name')
  if (!NARRATIVE_STYLE_PRESETS.some(style => style.key === data.narrative_style)) fail('unknown narrative_style')
  if (data.image_url !== undefined) fail('use cover instead of image_url')
  if (data.kind === 'world' && !Object.keys(data.base_stats_template || {}).length) fail('world requires at least one stat')
  const stats = new Set<string>()
  for (const [key, stat] of Object.entries(data.base_stats_template || {})) {
    const normalized = key.trim().toLowerCase().replace(/\s+/g, '_')
    if (!normalized || stats.has(normalized) || ![stat.min, stat.max, stat.default].every(Number.isFinite) ||
      stat.min >= stat.max || stat.default < stat.min || stat.default > stat.max || !stat.description.trim()) fail(`invalid stat ${key}`)
    stats.add(normalized)
  }
  if (data.opening_line !== undefined) data.opening_line = data.opening_line.trim()
  // A file without an authored genre seeds the one its voice implies, so a
  // re-run compares like for like instead of seeing a change every time.
  data.genre ??= deriveGenre(data.narrative_style)
  return { slug: slug as string, cover: cover as string, body: data }
}

export async function readCatalog(options: Options): Promise<Entry[]> {
  const entries: Entry[] = []
  async function visit(dir: string) {
    for (const file of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, file.name)
      if (file.isDirectory()) await visit(path)
      else if (file.isFile() && file.name.endsWith('.json')) entries.push(validateEntry(JSON.parse(await readFile(path, 'utf8')), path))
    }
  }
  await visit(options.catalog)
  if (!entries.length) throw new Error('Catalog contains no JSON files')
  const slugs = new Set<string>(), titles = new Set<string>()
  for (const entry of entries) {
    const title = entry.body.title.trim().toLowerCase()
    if (slugs.has(entry.slug) || titles.has(title)) throw new Error(`Duplicate slug or title: ${entry.slug}`)
    slugs.add(entry.slug); titles.add(title)
    try {
      entry.image = await readFile(join(options.covers, entry.cover))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // Validate every available cover before account creation or any storage write.
    if (entry.image) {
      if (!entry.image.length || entry.image.length > 15 * 1024 * 1024) throw new Error(`${entry.slug}: cover must be 1 byte–15 MB`)
      const image = sharp(entry.image, { limitInputPixels: 40_000_000 }).rotate()
      if (!['jpeg', 'png', 'webp', 'heif'].includes((await image.metadata()).format || '')) throw new Error(`${entry.slug}: unsupported image`)
      entry.normalized = await encodeUserImage(image)
    }
  }
  for (const slug of options.only || []) if (!slugs.has(slug)) throw new Error(`Unknown --only slug: ${slug}`)
  return entries.filter(entry => !options.only || options.only.includes(entry.slug))
}

function assertOfficial(user: UserDoc) {
  // An email would let Google sign-in attach a provider to this account.
  if (user.username !== 'Everlore' || user.password_hash !== '' || user.providers.length ||
    user.email !== undefined || user.phone !== undefined || user.google_sub !== undefined || user.firebase_uid !== undefined ||
    user.account_status === 'banned' || user.preferences.player_name !== 'Everlore') {
    throw new Error('Reserved Everlore identity is occupied or sign-in capable; refusing to adopt it')
  }
}

export async function runCatalog(options: Options, runtime: Runtime, log: (text: string) => void = console.log): Promise<Result[]> {
  const entries = await readCatalog(options)
  const accounts = await runtime.findUsers()
  if (accounts.length > 1) throw new Error('Ambiguous Everlore account identity')
  let owner = accounts[0]
  if (owner) assertOfficial(owner)
  const plan: { entry: Entry; existing: WorldTemplateDoc | null; outcome: Outcome; imageChanged: boolean }[] = []
  for (const entry of entries) {
    const existing = await runtime.findSlug(entry.slug)
    if (existing && (!owner || !existing.creator_id.equals(owner._id))) throw new Error(`${entry.slug}: slug belongs to another creator`)
    if (!existing && owner && await runtime.findTitle(owner._id, entry.body.title)) throw new Error(`${entry.slug}: existing title has a different slug; manual reconciliation required`)
    if (existing?.moderation_status === 'hidden') throw new Error(`${entry.slug}: world is moderated; manual review required`)
    const imageChanged = !!entry.normalized && (!existing?.image_url || !entry.normalized.equals(await runtime.readCover(existing.image_url)))
    const changed = existing && Object.entries(entry.body).some(([key, value]) => !isDeepStrictEqual(existing[key as keyof WorldTemplateDoc], value))
    const live = existing?.is_published && existing.visibility === 'public' && existing.review_status === 'approved'
    const outcome: Outcome = !entry.image && !options.allowDefaultCover ? 'skip (no cover)' : !existing ? 'create' : changed || imageChanged || !live ? 'update' : 'unchanged'
    plan.push({ entry, existing, outcome, imageChanged })
  }
  if (options.apply && !owner && plan.some(p => p.outcome === 'create')) {
    const now = new Date()
    owner = await runtime.insertUser({
      username: 'Everlore', password_hash: '', providers: [], tier: 'creator',
      preferences: { ...runtime.defaults(), player_name: 'Everlore' }, token_balance: 0,
      created_at: now, updated_at: now,
    })
  }
  const results: Result[] = []
  for (const item of plan) {
    const { entry, outcome } = item
    let world = item.existing
    if (options.apply && (outcome === 'create' || outcome === 'update')) {
      if (!owner) throw new Error('Official account missing')
      const ownerId = owner._id.toHexString()
      const data: Record<string, unknown> = { ...entry.body }
      if (item.imageChanged && entry.image) data.image_url = (await runtime.upload(new File([new Uint8Array(entry.image)], entry.cover))).url
      if (!world) {
        world = await runtime.create(ownerId, data as Body)
        // create owns slug derivation; update stores the stable authored key and
        // applies fields (e.g. model_preferences) that create currently defaults.
        world = await runtime.update(world._id.toHexString(), ownerId, { ...data, slug: entry.slug, image_url: world.image_url })
      } else {
        world = await runtime.update(world._id.toHexString(), ownerId, data)
      }
      const id = world._id.toHexString()
      if (!world.image_url || new URL(world.image_url).pathname.includes('/previews/')) throw new Error(`${entry.slug} (${id}): cover promotion failed`)
      await runtime.publish(id, ownerId, 'public')
      world = await runtime.get(id)
      if (!world || !world.creator_id.equals(owner._id)) throw new Error(`${entry.slug}: ownership changed before approval`)
      if (world.review_status === 'pending') await runtime.approve(id)
      world = await runtime.get(id)
      if (!world || !world.creator_id.equals(owner._id) || world.slug !== entry.slug || !world.is_published || world.visibility !== 'public' || world.review_status !== 'approved') throw new Error(`${entry.slug}: publication verification failed`)
    }
    const result = { slug: entry.slug, outcome, ...(world ? { id: world._id.toHexString(), image_url: world.image_url } : {}) }
    results.push(result)
    log(`${options.apply ? '' : '[dry-run] '}${entry.slug}: ${outcome}${result.id ? ` id=${result.id} image=${result.image_url}` : ''}`)
  }
  const counts = Object.fromEntries(['create', 'update', 'unchanged', 'skip (no cover)'].map(outcome => [outcome, results.filter(r => r.outcome === outcome).length]))
  log(`Summary: ${JSON.stringify(counts)}`)
  return results
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  // Preflight files even before connecting. No implicit localhost/prod default.
  await readCatalog(options)
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI must be supplied in the process environment')
  if (options.apply) {
    const required = ['S3_BUCKET', 'CDN_BASE_URL', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'PINECONE_API_KEY']
    const missing = required.filter(key => !process.env[key])
    if (missing.length) throw new Error(`Apply requires process environment variables: ${missing.join(', ')}`)
  }
  const client = new MongoClient(process.env.MONGODB_URI)
  await client.connect()
  try {
    const db = client.db()
    const runtime: Runtime = {
      findUsers: () => db.collection<UserDoc>('users').find({ username: /^everlore$/i }).toArray(),
      insertUser: async () => { throw new Error('Dry run cannot write') },
      findSlug: slug => db.collection<WorldTemplateDoc>('world_templates').findOne({ slug }),
      findTitle: (creator_id, title) => db.collection<WorldTemplateDoc>('world_templates').findOne({ creator_id, title }),
      readCover: async url => {
        const base = process.env.CDN_BASE_URL?.replace(/\/+$/, '')
        if (!base || !url.startsWith(`${base}/media/`)) throw new Error('Existing cover is outside configured CDN media; reconcile manually')
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) })
        if (!response.ok) throw new Error(`Cannot read existing cover (HTTP ${response.status})`)
        return Buffer.from(await response.arrayBuffer())
      },
      defaults: () => { throw new Error('Dry run cannot create users') },
      upload: async () => { throw new Error('Dry run cannot upload') },
      create: async () => { throw new Error('Dry run cannot create') },
      update: async () => { throw new Error('Dry run cannot update') },
      publish: async () => { throw new Error('Dry run cannot publish') },
      approve: async () => { throw new Error('Dry run cannot approve') },
      get: id => db.collection<WorldTemplateDoc>('world_templates').findOne({ _id: new ObjectId(id) }),
    }
    if (options.apply) {
      const { connectMongo } = await import('../src/config/mongo')
      let connected: Promise<unknown> | undefined
      const ready = () => connected ||= connectMongo()
      const { templateService } = await import('../src/services/template.service')
      const { imageService } = await import('../src/services/image.service')
      const { adminService } = await import('../src/services/admin.service')
      const { defaultUserPreferences } = await import('../src/services/auth.service')
      Object.assign(runtime, {
        insertUser: async (doc: UserInsertDoc) => { await ready(); const { insertedId } = await db.collection<UserInsertDoc>('users').insertOne(doc); return { ...doc, _id: insertedId } },
        defaults: defaultUserPreferences, upload: async (file: File) => { await ready(); return imageService.uploadUserImage(file) },
        create: async (owner: string, data: Body) => { await ready(); return templateService.create(owner, data) },
        update: async (id: string, owner: string, data: Record<string, unknown>) => { await ready(); return templateService.update(id, owner, data) },
        publish: templateService.publish.bind(templateService), approve: (id: string) => adminService.reviewWorld(id, 'approved', 'catalog-seed'),
      } satisfies Partial<Runtime>)
    }
    await runCatalog(options, runtime)
  } finally { await client.close() }
}

if (import.meta.main) {
  try { await main(); process.exit(0) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1) }
}
