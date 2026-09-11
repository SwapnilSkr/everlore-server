/**
 * Iron Verdict asset pipeline: raw generated PNGs in, CDN-ready WebP out.
 *
 *   bun run assets:process                 # reads the default drop folder
 *   bun run assets:process -- --upload     # ...and publishes to S3/CloudFront
 *   bun run assets:process -- --in <dir>   # or point it somewhere else
 *
 * Cut-outs (sprites, portraits) are generated on flat chroma green because no
 * image model returns a real alpha channel — they paint a fake checkerboard
 * instead. So the green has to come off here, and it has to come off at full
 * resolution: matting a downscaled image bakes the contaminated edge pixels in
 * and every building ends up with a green fringe against dark terrain.
 *
 * Nothing is uploaded unless --upload is passed, and a published key is never
 * overwritten. New art always gets a new revision.
 */
import { readdir, mkdir } from 'fs/promises'
import { basename, extname, resolve } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'
import sharp from 'sharp'
import { storageService, isStorageConfigured } from '../src/services/storage.service'
import { assetKey } from '../src/worlds/world-source'
import { requireWorld } from '../src/worlds/world-fixture'

const WORLD = 'iron-verdict'
const authoredWorld = requireWorld(WORLD)
// Imported, not redeclared: two revision constants that must agree is a
// silent-failure waiting to happen.
const REVISION = authoredWorld.revision

type Klass = 'plate' | 'sprite' | 'portrait' | 'scene' | 'texture'

/** Per-class output contract. `cutout` classes get the chroma key. */
const CLASSES: Record<Klass, {
  cutout: boolean
  width: number
  height?: number
  quality: number
  /** Soft ceiling in bytes; quality steps down until it fits. */
  budget: number
}> = {
  // The map is the thing players stare at longest, so plates keep the most
  // pixels. They are loaded one at a time, never all five at once.
  plate:    { cutout: false, width: 2048, quality: 80, budget: 900_000, },
  sprite:   { cutout: true,  width: 1024, quality: 82, budget: 200_000, },
  portrait: { cutout: true,  width: 1024, quality: 82, budget: 260_000, },
  scene:    { cutout: false, width: 1080, height: 1920, quality: 82, budget: 300_000, },
  texture:  { cutout: false, width: 512,  quality: 85, budget: 60_000, },
}

function classify(name: string): Klass | null {
  if (name.startsWith('plate_')) return 'plate'
  if (name.startsWith('sprite_')) return 'sprite'
  if (name.startsWith('portrait_')) return 'portrait'
  if (name.startsWith('scene_') || name.startsWith('duel_stage_')) return 'scene'
  if (name.startsWith('texture_')) return 'texture'
  return null
}

// ---------------------------------------------------------------- chroma key

/** Green excess: how much greener than the strongest other channel a pixel is. */
function greenExcess(r: number, g: number, b: number): number {
  return g - Math.max(r, b)
}

const KEY_LOW = 18   // below this a pixel is subject, never background
const KEY_HIGH = 70  // above this a pixel is pure backing, fully transparent

/**
 * Key the backing out of a cut-out.
 *
 * The naive per-pixel key punches holes in anything legitimately green — ivy on
 * the ruined chapel, the olive groves, verdigris on the sundial. So candidate
 * pixels are flood-filled inward from the border instead, and only backing that
 * is actually *connected to the edge* is removed. Interior green survives.
 *
 * Returns null when the image has no green backing at all, which is how a
 * checkerboard-instead-of-alpha reject gets caught rather than silently mangled.
 */
async function keyChroma(input: sharp.Sharp): Promise<sharp.Sharp | null> {
  const { data, info } = await input.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: w, height: h, channels: ch } = info
  const px = w * h

  const excess = new Int16Array(px)
  let candidates = 0
  for (let i = 0; i < px; i++) {
    const o = i * ch
    const e = greenExcess(data[o], data[o + 1], data[o + 2])
    excess[i] = e
    if (e > KEY_LOW) candidates++
  }

  // Sample the actual backing colour from the border rather than assuming the
  // nominal #00B140 — generators drift, and the real plate came back (3,171,59).
  const bs: number[][] = [[], [], []]
  const sample = (i: number) => {
    if (excess[i] <= KEY_HIGH) return
    const o = i * ch
    bs[0].push(data[o]); bs[1].push(data[o + 1]); bs[2].push(data[o + 2])
  }
  for (let x = 0; x < w; x++) { sample(x); sample((h - 1) * w + x) }
  for (let y = 0; y < h; y++) { sample(y * w); sample(y * w + w - 1) }
  const mid = (a: number[]) => a.length ? a.sort((p, q) => p - q)[a.length >> 1] : 0
  const backing = [mid(bs[0]), mid(bs[1]), mid(bs[2])]
  // A real chroma plate is most of the frame. Well under that means the model
  // returned something else — a checkerboard, or a painted scene.
  if (candidates / px < 0.15) return null

  // Flood fill the backing inward from every border pixel.
  const bg = new Uint8Array(px)
  const stack: number[] = []
  const push = (i: number) => { if (!bg[i] && excess[i] > KEY_LOW) { bg[i] = 1; stack.push(i) } }
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x) }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1) }
  while (stack.length) {
    const i = stack.pop()!
    const x = i % w, y = (i / w) | 0
    if (x > 0) push(i - 1)
    if (x < w - 1) push(i + 1)
    if (y > 0) push(i - w)
    if (y < h - 1) push(i + w)
  }

  // Backing that the border flood cannot reach: the sky behind a raised
  // portcullis, a window, an archway. Those regions are enclosed by the
  // building, so connectivity misses them and they survive as solid green.
  //
  // They are cleared on COLOUR PROXIMITY to the sampled backing, not on
  // greenness — that is what keeps ivy, moss, verdigris and spruce. Measured on
  // the real plates: backing sits ~112 green-excess and natural foliage tops out
  // near 99, and in RGB the nearest foliage is ~65 away from the backing colour.
  const ENCLOSED_TOLERANCE = 45
  const tol2 = ENCLOSED_TOLERANCE * ENCLOSED_TOLERANCE
  for (let i = 0; i < px; i++) {
    if (bg[i] || excess[i] <= KEY_LOW) continue
    const o = i * ch
    const dr = data[o] - backing[0], dg = data[o + 1] - backing[1], db = data[o + 2] - backing[2]
    if (dr * dr + dg * dg + db * db < tol2) bg[i] = 1
  }

  // Despill only inside a narrow band around the backing. Bounce light greens
  // the silhouette, but anything legitimately green and *interior* — ivy, moss,
  // verdigris, spruce — must be left alone. Despilling everything drains it.
  const SPILL_RADIUS = 3
  const band = new Uint8Array(px)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bg[y * w + x]) continue
      for (let dy = -SPILL_RADIUS; dy <= SPILL_RADIUS; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -SPILL_RADIUS; dx <= SPILL_RADIUS; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          band[yy * w + xx] = 1
        }
      }
    }
  }

  for (let i = 0; i < px; i++) {
    const o = i * ch
    if (bg[i]) {
      // Ramp rather than a hard cut: partly-green boundary pixels become partly
      // transparent, which is the anti-aliased edge.
      const t = (excess[i] - KEY_LOW) / (KEY_HIGH - KEY_LOW)
      data[o + 3] = Math.round(255 * (1 - Math.min(1, Math.max(0, t))))
    }
    if (band[i] && data[o + 3] > 0) {
      const cap = (data[o] + data[o + 2]) / 2
      if (data[o + 1] > cap) data[o + 1] = Math.round(cap + (data[o + 1] - cap) * 0.15)
    }
  }
  return sharp(Buffer.from(data), { raw: { width: w, height: h, channels: ch as 4 } })
}

/** Crop to the subject so placement coordinates mean the building, not padding. */
async function trimAlpha(img: sharp.Sharp): Promise<sharp.Sharp> {
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true })
  const { width: w, height: h, channels: ch } = info
  let top = h, left = w, right = -1, bottom = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * ch + 3] > 8) {
        if (y < top) top = y
        if (y > bottom) bottom = y
        if (x < left) left = x
        if (x > right) right = x
      }
    }
  }
  if (right < 0) throw new Error('subject is fully transparent after keying')
  const pad = 2 // keep the feathered edge intact
  const x0 = Math.max(0, left - pad), y0 = Math.max(0, top - pad)
  const x1 = Math.min(w - 1, right + pad), y1 = Math.min(h - 1, bottom + pad)
  return sharp(Buffer.from(data), { raw: { width: w, height: h, channels: ch as 4 } })
    .extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 })
}

/** Step quality down until the encode fits its budget. */
async function encode(img: sharp.Sharp, spec: typeof CLASSES[Klass]): Promise<{ buf: Buffer; quality: number }> {
  for (let q = spec.quality; q >= 55; q -= 6) {
    const buf = await img.clone().webp({ quality: q, effort: 6 }).toBuffer()
    if (buf.length <= spec.budget || q === 55) return { buf, quality: q }
  }
  throw new Error('unreachable')
}

// --------------------------------------------------------------------- main

/**
 * Where generated art is dropped. The path has spaces in it, so it is resolved
 * here rather than relied on being quoted correctly at every call site.
 */
const DEFAULT_IN = resolve(homedir(), 'Desktop/sample files/sample files for everlore/world assets')

const args = process.argv.slice(2)
const flagIndex = args.indexOf('--in')
const inDir = flagIndex >= 0 ? resolve(args[flagIndex + 1] || '') : DEFAULT_IN
const doUpload = args.includes('--upload')
if (flagIndex >= 0 && !args[flagIndex + 1]) {
  console.error('usage: bun run assets:process [-- --in <folder>] [--upload]')
  process.exit(1)
}
if (!existsSync(inDir)) {
  console.error(`\u2717 drop folder not found: ${inDir}`)
  process.exit(1)
}
console.log(`\u2022 reading ${inDir}`)
if (doUpload && !isStorageConfigured()) {
  console.error('✗ S3_BUCKET and CDN_BASE_URL must be set to upload')
  process.exit(1)
}

const outDir = resolve(inDir, '../world assets processed')
await mkdir(outDir, { recursive: true })

const files = (await readdir(inDir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort()

/**
 * Plates stack into one tall map, so they must share a width or the stitch has
 * ragged edges. Generators do not honour an exact size request, so the common
 * width is taken from what actually arrived — the narrowest, because upscaling
 * would invent detail the city plate especially cannot afford to fake.
 */
let plateWidth = CLASSES.plate.width
{
  const widths: number[] = []
  for (const file of files) {
    if (classify(basename(file, extname(file)).toLowerCase()) !== 'plate') continue
    const meta = await sharp(resolve(inDir, file), { limitInputPixels: false }).metadata()
    if (meta.width) widths.push(meta.width)
  }
  if (widths.length) {
    plateWidth = Math.min(CLASSES.plate.width, ...widths)
    if (new Set(widths).size > 1) {
      console.log(`\u2022 plates arrived at ${[...new Set(widths)].sort((a, b) => a - b).join('/')}px wide; normalising all to ${plateWidth}px`)
    }
  }
}
type Row = { name: string; klass: Klass; w: number; h: number; bytes: number; quality: number; key: string; url: string | null }
const rows: Row[] = []
const skipped: string[] = []
const failed: string[] = []

for (const file of files) {
  const name = basename(file, extname(file)).toLowerCase()
  const klass = classify(name)
  if (!klass) { skipped.push(`${file} — unrecognised name, no class prefix`); continue }
  const spec = CLASSES[klass]

  try {
    let img = sharp(resolve(inDir, file), { limitInputPixels: false })

    if (spec.cutout) {
      const keyed = await keyChroma(img)
      if (!keyed) {
        failed.push(`${file} — no chroma backing found. If this shows a grey checkerboard the model faked transparency; regenerate it.`)
        continue
      }
      img = await trimAlpha(keyed)
    }

    img = img.resize({
      width: klass === 'plate' ? plateWidth : spec.width,
      height: spec.height,
      fit: spec.height ? 'cover' : 'inside',
      // Plates are forced to the common width even when that means enlarging a
      // narrow one; a ragged stitch is worse than a slightly soft plate.
      withoutEnlargement: klass !== 'plate',
    })

    const { buf, quality } = await encode(img, spec)
    const meta = await sharp(buf).metadata()
    const key = assetKey(WORLD, klass, name, REVISION)
    await Bun.write(resolve(outDir, `${name}.webp`), buf)

    let url: string | null = null
    if (doUpload) {
      if (await storageService.exists(key)) {
        url = storageService.urlForKey(key)
        console.log(`  ${name} → already published, left alone`)
      } else {
        url = (await storageService.upload(buf, 'image/webp', { key })).url
      }
    }
    rows.push({ name, klass, w: meta.width || 0, h: meta.height || 0, bytes: buf.length, quality, key, url })
    const over = buf.length > spec.budget ? ' ⚠ over budget' : ''
    console.log(`✓ ${name.padEnd(34)} ${klass.padEnd(9)} ${meta.width}x${meta.height}  ${(buf.length / 1024).toFixed(0)}KB q${quality}${over}`)
  } catch (error: any) {
    failed.push(`${file} — ${error?.message || error}`)
  }
}

// Contact sheet. Style drift across ~100 assets is invisible one image at a
// time and obvious when they are all on one page.
if (rows.length) {
  const cell = 220, cols = 8
  const sheetRows = Math.ceil(rows.length / cols)
  const tiles = await Promise.all(rows.map(async (r, i) => ({
    input: await sharp(resolve(outDir, `${r.name}.webp`))
      .resize(cell, cell, { fit: 'contain', background: { r: 22, g: 20, b: 18, alpha: 1 } })
      .png().toBuffer(),
    left: (i % cols) * cell,
    top: Math.floor(i / cols) * cell,
  })))
  await sharp({ create: { width: cols * cell, height: sheetRows * cell, channels: 3, background: { r: 22, g: 20, b: 18 } } })
    .composite(tiles).png().toFile(resolve(outDir, '_contact_sheet.png'))
}

const manifest = rows.map(({ name, klass, w, h, bytes, key, url }) => ({ id: name, class: klass, width: w, height: h, bytes, key, url }))
await Bun.write(resolve(outDir, 'manifest.json'), JSON.stringify({ world: WORLD, revision: REVISION, assets: manifest }, null, 2))

// Generated, never hand-edited: the world data needs each asset's real pixel
// size to lay the map out, and a hand-copied number that drifts from the file
// produces a map that renders wrong without erroring. Writing it from the same
// pass that encoded the file is the only way the two cannot disagree.
await Bun.write(
  resolve(import.meta.dir, `../scripts/fixtures/walks/${WORLD}.dimensions.json`),
  // JSON, not a generated .ts module. The old file was TypeScript that this
  // script both WROTE and IMPORTED, so one asset name containing a dot emitted
  // an unquoted key, broke the module, and left the pipeline unable to run and
  // fix its own output.
  JSON.stringify(Object.fromEntries(
    rows.slice().sort((a, b) => a.name.localeCompare(b.name)).map((r) => [r.name, { width: r.w, height: r.h }]),
  ), null, 2) + '\n',
)

const plates = rows.filter((r) => r.klass === 'plate')
if (plates.length) {
  // The authored map_aspect must match the art that actually shipped, or every
  // normalised y coordinate lands in the wrong place.
  const order = ['plate_vaskir', 'plate_north', 'plate_central', 'plate_south', 'plate_serevane']
  const stacked = [...plates].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
  const height = stacked.reduce((n, p) => n + p.h, 0)
  const width = stacked[0].w
  console.log(`\nstitched map: ${width}x${height} (aspect ${(height / width).toFixed(4)})`)
  console.log(`bands: ${stacked.map((p) => `${p.name.replace('plate_', '')} ${(p.h / height * 100).toFixed(1)}%`).join(', ')}`)
}

const total = rows.reduce((n, r) => n + r.bytes, 0)
console.log(`\n${rows.length} processed · ${(total / 1024 / 1024).toFixed(1)}MB total · → ${outDir}`)
for (const s of skipped) console.log(`· skipped ${s}`)
for (const f of failed) console.log(`✗ ${f}`)
if (failed.length) process.exit(1)
