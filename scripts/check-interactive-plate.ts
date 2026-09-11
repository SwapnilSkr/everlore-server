/**
 * Verify a terrain plate's authored places for the MARKER renderer.
 *
 * The old test asked the opposite question. It counted big open plazas, because
 * a landmark sprite had to be composited into one, and it rejected a plate that
 * was too built up. Sprites are gone: a place is named with a marker drawn over
 * terrain the plate paints ITSELF. So an empty square is no longer a socket, it
 * is a hole in the world, and every anchor now has to land on a painted place.
 *
 *   bun run audit:plate <file.webp|png> <plate_key>
 *
 * WHAT THIS DOES NOT DO, AND WHY. It does not score "is something built here".
 * That was tried and it does not survive contact with real art. Edge energy was
 * the obvious measure and it INVERTS on natural terrain: a snow plate is dense
 * rock, conifer and drift texture everywhere, so a large smooth longhall roof
 * scores BELOW the plate's own median and reads as empty ground. Colour fails
 * the same way - shadowed snow is blue-dominant and dark, so a mountain pass
 * measured 77% "water". Three such detectors were written for this map and all
 * three produced confident, wrong answers.
 *
 * So this emits EVIDENCE and a contact sheet, and leaves the verdict to eyes.
 * A crop of every anchor is written to one image; if a place is missing from
 * the art or the anchor is off it, that is obvious in a single glance and
 * essentially never obvious from a number. The printed statistics describe the
 * ground under each anchor - they are there to direct attention, not to pass
 * or fail, and no threshold in this file gates anything.
 */
import sharp from 'sharp'
import { requireWorld } from '../src/worlds/world-fixture'

const file = process.argv[2]
const plateKey = process.argv[3]
if (!file || !plateKey) {
  console.error('usage: bun run audit:plate <file> <plate_key>')
  console.error('  plate_key: plate_vaskir | plate_north | plate_central | plate_south | plate_serevane')
  process.exit(1)
}

/** Bands of the stitched map each plate occupies, from the delivered art. */
const BANDS: Record<string, [number, number]> = {
  plate_vaskir: [0, 0.2182],
  plate_north: [0.2182, 0.3637],
  plate_central: [0.3637, 0.6363],
  plate_south: [0.6363, 0.7818],
  plate_serevane: [0.7818, 1],
}
const band = BANDS[plateKey]
if (!band) {
  console.error(`unknown plate key "${plateKey}" - expected one of ${Object.keys(BANDS).join(', ')}`)
  process.exit(1)
}
const [yFrom, yTo] = band

const meta = await sharp(file).metadata()
const W = meta.width!, H = meta.height!
const { data } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true })

const at = (x: number, y: number) => {
  const i = (y * W + x) * 3
  return [data[i], data[i + 1], data[i + 2]] as const
}
const lumAt = (x: number, y: number) => {
  const [r, g, b] = at(x, y)
  return (r + g + b) / 3
}

/**
 * Edge energy in a square window. Structure, not brightness: a flat white
 * snowfield and a flat black lake both score near zero, which is the point.
 */
function energy(cx: number, cy: number, rad: number) {
  let sum = 0, n = 0
  const x0 = Math.max(1, cx - rad), x1 = Math.min(W - 2, cx + rad)
  const y0 = Math.max(1, cy - rad), y1 = Math.min(H - 2, cy + rad)
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      sum += Math.abs(lumAt(x, y) - lumAt(x + 1, y)) + Math.abs(lumAt(x, y) - lumAt(x, y + 1))
      n++
    }
  }
  return n ? sum / n : 0
}

/** Blue-dominant and dark: open water reads this way under every sky here. */
function waterFraction(cx: number, cy: number, rad: number) {
  let wet = 0, n = 0
  for (let y = Math.max(0, cy - rad); y <= Math.min(H - 1, cy + rad); y++) {
    for (let x = Math.max(0, cx - rad); x <= Math.min(W - 1, cx + rad); x++) {
      const [r, g, b] = at(x, y)
      if (b > r + 8 && (r + g + b) / 3 < 150) wet++
      n++
    }
  }
  return n ? wet / n : 0
}

// The plate's own median energy, sampled on a coarse grid. Comparing every
// anchor against this makes the test relative to the art rather than to a
// number that only ever suited one plate.
const samples: number[] = []
for (let y = 30; y < H - 30; y += 37) for (let x = 30; x < W - 30; x += 37) samples.push(energy(x, y, 8))
samples.sort((a, b) => a - b)
const median = samples[samples.length >> 1]

// The renderer draws a landmark's marker over a disc of roughly this radius at
// published width; scale it with the file so an oversized render is judged the
// same way.
const K = W / 1122
const RAD = Math.round(24 * K)
const LABEL_W = Math.round(150 * K), LABEL_H = Math.round(16 * K)

const here = requireWorld('iron-verdict').locations.filter((l) => l.sprite.y >= yFrom && l.sprite.y < yTo)
if (!here.length) {
  console.error(`no authored places fall in ${plateKey}'s band - wrong plate key?`)
  process.exit(1)
}

console.log(`${file.split('/').pop()}  ${W}x${H}   ${plateKey}`)
console.log(`${here.length} authored places   plate median edge energy ${median.toFixed(1)}\n`)
console.log('  texture  bluish  contrast   place')

for (const l of here) {
  const cx = Math.round(l.sprite.x * W)
  const cy = Math.round(((l.sprite.y - yFrom) / (yTo - yFrom)) * H)
  const ratio = energy(cx, cy, RAD) / (median || 1)
  const wet = waterFraction(cx, cy, RAD)

  const lx = Math.min(cx + Math.round(12 * K), W - LABEL_W - 1)
  let lo = 255, hi = 0
  for (let y = Math.max(0, cy - LABEL_H); y <= Math.min(H - 1, cy + LABEL_H); y++) {
    for (let x = lx; x < lx + LABEL_W && x < W; x++) {
      const v = lumAt(x, y)
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  console.log(
    `  ${ratio.toFixed(2).padStart(7)}  ${(wet * 100).toFixed(0).padStart(5)}%  ${(hi - lo).toFixed(0).padStart(8)}   ${l.title}`,
  )
}

// The contact sheet is the actual output. Each anchor is cropped at 2x with a
// ring drawn exactly where the marker will sit, so "is the place painted, and
// is the anchor on it" is answered by looking rather than by trusting a number.
const CROP = Math.round(150 * K), CELL = 300
const cols = Math.min(4, here.length)
const rows = Math.ceil(here.length / cols)
const cells = await Promise.all(
  here.map(async (l) => {
    const cx = Math.round(l.sprite.x * W)
    const cy = Math.round(((l.sprite.y - yFrom) / (yTo - yFrom)) * H)
    const left = Math.max(0, Math.min(W - CROP, cx - (CROP >> 1)))
    const top = Math.max(0, Math.min(H - CROP, cy - (CROP >> 1)))
    const r = Math.round((RAD / CROP) * CELL)
    const dx = Math.round(((cx - left) / CROP) * CELL), dy = Math.round(((cy - top) / CROP) * CELL)
    const ring = Buffer.from(
      `<svg width="${CELL}" height="${CELL}">` +
      `<circle cx="${dx}" cy="${dy}" r="${r}" fill="none" stroke="#ff00ff" stroke-width="3"/>` +
      `<text x="6" y="20" font-family="Helvetica" font-size="15" fill="#ff00ff">${l.title.replace(/[<&]/g, '')}</text>` +
      `</svg>`,
    )
    return sharp(file).extract({ left, top, width: CROP, height: CROP })
      .resize(CELL, CELL).composite([{ input: ring }]).png().toBuffer()
  }),
)
// NOT beside the source: the asset pipeline classifies by filename prefix, so a
// sheet called plate_*.anchors.png dropped next to the art gets published AS A
// PLATE and silently lengthens the stitched map.
const sheetPath = `/tmp/${plateKey}.anchors.png`
await sharp({ create: { width: cols * CELL, height: rows * CELL, channels: 3, background: '#111' } })
  .composite(cells.map((input, i) => ({ input, left: (i % cols) * CELL, top: Math.floor(i / cols) * CELL })))
  .png().toFile(sheetPath)

console.log(`\ncontact sheet -> ${sheetPath}`)
console.log('Open it. Every ring must sit on the place its label names.')
console.log('The three numbers above describe the ground under each anchor. They')
console.log('direct attention and decide nothing - see the note at the top of this file.')
