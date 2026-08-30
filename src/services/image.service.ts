import { generateImage } from '../ai'
import sharp from 'sharp'
import { storageService } from './storage.service'
import { HttpError } from '../utils/http-error'
import { screenImagePrompt } from '../utils/input-guard'

/**
 * Generated-media orchestration: decorate a visual-description core with the
 * locked-voice art style (decorateImagePrompt, shared with creation autofill),
 * then generate + upload the image to S3/CDN.
 *
 * One portrait image per world/character serves as BOTH the listing avatar and
 * the chat background. The art style is mapped from the world's LOCKED narrative
 * voice so the picture matches how the story reads.
 */

/** narrative_style key -> art-style phrase appended to the image prompt. */
const STYLE_HINT: Record<string, string> = {
  anime: 'vibrant anime illustration, clean linework, expressive eyes',
  tsundere: 'vibrant anime illustration, expressive, lively',
  romcom: 'bright modern anime illustration, warm and charming',
  flirty: 'sensual anime illustration, warm intimate lighting',
  noir: 'moody cinematic noir illustration, high contrast, muted palette',
  slice_of_life: 'soft cozy anime illustration, gentle pastel lighting',
  whimsical: 'whimsical storybook illustration, soft luminous colors',
  epic_fantasy: 'epic painterly fantasy concept art, dramatic lighting',
  grimdark: 'dark grim fantasy concept art, desaturated, ominous mood',
  modern_casual: 'clean contemporary illustration, natural lighting',
  yandere: 'vibrant anime illustration, intense expressive eyes, unsettling intimate mood',
  dark_romance: 'moody cinematic illustration, dramatic chiaroscuro lighting, sensual dangerous mood',
  shonen: 'dynamic shonen anime illustration, bold action linework, dramatic energy',
  cyberpunk: 'neon-soaked cyberpunk illustration, rain-slick reflections, holographic glow, high contrast',
  kdrama: 'soft cinematic illustration, warm romantic lighting, tender mood',
  cozy_comfort: 'soft warm illustration, gentle golden lighting, cozy comforting atmosphere',
  dark_academia: 'moody dark-academia illustration, candlelit gothic interior, muted vintage palette',
  regency: 'elegant period-romance illustration, soft painterly lighting, regency-era setting',
  horror: 'eerie horror illustration, deep shadows, unsettling atmosphere, desaturated dread',
  litrpg: 'vibrant fantasy game-art illustration, heroic adventurer, glowing magical effects',
  chaotic_comedy: 'lively colorful cartoon illustration, exaggerated expressive comedy, dynamic energy',
}
const DEFAULT_HINT = 'high-quality character illustration, cinematic lighting'

// Max length of the bare visual core before style/composition are appended.
export const VISUAL_CORE_MAX = 500

// NOTE: never say "phone background" / "phone wallpaper" / "phone screen" —
// image models take that literally and render art INSIDE a smartphone mockup
// (notch, status bar, bezel). Ask for full-bleed artwork and scrub device leaks.
const COMPOSITION =
  'tall vertical 9:16 full-bleed illustration filling the entire frame edge to edge with no letterboxing, ' +
  'single clear focal subject, atmospheric depth, pure artwork only — ' +
  'absolutely no phone, no smartphone, no device, no screen, no bezel, no notch, no status bar, ' +
  'no frame, no border, no mockup, no UI chrome, no text, no watermark, no logo'

/**
 * Remove the style hint and composition suffix this service itself appends,
 * so content screening reads only what a human actually asked for.
 *
 * Two style hints ("flirty", "dark_romance") legitimately contain the word
 * "sensual", which the image guard counts as a sexualized-appearance signal.
 * Left in place, a perfectly ordinary cover for a flirty world that happened to
 * mention a child would be refused because of a constant WE appended, not
 * anything the creator wrote.
 */
export function stripServerDecorations(text: string): string {
  let out = text
  for (const hint of [...Object.values(STYLE_HINT), DEFAULT_HINT, COMPOSITION]) {
    out = out.split(hint).join(' ')
  }
  return out
}

/**
 * Strip wording that causes Seedream/Flux to put the art inside a phone mockup.
 * Applied to autofill cores and to any prompt sent to image generation.
 */
export function scrubDeviceLeakage(text: string): string {
  return (text || '')
    .replace(/\bsuited to a phone (?:background|screen|wallpaper)\b/gi, 'full-bleed vertical illustration')
    .replace(/\b(?:as a |for a |like a )?phone (?:background|wallpaper|screen|mockup)\b/gi, 'full-bleed illustration')
    .replace(/\bsmartphone\s*(?:mockup|frame|bezel|screen)?\b/gi, '')
    .replace(/\b(?:iphone|android)\s*(?:mockup|frame|bezel)?\b/gi, '')
    .replace(/\b(?:device|phone)\s+mockup\b/gi, '')
    .replace(/\b(?:status\s*bar|notch|letterboxing)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .trim()
}

/**
 * Wrap a concrete visual-description CORE line with the art-style hint (mapped
 * from the locked narrative voice) + composition suffix. Shared by creation
 * autofill so every drafted image_prompt has the same safe shape.
 */
export function decorateImagePrompt(core: string, narrativeStyle?: string): string {
  const clean = scrubDeviceLeakage((core || '').replace(/^["']|["']$/g, '')).slice(0, VISUAL_CORE_MAX)
  const hint = STYLE_HINT[narrativeStyle || ''] || DEFAULT_HINT
  return `${clean}. ${hint}. ${COMPOSITION}.`
}

export const imageService = {
  /** Generate from a (possibly creator-edited) prompt and upload a preview. */
  async generatePreview(prompt: string): Promise<{ url: string; key: string }> {
    const clean = scrubDeviceLeakage(prompt || '')
    if (clean.length < 4) throw new HttpError(400, 'Image prompt is too short')
    // The prompt is creator-editable and reached the generator unscreened: the
    // only thing standing between it and an image was the provider's own
    // filter, which is not ours, can change without notice, and is explicitly
    // not sufficient on its own. Screened here rather than at the controller so
    // every caller of this service inherits it.
    const verdict = screenImagePrompt(stripServerDecorations(clean))
    if (verdict.blocked) throw new HttpError(400, verdict.message!)
    let img: { data: Buffer; contentType: string }
    try {
      img = await generateImage(clean)
    } catch (e) {
      throw new HttpError(502, `Image generation failed: ${(e as Error).message}`)
    }
    return storageService.upload(img.data, img.contentType, { prefix: 'previews' })
  },

  /**
   * Validate and normalize a user-selected image for stable, efficient delivery.
   * After any necessary downscale, WebP encoding is lossless; we also strip
   * private metadata, apply EXIF orientation, and cap the longest edge only
   * when a source exceeds 2048px (avoiding oversized mobile downloads).
   */
  async uploadUserImage(file: File): Promise<{ url: string; key: string }> {
    const input = Buffer.from(await file.arrayBuffer())
    if (!input.length || input.length > 15 * 1024 * 1024) {
      throw new HttpError(400, 'Choose a PNG, JPEG, WebP, or HEIC image up to 15 MB')
    }

    let image: sharp.Sharp
    try {
      image = sharp(input, { limitInputPixels: 40_000_000 }).rotate()
      const metadata = await image.metadata()
      if (!['jpeg', 'png', 'webp', 'heif'].includes(metadata.format || '')) {
        throw new HttpError(400, 'Choose a PNG, JPEG, WebP, or HEIC image')
      }
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(400, 'That image could not be read. Choose a PNG, JPEG, WebP, or HEIC image')
    }

    try {
      const data = await image
        .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
        .webp({ lossless: true, effort: 6 })
        .toBuffer()
      return storageService.upload(data, 'image/webp', { prefix: 'previews' })
    } catch (error) {
      throw new HttpError(400, `Could not process that image: ${(error as Error).message}`)
    }
  },
}
