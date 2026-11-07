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
 *
 * Authored portraits are stored as WebP (about 240 KB instead of about 2.8 MB
 * of PNG): the drop folder stays PNG, the checks run on the original, and the
 * uploaded bytes are the shared bounded encoding. The key revision is the
 * hash of the original PNG, so the same art always addresses the same key.
 * A world already pointing at the PNG of the same art is moved to the WebP
 * key by changing `asset_key` alone — no repaint, no new look — and the PNG
 * object is left in place for references and caches that still use it.
 */
import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { join, resolve } from 'path'
import sharp from 'sharp'
import type { UpdateFilter, WithoutId } from 'mongodb'
import { connectMongo, getDb, mongoColl } from '../src/config/mongo'
import { identityKey } from '../src/services/character-codex.service'
import { storageService } from '../src/services/storage.service'
import { encodeImageThumb, encodeUserImage, PORTRAIT_THUMB_WIDTH, thumbKey } from '../src/utils/image-encoding'
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
 * Revision for authored portrait art. It is the content hash of the ORIGINAL
 * PNG, not of the encoded WebP: the same art then addresses the same key on
 * every run and with every encoder, so a re-run is a no-op or a move, and new
 * art can never overwrite a published key.
 */
export function portraitRevision(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12)
}

/** Revisioned WebP key for authored portrait bytes (the uploaded encoding). */
export function assetKeyFor(slug: string, name: string, bytes: Buffer): string {
  return `media/portrait/authored/${slug}/${nameKey(name)}-${portraitRevision(bytes)}.webp`
}

/** The PNG key an earlier run of this script published for the same art. */
export function pngKeyFor(slug: string, name: string, bytes: Buffer): string {
  return `media/portrait/authored/${slug}/${nameKey(name)}-${portraitRevision(bytes)}.png`
}

/**
 * The 320 px WebP key stored beside the full portrait. Null when the full key
 * is not WebP, which is the only shape this script publishes.
 */
export function thumbKeyFor(slug: string, name: string, bytes: Buffer): string | null {
  return thumbKey(assetKeyFor(slug, name, bytes), PORTRAIT_THUMB_WIDTH)
}

/**
 * Build the authored portrait ref. `appearance_version` equals the entry's
 * own version so `isPortraitCurrent` treats it as current. `art_style` is the
 * template's locked narrative_style key, omitted (never null) when unset —
 * which reads as the painted default, exactly like legacy portraits. The small
 * variant is recorded only when it was uploaded beside the full one.
 */
export function buildAuthoredPortrait(
  assetKey: string,
  entry: Pick<CastEntry, 'appearance_version'>,
  narrativeStyle: string | undefined,
  paintedAt: Date,
  thumbAssetKey?: string | null,
): PortraitRef {
  const ref: PortraitRef = {
    asset_key: assetKey,
    source: 'authored',
    appearance_version: entry.appearance_version ?? 1,
    painted_at: paintedAt,
  }
  if (narrativeStyle) ref.art_style = narrativeStyle
  if (thumbAssetKey) ref.thumb_key = thumbAssetKey
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
 * What to write for one face: nothing, the whole portrait ref (new art, a new
 * style, an out-of-date version), just the key when the same art is only
 * moving from its PNG key to its WebP key, or just the small variant when the
 * full image is already published without one.
 */
export type PortraitPlan =
  | { kind: 'none' }
  | { kind: 'paint'; portrait: PortraitRef }
  | { kind: 'move'; assetKey: string }
  | { kind: 'thumb'; thumbKey: string }

/**
 * True when `current` is the PNG of this exact art and nothing else about the
 * ref differs. Swapping that key is not a repaint: `painted_at`, the style and
 * the version stay untouched, so no save regenerates or reports a new look.
 */
function isSameArtPng(current: PortraitRef, candidate: PortraitRef, pngKey: string): boolean {
  return current.asset_key === pngKey
    && current.source === candidate.source
    && current.appearance_version === candidate.appearance_version
    && (current.art_style || 'painted') === (candidate.art_style || 'painted')
}

export function planPortrait(
  current: PortraitRef | undefined,
  key: string,
  pngKey: string,
  thumbAssetKey: string | null,
  entry: Pick<CastEntry, 'appearance_version'>,
  narrativeStyle: string | undefined,
  paintedAt: Date,
): PortraitPlan {
  const candidate = buildAuthoredPortrait(key, entry, narrativeStyle, paintedAt, thumbAssetKey)
  if (current && samePortraitIgnoringTime(current, candidate)) {
    // The full image is current; only its small variant is missing or stale.
    if (thumbAssetKey && current.thumb_key !== thumbAssetKey) return { kind: 'thumb', thumbKey: thumbAssetKey }
    return { kind: 'none' }
  }
  if (current && isSameArtPng(current, candidate, pngKey)) return { kind: 'move', assetKey: key }
  return { kind: 'paint', portrait: candidate }
}

/**
 * The positional `$set` for one entry: only its `appearance` and `portrait`
 * keys, nothing else on the template. A move writes the single nested
 * `asset_key` so nothing else on the portrait changes; a thumb writes only the
 * small variant's key. Empty means no-op.
 */
export function buildEntrySet(
  base: string,
  appearance: string | null,
  plan: PortraitPlan,
): Record<string, unknown> {
  const $set: Record<string, unknown> = {}
  if (appearance !== null) $set[`${base}.appearance`] = appearance
  if (plan.kind === 'paint') $set[`${base}.portrait`] = plan.portrait
  else if (plan.kind === 'move') $set[`${base}.portrait.asset_key`] = plan.assetKey
  else if (plan.kind === 'thumb') $set[`${base}.portrait.thumb_key`] = plan.thumbKey
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
  const $set = buildEntrySet('seed_cast.2', 'a look', {
    kind: 'paint',
    portrait: { asset_key: 'k', source: 'authored', appearance_version: 1, painted_at: new Date(0) },
  })
  check(
    Object.keys($set).length === 2
      && 'seed_cast.2.appearance' in $set
      && 'seed_cast.2.portrait' in $set,
    'positional $set keys for a seed entry',
  )
  check(
    Object.keys(buildEntrySet('protagonist', null, { kind: 'none' })).length === 0,
    'no changes means an empty $set (no-op)',
  )
  const proSet = buildEntrySet('protagonist', null, {
    kind: 'paint',
    portrait: { asset_key: 'k', source: 'authored', appearance_version: 1, painted_at: new Date(0) },
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

  // 7. Revisioned keys are stable per bytes, keyed by the PNG hash, WebP ext.
  const bytes = Buffer.from('same-bytes')
  const keyA = assetKeyFor('my-world', 'Maya Chen', bytes)
  check(
    keyA === assetKeyFor('my-world', 'Maya Chen', Buffer.from('same-bytes')),
    'same bytes give the same key',
  )
  check(
    keyA !== assetKeyFor('my-world', 'Maya Chen', Buffer.from('other-bytes')),
    'new bytes give a new key (never overwrite)',
  )
  check(
    keyA.startsWith('media/portrait/authored/my-world/maya-chen-')
      && /^media\/portrait\/authored\/my-world\/maya-chen-[0-9a-f]{12}\.webp$/.test(keyA),
    'key shape carries slug, name key, a 12-hex content revision and .webp',
    keyA,
  )
  check(
    pngKeyFor('my-world', 'Maya Chen', bytes) === keyA.replace(/\.webp$/, '.png'),
    'the PNG key of the same art shares the revision',
    pngKeyFor('my-world', 'Maya Chen', bytes),
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

  // 9. A re-run on the PNG of the same art moves; the WebP is then a no-op,
  // and a WebP without its small variant gains only that key.
  const world = 'my-world'
  const name = 'Maya Chen'
  const art = Buffer.from('same-bytes')
  const webpKey = assetKeyFor(world, name, art)
  const pngKey = pngKeyFor(world, name, art)
  const thumbKeyValue = thumbKeyFor(world, name, art)!
  const paintedAt = new Date('2026-10-01T00:00:00Z')
  const rerunAt = new Date('2026-11-05T00:00:00Z')
  const version = { appearance_version: 2 }
  const paintedPng: PortraitRef = {
    asset_key: pngKey,
    source: 'authored',
    appearance_version: 2,
    art_style: 'noir',
    painted_at: paintedAt,
  }
  const movePlan = planPortrait(paintedPng, webpKey, pngKey, thumbKeyValue, version, 'noir', rerunAt)
  check(
    movePlan.kind === 'move' && movePlan.assetKey === webpKey,
    'a PNG of the same art plans a move to WebP',
    movePlan,
  )
  const moveSet = buildEntrySet('seed_cast.0', null, movePlan)
  check(
    JSON.stringify(moveSet) === JSON.stringify({ 'seed_cast.0.portrait.asset_key': webpKey }),
    'a move changes only asset_key',
    moveSet,
  )
  const movedRef: PortraitRef = { ...paintedPng, asset_key: webpKey }
  const thumbPlan = planPortrait(movedRef, webpKey, pngKey, thumbKeyValue, version, 'noir', rerunAt)
  check(
    thumbPlan.kind === 'thumb' && thumbPlan.thumbKey === thumbKeyValue,
    'a WebP without its small variant plans only the thumb',
    thumbPlan,
  )
  const thumbSet = buildEntrySet('seed_cast.0', null, thumbPlan)
  check(
    JSON.stringify(thumbSet) === JSON.stringify({ 'seed_cast.0.portrait.thumb_key': thumbKeyValue }),
    'a thumb re-run changes only thumb_key',
    thumbSet,
  )
  const thumbedRef: PortraitRef = { ...movedRef, thumb_key: thumbKeyValue }
  check(
    planPortrait(thumbedRef, webpKey, pngKey, thumbKeyValue, version, 'noir', rerunAt).kind === 'none',
    'a second re-run on the thumbed WebP is a no-op',
  )
  check(
    planPortrait(movedRef, webpKey, pngKey, null, version, 'noir', rerunAt).kind === 'none',
    'a missing small variant cannot be recorded when nothing was encoded',
  )
  const newArt = Buffer.from('other-bytes')
  const newKey = assetKeyFor(world, name, newArt)
  const repaintPlan = planPortrait(paintedPng, newKey, pngKeyFor(world, name, newArt), thumbKeyFor(world, name, newArt), version, 'noir', rerunAt)
  check(
    repaintPlan.kind === 'paint' && repaintPlan.portrait.asset_key === newKey,
    'different art still repaints to its own key',
    repaintPlan,
  )
  const freshPlan = planPortrait(undefined, webpKey, pngKey, thumbKeyValue, version, 'noir', rerunAt)
  check(
    freshPlan.kind === 'paint' && freshPlan.portrait.asset_key === webpKey && freshPlan.portrait.thumb_key === thumbKeyValue,
    'a first portrait is a paint carrying its small variant',
  )
  const restyledPlan = planPortrait(movedRef, webpKey, pngKey, thumbKeyValue, version, 'painted', rerunAt)
  check(restyledPlan.kind === 'paint', 'a style change still repaints')

  // 10. The uploaded bytes are the shared bounded WebP encoding, and the small
  // one is a narrower q78 WebP built from the same source.
  const encoded = await encodeUserImage(sharp(good))
  const encodedMeta = await sharp(encoded).metadata()
  check(encodedMeta.format === 'webp', 'the upload encoding is WebP', encodedMeta.format)
  const thumbBytes = await encodeImageThumb(sharp(good), PORTRAIT_THUMB_WIDTH)
  const thumbMeta = await sharp(thumbBytes).metadata()
  check(
    thumbMeta.format === 'webp' && thumbMeta.width === PORTRAIT_THUMB_WIDTH
      && Math.abs(thumbMeta.width! / thumbMeta.height! - 768 / 1024) < 0.01,
    'the small variant is WebP at the portrait width and keeps the aspect',
    [thumbMeta.format, thumbMeta.width, thumbMeta.height],
  )
  check(
    thumbKeyValue === webpKey.replace(/\.webp$/, '.w320.webp'),
    'the small variant key replaces .webp with .w320.webp',
    thumbKeyValue,
  )
  const tiny = await sharp({
    create: { width: 200, height: 300, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toBuffer()
  const narrowThumb = await sharp(await encodeImageThumb(sharp(tiny), PORTRAIT_THUMB_WIDTH)).metadata()
  check(narrowThumb.width === 200, 'the small variant is never enlarged', narrowThumb.width)

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
  let encodeFailed = 0
  let thumbEncodeFailed = 0
  let thumbOnly = 0
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

    // Portrait: a missing or unsuitable file skips the face but not the look.
    // The checks run on the original PNG; what gets uploaded is the WebP.
    let plan: PortraitPlan = { kind: 'none' }
    let portraitNote = ''
    let upload: Buffer | null = null
    let thumbUpload: Buffer | null = null
    const pngPath = join(manifest.drop_folder, c.file)
    let bytes: Buffer | null = null
    try {
      bytes = await readFile(pngPath)
    } catch {
      bytes = null
    }
    if (!bytes) {
      missingPng++
      portraitNote = `portrait: MISSING FILE ${c.file}`
    } else {
      const checkPng = await verifyPortraitBytes(bytes)
      if (!checkPng.ok) {
        invalidPng++
        portraitNote = `portrait: INVALID ${c.file} (${checkPng.reason})`
      } else {
        try {
          upload = await encodeUserImage(sharp(bytes))
        } catch (e) {
          // Never fall back to the PNG: a .webp key must hold WebP bytes.
          // Report the character and skip it.
          encodeFailed++
          console.log(`ENCODE FAILED  ${tag}  portrait: ${c.file} (${(e as Error).message})`)
          continue
        }
        const key = assetKeyFor(c.slug, c.name, bytes)
        const smallKey = thumbKeyFor(c.slug, c.name, bytes)
        plan = planPortrait(
          match.entry.portrait,
          key,
          pngKeyFor(c.slug, c.name, bytes),
          smallKey,
          match.entry,
          template.narrative_style || undefined,
          new Date(),
        )
        // The small variant is encoded only when this run will record it, so a
        // no-op costs nothing and a thumb_key can never point at bytes that
        // were not uploaded. A failure skips the character rather than writing
        // half a portrait.
        if (plan.kind === 'paint' || plan.kind === 'thumb') {
          try {
            thumbUpload = await encodeImageThumb(sharp(bytes), PORTRAIT_THUMB_WIDTH)
          } catch (e) {
            thumbEncodeFailed++
            console.log(`THUMB ENCODE FAILED  ${tag}  portrait: ${c.file} (${(e as Error).message})`)
            continue
          }
        }
        const size = `${Math.round(bytes.length / 1024)} KB PNG -> ${Math.round(upload.length / 1024)} KB WebP`
        const smallSize = thumbUpload ? ` (+${Math.round(thumbUpload.length / 1024)} KB small)` : ''
        if (plan.kind === 'none') {
          portraitNote = `portrait: current (${key})`
        } else if (plan.kind === 'move') {
          const was = match.entry.portrait?.asset_key
          portraitNote = `portrait: ${args.apply ? 'MOVED TO WEBP' : 'WOULD MOVE TO WEBP'} ${key} (was ${was}; ${size})`
        } else if (plan.kind === 'thumb') {
          thumbOnly++
          portraitNote = `portrait: ${args.apply ? 'ADDED THUMB' : 'WOULD ADD THUMB'} ${plan.thumbKey} (${Math.round(thumbUpload!.length / 1024)} KB)`
        } else {
          portraitNote = `portrait: ${match.entry.portrait ? 'REPAINT' : 'NEW'} ${key} (${checkPng.width}x${checkPng.height}; ${size}${smallSize})`
        }
      }
    }

    const $set = buildEntrySet(match.base, appearance, plan)
    if (Object.keys($set).length === 0) {
      noop++
      console.log(`NOOP           ${tag}  ${portraitNote}`)
      continue
    }

    if (!args.apply) {
      console.log(`WOULD SET      ${tag}  ${portraitNote}`)
      console.log(`  $set: ${JSON.stringify(printableSet($set))}`)
      continue
    }

    try {
      // Upload first: a failed upload must not leave a pointer at a key
      // whose bytes never landed. A move uploads the new WebP under the new
      // key and leaves the old PNG object in place for existing references.
      // The small variant follows the full one, so `thumb_key` is written only
      // for an object that exists.
      const uploadKey = plan.kind === 'paint'
        ? plan.portrait.asset_key
        : plan.kind === 'move' ? plan.assetKey : null
      if (uploadKey && upload) {
        await storageService.upload(upload, 'image/webp', { key: uploadKey })
      }
      const thumbUploadKey = plan.kind === 'paint'
        ? plan.portrait.thumb_key
        : plan.kind === 'thumb' ? plan.thumbKey : null
      if (thumbUploadKey && thumbUpload) {
        await storageService.upload(thumbUpload, 'image/webp', { key: thumbUploadKey })
      }
      // One positional update on the named entry only. The key shape is
      // asserted in --self-test, so this single cast is the only untyped
      // write in the script.
      const update = { $set } as unknown as UpdateFilter<WithoutId<WorldTemplateDoc>>
      await mongoColl.worldTemplates().updateOne({ _id: template._id }, update)
      ok++
      console.log(`APPLIED        ${tag}  ${portraitNote}`)
      console.log(`  $set: ${JSON.stringify(printableSet($set))}`)
    } catch (e) {
      failed++
      console.log(`FAILED         ${tag}  ${(e as Error).message}`)
    }
  }

  console.log(
    `\n${wanted.length} character(s): ${ok} applied, ${noop} no-op, ${missingPng} missing PNG, `
      + `${invalidPng} invalid PNG, ${encodeFailed} encode failed, ${thumbEncodeFailed} thumb encode failed, `
      + `${missingTemplate} missing template, ${missingEntry} missing entry, ${failed} failed.`,
  )
  if (thumbOnly) console.log(`${thumbOnly} character(s) gained only a small image.`)
  if (!args.apply) console.log('Dry run — re-run with --apply --yes-db <name> to write.')
  process.exit(failed > 0 ? 1 : 0)
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('\ningest-cast-portraits failed:', e)
    process.exit(1)
  })
}
