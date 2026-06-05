/**
 * gen-player-avatars.ts — one-shot asset generator for player profile portraits.
 *
 * Generates four cohesive anime character portraits (male, female, non-binary,
 * neutral shonen for skipped gender) and writes them as WebPs into
 * everlore/assets/player-avatars/<key>.webp. Shown on the profile tab instead
 * of initials.
 *
 * Run:   bun run gen:player-avatars            (skips files that already exist)
 *        bun run gen:player-avatars --force     (regenerate everything)
 *
 * Output dir (in precedence order):
 *        --out=<path>                  CLI flag
 *        PLAYER_AVATARS_DIR=<path>     env var
 *        <default>                     everlore/assets/player-avatars
 */
import { mkdir, writeFile, access } from 'fs/promises'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import { generateImage } from '../src/ai'

const DISC_SIZE = 320
const WEBP_QUALITY = 82
const OUT_EXT = 'webp'

async function toDisc(raw: Buffer): Promise<Buffer> {
  return sharp(raw)
    .resize(DISC_SIZE, DISC_SIZE, { fit: 'cover', position: 'centre' })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer()
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT_DIR = resolve(SCRIPT_DIR, '../../everlore/assets/player-avatars')

function resolveOutDir(args: string[]): string {
  const flag = args.find((a) => a.startsWith('--out='))
  if (flag) return resolve(flag.slice('--out='.length))
  if (process.env.PLAYER_AVATARS_DIR) return resolve(process.env.PLAYER_AVATARS_DIR)
  return DEFAULT_OUT_DIR
}

const STYLE_PREFIX =
  'Anime character portrait, head and shoulders, single character, centered, facing the viewer.'
const STYLE_SUFFIX =
  'Cohesive premium anime illustration, soft cinematic rim lighting, 3D-shaded anime style, ' +
  'clean silhouette, expressive detailed face, dark muted background with a soft radial vignette, ' +
  'square composition, no text, no watermark, no logo, no border, no frame.'

const AVATARS: { key: string; subject: string }[] = [
  {
    key: 'male',
    subject:
      'a confident handsome anime young man with sharp features, short dark hair, warm determined eyes, casual modern jacket',
  },
  {
    key: 'female',
    subject:
      'a graceful anime young woman with soft expressive eyes, flowing shoulder-length hair, gentle confident smile, elegant casual attire',
  },
  {
    key: 'non_binary',
    subject:
      'an androgynous stylish anime character with striking balanced features, chic short hair, calm self-assured expression, contemporary fashion',
  },
  {
    key: 'neutral',
    subject:
      'a spirited neutral shonen anime hero with energetic bright eyes, tousled hair, friendly adventurous grin, timeless adventure-ready look',
  },
]

function buildPrompt(subject: string): string {
  return `${STYLE_PREFIX} ${subject}. ${STYLE_SUFFIX}`
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const filterKeys = args.filter((a) => !a.startsWith('--'))
  const outDir = resolveOutDir(args)
  await mkdir(outDir, { recursive: true })

  const targets = filterKeys.length
    ? AVATARS.filter((a) => filterKeys.includes(a.key))
    : AVATARS

  if (targets.length === 0) {
    console.error('No matching avatar keys. Available:', AVATARS.map((a) => a.key).join(', '))
    process.exit(1)
  }

  console.log(`Output → ${outDir}`)
  console.log(`Generating ${targets.length} player avatar(s)…\n`)

  for (const avatar of targets) {
    const outPath = resolve(outDir, `${avatar.key}.${OUT_EXT}`)
    if (!force && (await fileExists(outPath))) {
      console.log(`  ✓ skip  ${avatar.key} (exists)`)
      continue
    }

    console.log(`  → gen   ${avatar.key}`)
    const { data } = await generateImage(buildPrompt(avatar.subject))
    const disc = await toDisc(data)
    await writeFile(outPath, disc)
    console.log(`  ✓ wrote ${outPath} (${(disc.length / 1024).toFixed(1)} KB)`)

    await new Promise((r) => setTimeout(r, 800))
  }

  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
