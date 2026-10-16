/**
 * Ingest authored looks + Codex-app portraits onto each world's cast.
 *
 * Owner decision, Oct 16 2026: every published world's authored characters get
 * a written look and a portrait painted in the Codex desktop app, so "See them
 * say it" and "Picture this" work for them. The read side already exists
 * (`resolvePortraitHolder`); this script is only the write side.
 *
 * Run:
 *   bun run scripts/ingest-cast-portraits.ts                       (dry run)
 *   bun run scripts/ingest-cast-portraits.ts --only <template-slug> (dry run, one world)
 *   bun run scripts/ingest-cast-portraits.ts --apply --yes-db <name>
 *   bun run scripts/ingest-cast-portraits.ts --self-test            (no DB)
 *
 * Dry run (the default) prints per character what it would do, including the
 * exact `$set`, and makes no writes — no Mongo updates and no S3 uploads.
 * `--apply` refuses unless `--yes-db` matches the database the env points at,
 * so a copy-pasted command can't write to the wrong database.
 */
import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { join, resolve } from 'path'
import sharp from 'sharp'
import type { UpdateFilter, WithoutId } from 'mongodb'
import { connectMongo, getDb, mongoColl } from '../src/config/mongo'
import { identityKey } from '../src/services/character-codex.service'
import { storageService } from '../src/services/storage.service'
import type { PortraitRef } from '../src/models/media.model'
import type {
  ProtagonistDoc,
  TemplateCastCharacterDoc,
  WorldTemplateDoc,
} from '../src/models/world-template.model'

// ── Manifest ────────────────────────────────────────────────────────────────

interface ManifestCharacter {
  slug: string
  slot: 'protagonist' | 'seed_cast'
  name: string
  look: string
  keep_look?: boolean
  file: string
}

interface Manifest {
  drop_folder: string
  characters: ManifestCharacter[]
}

const DEFAULT_MANIFEST = resolve(
  import.meta.dir,
  '../../.agents/assets/cast-portraits/manifest.json',
)

// ── Pure helpers (no DB; exercised by --self-test) ──────────────────────────

type CastEntry = ProtagonistDoc | TemplateCastCharacterDoc

interface MatchedEntry {
  /** 'protagonist', or `seed_cast.<index>` for a cast member. */
  base: string
  entry: CastEntry
}

/**
 * Find the manifest character's entry structurally. The protagonist slot is
 * the template's protagonist; a seed_cast slot is the element whose name
 * matches by the codex's identityKey (case/punctuation-insensitive), never by
 * substring — "Maya Chen" must not match "Maya". A miss is reported, never
 * created.
 */
export function findCastEntry(
  template: Pick<WorldTemplateDoc, 'protagonist' | 'seed_cast'>,
  slot: 'protagonist' | 'seed_cast',
  name: string,
): MatchedEntry | null {
  if (slot === 'protagonist') {
    if (!template.protagonist) return null
    return { base: 'protagonist', entry: template.protagonist }
  }
  const seed = template.seed_cast || []
  const want = identityKey(name)
  const index = seed.findIndex((e) => identityKey(e.name) === want)
  if (index < 0) return null
  return { base: `seed_cast.${index}`, entry: seed[index]! }
}

/**
 * Decide the look write. An authored look is never overwritten: `keep_look`
 * pins the template's text, and any non-empty entry appearance wins over the
 * manifest. Returns the appearance text to set, or null for no change.
 */
export function decideAppearance(
  entry: Pick<CastEntry, 'appearance'>,
  look: string,
  keepLook: boolean,
): string | null {
  if (keepLook) return null
  if ((entry.appearance || '').trim()) return null
  return look
}

/** Asset-file slug for a character name (same shape as template slugs). */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Revisioned key for authored portrait bytes. The content hash is the
 * revision: re-running with the same bytes addresses the same key (a no-op),
 * and new bytes can never overwrite a published key.
 */
export function assetKeyFor(slug: string, name: string, bytes: Buffer, ext: string): string {
  const sha12 = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
  return `media/portrait/authored/${slug}/${nameKey(name)}-${sha12}.${ext}`
}

/**
 * Build the authored portrait ref. `appearance_version` equals the entry's
 * own version so `isPortraitCurrent` treats it as current. `art_style` is the
 * template's locked narrative_style key, omitted (never null) when unset —
 * which reads as the painted default, exactly like legacy portraits.
 */
export function buildAuthoredPortrait(
  assetKey: string,
  entry: Pick<CastEntry, 'appearance_version'>,
  narrativeStyle: string | undefined,
  paintedAt: Date,
): PortraitRef {
  const ref: PortraitRef = {
    asset_key: assetKey,
    source: 'authored',
    appearance_version: entry.appearance_version ?? 1,
    painted_at: paintedAt,
  }
  if (narrativeStyle) ref.art_style = narrativeStyle
  return ref
}

/**
 * Same portrait ignoring `painted_at`: a re-run stamps a fresh time, which
 * must not count as a change. Missing art_style counts as the painted
 * default on both sides (legacy rows have no key).
 */
export function samePortraitIgnoringTime(a?: PortraitRef, b?: PortraitRef): boolean {
  if (!a || !b) return false
  return (
    a.asset_key === b.asset_key
    && a.source === b.source
    && a.appearance_version === b.appearance_version
    && (a.art_style || 'painted') === (b.art_style || 'painted')
  )
}

/**
 * The positional `$set` for one entry: only its `appearance` and `portrait`
 * keys, nothing else on the template. Empty means fully no-op.
 */
export function buildEntrySet(
  base: string,
  appearance: string | null,
  portrait: PortraitRef | null,
): Record<string, unknown> {
  const $set: Record<string, unknown> = {}
  if (appearance !== null) $set[`${base}.appearance`] = appearance
  if (portrait !== null) $set[`${base}.portrait`] = portrait
  return $set
}

export interface PortraitCheck {
  ok: boolean
  reason?: string
  width?: number
  height?: number
}

/** Minimum face width the chat portrait pipeline can use. */
export const MIN_PORTRAIT_WIDTH = 768

/**
 * Verify painted portrait bytes: they must decode as a PNG, be
 * portrait-oriented, and be at least 768 px wide. Anything else is reported
 * and skipped, never uploaded.
 */
export async function verifyPortraitBytes(bytes: Buffer): Promise<PortraitCheck> {
  let meta: sharp.Metadata
  try {
    meta = await sharp(bytes).metadata()
  } catch {
    return { ok: false, reason: 'does not decode as an image' }
  }
  if (meta.format !== 'png') return { ok: false, reason: `not a PNG (is ${meta.format || 'unknown'})` }
  const width = meta.width || 0
  const height = meta.height || 0
  if (!width || !height) return { ok: false, reason: 'has no dimensions' }
  if (width < MIN_PORTRAIT_WIDTH) {
    return { ok: false, reason: `too narrow (${width}px < ${MIN_PORTRAIT_WIDTH}px)`, width, height }
  }
  if (height <= width) {
    return { ok: false, reason: `not portrait-oriented (${width}x${height})`, width, height }
  }
  return { ok: true, width, height }
}

// ── Args ────────────────────────────────────────────────────────────────────

interface Args {
  apply: boolean
  selfTest: boolean
  only: string | null
  yesDb: string | null
  manifestPath: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    selfTest: false,
    only: null,
    yesDb: null,
    manifestPath: DEFAULT_MANIFEST,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--apply') args.apply = true
    else if (a === '--self-test') args.selfTest = true
    else if (a === '--only') args.only = argv[++i] || null
    else if (a === '--yes-db') args.yesDb = argv[++i] || null
    else if (a === '--manifest') args.manifestPath = argv[++i] || DEFAULT_MANIFEST
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: bun run scripts/ingest-cast-portraits.ts [--apply --yes-db <name>] [--only <template-slug>] [--manifest <path>] [--self-test]',
      )
      process.exit(0)
    } else {
      console.error(`Unknown arg: ${a}`)
      process.exit(1)
    }
  }
  if (!args.only && args.only !== null) {
    console.error('--only needs a template slug')
    process.exit(1)
  }
  return args
}

// ── Self-test (no DB) ───────────────────────────────────────────────────────

function check(cond: boolean, label: string, detail?: unknown): void {
  if (!cond) {
    console.error(`FAIL ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
    process.exitCode = 1
  } else {
    console.log(`ok ${label}`)
  }
}

async function selfTest(): Promise<void> {
  // 1. Protagonist slot resolves to the protagonist entry.
  const sentient = {
    protagonist: { name: 'Rin' } as ProtagonistDoc,
    seed_cast: [{ name: 'Maya' } as TemplateCastCharacterDoc],
  }
  const p = findCastEntry(sentient, 'protagonist', 'Rin')
  check(p?.base === 'protagonist' && p.entry.name === 'Rin', 'protagonist slot finds protagonist')
  check(
    findCastEntry({ seed_cast: [] }, 'protagonist', 'Nobody') === null,
    'missing protagonist is a miss, never created',
  )

  // 2. Seed matching uses the codex identityKey (case/punctuation-insensitive).
  const cast = {
    seed_cast: [{ name: 'King Aldric' } as TemplateCastCharacterDoc],
  }
  check(
    findCastEntry(cast, 'seed_cast', '  KING aldric ')?.base === 'seed_cast.0',
    'seed match is identityKey-insensitive',
  )
  check(
    findCastEntry(cast, 'seed_cast', 'Queen Isolde') === null,
    'unknown seed name is a miss',
  )

  // 3. Mutation: a naive substring matcher takes the WRONG entry for
  // "Maya Chen" when "Maya" sorts first; the strict matcher must not.
  const sisters = {
    seed_cast: [{ name: 'Maya' } as TemplateCastCharacterDoc, { name: 'Maya Chen' } as TemplateCastCharacterDoc],
  }
  const naive = sisters.seed_cast.findIndex((e) => identityKey('Maya Chen').includes(identityKey(e.name)))
  const strict = findCastEntry(sisters, 'seed_cast', 'Maya Chen')
  check(naive === 0, 'mutation: substring matcher takes the wrong entry (Maya for Maya Chen)')
  check(strict?.base === 'seed_cast.1', 'strict identityKey equality takes the right entry')

  // 4. Appearance is never overwritten.
  check(
    decideAppearance({ appearance: '' }, 'new look', false) === 'new look',
    'empty appearance takes the manifest look',
  )
  check(
    decideAppearance({ appearance: '  ' }, 'new look', false) === 'new look',
    'blank appearance counts as empty',
  )
  check(
    decideAppearance({ appearance: 'old look' }, 'new look', false) === null,
    'existing authored look is kept',
  )
  check(
    decideAppearance({ appearance: '' }, 'new look', true) === null,
    'keep_look pins the template text',
  )
  check(
    decideAppearance({}, 'new look', false) === 'new look',
    'missing appearance takes the manifest look',
  )

  // 5. $set touches only the one entry's appearance + portrait.
  const $set = buildEntrySet(
    'seed_cast.2',
    'a look',
    { asset_key: 'k', source: 'authored', appearance_version: 1, painted_at: new Date(0) },
  )
  check(
    Object.keys($set).length === 2
      && 'seed_cast.2.appearance' in $set
      && 'seed_cast.2.portrait' in $set,
    'positional $set keys for a seed entry',
  )
  check(
    Object.keys(buildEntrySet('protagonist', null, null)).length === 0,
    'no changes means an empty $set (no-op)',
  )
  const proSet = buildEntrySet('protagonist', null, {
    asset_key: 'k',
    source: 'authored',
    appearance_version: 1,
    painted_at: new Date(0),
  })
  check(
    Object.keys(proSet).length === 1 && 'protagonist.portrait' in proSet,
    'protagonist portrait lands on the protagonist path',
  )

  // 6. Portrait versioning + style omission.
  const styled = buildAuthoredPortrait('k', { appearance_version: 3 }, 'noir', new Date(0))
  check(
    styled.appearance_version === 3 && styled.art_style === 'noir' && styled.source === 'authored',
    'portrait carries the entry version and the world style',
  )
  const unstyled = buildAuthoredPortrait('k', {}, undefined, new Date(0))
  check(
    unstyled.appearance_version === 1 && !('art_style' in unstyled) && unstyled.art_style !== null,
    'missing narrative_style omits art_style, never null',
  )
  const sameTime = new Date('2026-10-01T00:00:00Z')
  const laterTime = new Date('2026-10-16T00:00:00Z')
  check(
    samePortraitIgnoringTime(
      { asset_key: 'k', source: 'authored', appearance_version: 1, painted_at: sameTime },
      { asset_key: 'k', source: 'authored', appearance_version: 1, painted_at: laterTime },
    ),
    're-run with the same key is a no-op despite a fresh painted_at',
  )
  check(
    !samePortraitIgnoringTime(
      { asset_key: 'k1', source: 'authored', appearance_version: 1, painted_at: sameTime },
      { asset_key: 'k2', source: 'authored', appearance_version: 1, painted_at: sameTime },
    ),
    'a new key counts as a change',
  )
  check(
    samePortraitIgnoringTime(
      { asset_key: 'k', source: 'authored', appearance_version: 1, painted_at: sameTime },
      { asset_key: 'k', source: 'authored', appearance_version: 1, art_style: undefined, painted_at: laterTime },
    ),
    'absent art_style matches an omitted one (painted default)',
  )

  // 7. Revisioned keys are stable per bytes and namespaced per world/face.
  const bytes = Buffer.from('same-bytes')
  const keyA = assetKeyFor('my-world', 'Maya Chen', bytes, 'png')
  check(
    keyA === assetKeyFor('my-world', 'Maya Chen', Buffer.from('same-bytes'), 'png'),
    'same bytes give the same key',
  )
  check(
    keyA !== assetKeyFor('my-world', 'Maya Chen', Buffer.from('other-bytes'), 'png'),
    'new bytes give a new key (never overwrite)',
  )
  check(
    keyA.startsWith('media/portrait/authored/my-world/maya-chen-')
      && keyA.endsWith('.png')
      && /^media\/portrait\/authored\/my-world\/maya-chen-[0-9a-f]{12}\.png$/.test(keyA),
    'key shape carries slug, name key and a 12-hex content revision',
    keyA,
  )

  // 8. PNG verification on synthetic buffers (sharp writes, no files).
  const good = await sharp({
    create: { width: 768, height: 1024, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toBuffer()
  check((await verifyPortraitBytes(good)).ok, '768x1024 portrait PNG verifies')
  const landscape = await sharp({
    create: { width: 1024, height: 768, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toBuffer()
  const landResult = await verifyPortraitBytes(landscape)
  check(!landResult.ok && /portrait-oriented/.test(landResult.reason || ''), 'landscape is rejected')
  const narrow = await sharp({
    create: { width: 512, height: 900, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toBuffer()
  const narrowResult = await verifyPortraitBytes(narrow)
  check(!narrowResult.ok && /narrow/.test(narrowResult.reason || ''), 'sub-768px width is rejected')
  const jpeg = await sharp({
    create: { width: 800, height: 1200, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).jpeg().toBuffer()
  const jpegResult = await verifyPortraitBytes(jpeg)
  check(!jpegResult.ok && /PNG/.test(jpegResult.reason || ''), 'non-PNG bytes are rejected')
  const garbage = await verifyPortraitBytes(Buffer.from('not an image at all'))
  check(!garbage.ok && /decode/.test(garbage.reason || ''), 'undecodable bytes are rejected')

  if (process.exitCode) {
    console.error('\nSELF-TEST FAILED')
    process.exit(1)
  }
  console.log('\nSELF-TEST PASSED')
}

// ── Ingest ──────────────────────────────────────────────────────────────────

/** Dry-run display: the apply-time stamp is not invented for a preview. */
function printableSet($set: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries($set)) {
    if (v instanceof Date) out[k] = '<now-at-apply>'
    else if (v && typeof v === 'object' && 'painted_at' in (v as Record<string, unknown>)) {
      out[k] = { ...(v as Record<string, unknown>), painted_at: '<now-at-apply>' }
    } else out[k] = v
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.selfTest) {
    await selfTest()
    process.exit(process.exitCode || 0)
  }

  const manifest: Manifest = JSON.parse(await readFile(args.manifestPath, 'utf8'))
  const wanted = args.only
    ? manifest.characters.filter((c) => c.slug === args.only)
    : manifest.characters
  if (args.only && wanted.length === 0) {
    console.error(`No manifest characters for slug: ${args.only}`)
    process.exit(1)
  }

  await connectMongo()
  const dbName = getDb().databaseName
  console.log(`database: ${dbName}`)
  if (args.apply && args.yesDb !== dbName) {
    console.error(
      `Refusing --apply: pass --yes-db ${dbName} to confirm this is the database you mean.`,
    )
    process.exit(1)
  }
  console.log(args.apply ? 'mode: APPLY' : 'mode: dry run (no writes)')

  let ok = 0
  let noop = 0
  let missingPng = 0
  let missingTemplate = 0
  let missingEntry = 0
  let invalidPng = 0
  let failed = 0

  for (const c of wanted) {
    const tag = `${c.slug} / ${c.slot} / ${c.name}`
    const template = await mongoColl.worldTemplates().findOne({ slug: c.slug, is_published: true })
    if (!template) {
      missingTemplate++
      console.log(`MISS template  ${tag}  (no published template for slug)`)
      continue
    }
    const match = findCastEntry(template, c.slot, c.name)
    if (!match) {
      missingEntry++
      const have = [
        ...(template.seed_cast || []).map((e) => e.name),
        ...(template.protagonist ? [`protagonist:${template.protagonist.name}`] : []),
      ]
      console.log(`MISS entry     ${tag}  (have: ${have.join(' | ') || 'no cast'})`)
      continue
    }

    const appearance = decideAppearance(match.entry, c.look, c.keep_look === true)

    // Portrait: a missing file skips the face but not the look.
    let portrait: PortraitRef | null = null
    let pngNote = ''
    const pngPath = join(manifest.drop_folder, c.file)
    let bytes: Buffer | null = null
    try {
      bytes = await readFile(pngPath)
    } catch {
      bytes = null
    }
    if (!bytes) {
      missingPng++
      pngNote = `portrait: MISSING FILE ${c.file}`
    } else {
      const checkPng = await verifyPortraitBytes(bytes)
      if (!checkPng.ok) {
        invalidPng++
        pngNote = `portrait: INVALID ${c.file} (${checkPng.reason})`
        bytes = null
      } else {
        const ext = (c.file.split('.').pop() || 'png').toLowerCase()
        const key = assetKeyFor(c.slug, c.name, bytes, ext)
        const candidate = buildAuthoredPortrait(
          key,
          match.entry,
          template.narrative_style || undefined,
          new Date(),
        )
        if (match.entry.portrait && samePortraitIgnoringTime(match.entry.portrait, candidate)) {
          pngNote = `portrait: current (${key})`
        } else {
          portrait = candidate
          pngNote = `portrait: ${match.entry.portrait ? 'REPAINT' : 'NEW'} ${key} (${checkPng.width}x${checkPng.height})`
        }
      }
    }

    const $set = buildEntrySet(match.base, appearance, portrait)
    if (Object.keys($set).length === 0) {
      noop++
      console.log(`NOOP           ${tag}  ${pngNote}`)
      continue
    }

    if (!args.apply) {
      console.log(`WOULD SET      ${tag}  ${pngNote}`)
      console.log(`  $set: ${JSON.stringify(printableSet($set))}`)
      continue
    }

    try {
      // Upload first: a failed upload must not leave a pointer at a key
      // whose bytes never landed.
      if (portrait && bytes) {
        await storageService.upload(bytes, 'image/png', { key: portrait.asset_key })
      }
      // One positional update on the named entry only. The key shape is
      // asserted in --self-test, so this single cast is the only untyped
      // write in the script.
      const update = { $set } as unknown as UpdateFilter<WithoutId<WorldTemplateDoc>>
      await mongoColl.worldTemplates().updateOne({ _id: template._id }, update)
      ok++
      console.log(`APPLIED        ${tag}  ${pngNote}`)
      console.log(`  $set: ${JSON.stringify(printableSet($set))}`)
    } catch (e) {
      failed++
      console.log(`FAILED         ${tag}  ${(e as Error).message}`)
    }
  }

  console.log(
    `\n${wanted.length} character(s): ${ok} applied, ${noop} no-op, ${missingPng} missing PNG, `
      + `${invalidPng} invalid PNG, ${missingTemplate} missing template, ${missingEntry} missing entry, ${failed} failed.`,
  )
  if (!args.apply) console.log('Dry run — re-run with --apply --yes-db <name> to write.')
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('\ningest-cast-portraits failed:', e)
  process.exit(1)
})
