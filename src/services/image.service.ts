import { generateImage } from '../ai'
import { storageService } from './storage.service'
import { HttpError } from '../utils/http-error'

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

const COMPOSITION =
  'vertical portrait composition suited to a phone background, single clear focal subject, ' +
  'atmospheric depth, no text, no watermark, no logo, no UI'

/**
 * Wrap a concrete visual-description CORE line with the art-style hint (mapped
 * from the locked narrative voice) + composition suffix. Shared by suggestPrompt
 * and the creation autofill so both produce identically-shaped image prompts.
 */
export function decorateImagePrompt(core: string, narrativeStyle?: string): string {
  const clean = (core || '').replace(/^["']|["']$/g, '').trim().slice(0, 400)
  const hint = STYLE_HINT[narrativeStyle || ''] || DEFAULT_HINT
  return `${clean}. ${hint}. ${COMPOSITION}.`
}

export const imageService = {
  /** Generate from a (possibly creator-edited) prompt and upload a preview. */
  async generatePreview(prompt: string): Promise<{ url: string; key: string }> {
    const clean = (prompt || '').trim()
    if (clean.length < 4) throw new HttpError(400, 'Image prompt is too short')
    let img: { data: Buffer; contentType: string }
    try {
      img = await generateImage(clean)
    } catch (e) {
      throw new HttpError(502, `Image generation failed: ${(e as Error).message}`)
    }
    return storageService.upload(img.data, img.contentType, { prefix: 'previews' })
  },
}
