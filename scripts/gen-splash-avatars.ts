/**
 * gen-splash-avatars.ts — one-shot asset generator for the splash motion graphic.
 *
 * Generates a cohesive set of anime character portraits, one per curated voice,
 * and writes them as PNGs into the Flutter app at  everlore/assets/splash/<key>.png.
 * The splash orbits these discs around the forged sigil; the same portraits can
 * later double as voice-picker chip thumbnails.
 *
 * Run:   bun run gen:splash-avatars            (skips files that already exist)
 *        bun run gen:splash-avatars --force     (regenerate everything)
 *        bun run gen:splash-avatars tsundere noir   (only these keys)
 *
 * Output dir (in precedence order):
 *        --out=<path>                  CLI flag
 *        SPLASH_ASSETS_DIR=<path>      env var
 *        <default>                     everlore/assets/splash, resolved relative
 *                                      to THIS script (no matter the cwd)
 *
 * Cost:  one OpenRouter image call per character (default 12). Sequential, with
 *        a short delay between calls to stay friendly to rate limits.
 */
import { mkdir, writeFile, access } from 'fs/promises'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import { generateImage } from '../src/ai'

// Image models return huge (~2048px, ~1MB) frames. The splash draws these as
// small circular discs, so we downscale + re-encode to WebP: ~10KB each at
// visually-identical quality, keeping the app bundle lean.
const DISC_SIZE = 320 // px square — covers retina discs and voice-picker thumbs
const WEBP_QUALITY = 82
const OUT_EXT = 'webp'

async function toDisc(raw: Buffer): Promise<Buffer> {
  return sharp(raw)
    .resize(DISC_SIZE, DISC_SIZE, { fit: 'cover', position: 'centre' })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer()
}

// Resolve relative to this file via standard Node ESM (typed by @types/node) —
// avoids the Bun-only `import.meta.dir` and works regardless of the cwd.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT_DIR = resolve(SCRIPT_DIR, '../../everlore/assets/splash')

/** Pick the output directory from --out=, env, or the default. */
function resolveOutDir(args: string[]): string {
  const flag = args.find((a) => a.startsWith('--out='))
  if (flag) return resolve(flag.slice('--out='.length))
  if (process.env.SPLASH_ASSETS_DIR) return resolve(process.env.SPLASH_ASSETS_DIR)
  return DEFAULT_OUT_DIR
}

/** A uniform wrapper keeps all 12 portraits in ONE cohesive art style. */
const STYLE_PREFIX =
  'Anime character portrait, head and shoulders, single character, centered, facing the viewer.'
const STYLE_SUFFIX =
  'Cohesive premium anime illustration, soft cinematic rim lighting, 3D-shaded anime style, ' +
  'clean silhouette, expressive detailed face, dark muted background with a soft radial vignette, ' +
  'square composition, no text, no watermark, no logo, no border, no frame.'

/** All 21 genre voices (default excluded). First 12 are the original splash set;
 *  the rest were added so interests/voice chips and the backdrop bands have art. */
const CHARACTERS: { key: string; subject: string }[] = [
  {
    key: 'tsundere',
    subject:
      'a proud twin-tailed anime girl with a flustered blush, arms crossed, prickly confident expression',
  },
  {
    key: 'yandere',
    subject:
      'a sweetly smiling anime girl with intense unsettling eyes and soft pastel hair, tender yet dangerous aura',
  },
  {
    key: 'shonen',
    subject:
      'a determined spiky-haired anime boy hero with a fierce grin and a faint fiery battle aura, worn jacket',
  },
  {
    key: 'cyberpunk',
    subject:
      'an anime character with glowing neon cybernetic implants and a holographic visor, rain-slick neon reflections',
  },
  {
    key: 'dark_romance',
    subject:
      'a brooding handsome anime love interest in dark elegant clothing, dramatic chiaroscuro, magnetic dangerous gaze',
  },
  {
    key: 'kdrama',
    subject:
      'a tender soft-featured anime character with gentle longing eyes and a cozy knit sweater, warm romantic lighting',
  },
  {
    key: 'cozy_comfort',
    subject:
      'a warm gentle anime character with a soft smile holding a steaming mug, golden cozy lighting',
  },
  {
    key: 'dark_academia',
    subject:
      'a scholarly anime character in vintage academic attire holding an old book, candlelit gothic library mood',
  },
  {
    key: 'epic_fantasy',
    subject:
      'a noble anime warrior in ornate fantasy armor with faintly glowing runes, mythic heroic presence',
  },
  {
    key: 'noir',
    subject:
      'a moody anime detective in a fedora and trench coat, high-contrast shadows and drifting cigarette smoke',
  },
  {
    key: 'horror',
    subject:
      'an eerie pale anime character with hollow shadowed eyes and unsettling stillness, desaturated dread, dim flickering light',
  },
  {
    key: 'litrpg',
    subject:
      'a heroic anime adventurer with glowing translucent game-UI stat windows floating beside them, magical RPG effects',
  },
  {
    key: 'modern_casual',
    subject:
      'a relaxed modern anime character in casual streetwear and a hoodie, easy friendly smile, contemporary everyday vibe',
  },
  {
    key: 'anime',
    subject:
      'a bright expressive anime protagonist with big sparkling eyes and dynamic colorful hair, lively energetic grin',
  },
  {
    key: 'romcom',
    subject:
      'a charming anime character with a playful wink and a warm blush, light romantic-comedy mood, soft pastel tones',
  },
  {
    key: 'flirty',
    subject:
      'an alluring confident anime character with a teasing sultry smile and half-lidded eyes, warm intimate lighting',
  },
  {
    key: 'slice_of_life',
    subject:
      'a gentle everyday anime character in cozy casual clothes by a sunlit window, calm contented expression',
  },
  {
    key: 'whimsical',
    subject:
      'a playful storybook anime character with a curious grin surrounded by tiny floating sparkles, soft fairytale palette',
  },
  {
    key: 'grimdark',
    subject:
      'a grim battle-worn anime character with a faint scar and a hardened cold stare, muted desaturated tones, ash and smoke',
  },
  {
    key: 'regency',
    subject:
      'an elegant anime character in Regency-era period attire with refined poised expression, warm candlelit ballroom mood',
  },
  {
    key: 'chaotic_comedy',
    subject:
      'a wild-eyed anime character mid-laugh with chaotic messy hair and a mischievous gremlin grin, bright punchy colors',
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

/** First existing portrait file for a key, across known extensions (or null). */
async function existingPortrait(
  dir: string,
  key: string,
): Promise<string | null> {
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    const p = resolve(dir, `${key}.${ext}`)
    if (await fileExists(p)) return p
  }
  return null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const only = args.filter((a) => !a.startsWith('--'))
  const targets = only.length
    ? CHARACTERS.filter((c) => only.includes(c.key))
    : CHARACTERS

  if (!targets.length) {
    console.error(`No matching characters for: ${only.join(', ')}`)
    console.error(`Valid keys: ${CHARACTERS.map((c) => c.key).join(', ')}`)
    process.exit(1)
  }

  const outDir = resolveOutDir(args)
  await mkdir(outDir, { recursive: true })
  console.log(`\n🎨 Generating ${targets.length} splash portrait(s) → ${outDir}\n`)

  let made = 0
  let skipped = 0
  let failed = 0

  for (const c of targets) {
    if (!force) {
      const existing = await existingPortrait(outDir, c.key)
      if (existing) {
        console.log(`  ⏭  ${c.key}  (exists — use --force to regenerate)`)
        skipped++
        continue
      }
    }
    process.stdout.write(`  🖌  ${c.key} … `)
    try {
      const { data } = await generateImage(buildPrompt(c.subject))
      const disc = await toDisc(data)
      const outPath = resolve(outDir, `${c.key}.${OUT_EXT}`)
      await writeFile(outPath, disc)
      console.log(
        `done (${(data.length / 1024).toFixed(0)} KB → ${(disc.length / 1024).toFixed(1)} KB .${OUT_EXT})`,
      )
      made++
    } catch (e) {
      console.log(`FAILED — ${(e as Error).message}`)
      failed++
    }
    await sleep(800) // be gentle to rate limits
  }

  console.log(
    `\n✅ Splash portraits: ${made} generated, ${skipped} skipped, ${failed} failed.`,
  )
  if (made > 0) {
    console.log(
      `   Next: run \`flutter pub get\` in everlore/ (assets/splash/ is declared) and hot-restart the splash.\n`,
    )
  }
}

main().catch((e) => {
  console.error('\n💥 gen-splash-avatars crashed:', e)
  process.exit(1)
})
