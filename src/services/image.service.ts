import { callLLM, generateImage, AI_MODELS } from '../ai'
import { storageService } from './storage.service'
import { HttpError } from '../utils/http-error'

/**
 * Generated-media orchestration: suggest a visual prompt from world/character
 * details (auto-suggest, creator-editable), then generate + upload to S3/CDN.
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
}
const DEFAULT_HINT = 'high-quality character illustration, cinematic lighting'

const COMPOSITION =
  'vertical portrait composition suited to a phone background, single clear focal subject, ' +
  'atmospheric depth, no text, no watermark, no logo, no UI'

export const imageService = {
  /**
   * Draft a concise image-generation prompt. Sentient/character worlds → a
   * portrait of the protagonist; GM worlds → an evocative scene of the setting.
   */
  async suggestPrompt(input: {
    title: string
    description?: string
    seedPrompt?: string
    globalLore?: string
    narrativeStyle?: string
    isSentient: boolean
  }): Promise<string> {
    const subjectKind = input.isSentient
      ? 'a single character portrait of the main character described below'
      : 'an evocative establishing scene of the SETTING described below (no specific person)'

    const system = `You write ONE concise image-generation prompt (a single line, under 55 words) for ${subjectKind}. Describe concrete visuals only — subject, appearance, setting, mood, lighting. Do NOT include an art style, medium, camera, or quality words (those are added separately). No preamble, no quotes — output ONLY the prompt.`
    const ctx = [
      `Title: ${input.title}`,
      input.description ? `About: ${input.description}` : '',
      input.seedPrompt ? `Premise/persona: ${input.seedPrompt.slice(0, 800)}` : '',
      input.globalLore ? `Lore: ${input.globalLore.slice(0, 600)}` : '',
    ]
      .filter(Boolean)
      .join('\n')

    let core = ''
    try {
      core = (
        await callLLM({
          model: AI_MODELS.protagonistDerive, // cheap gpt-4o-mini-class
          temperature: 0.7,
          maxTokens: 120,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: ctx },
          ],
        })
      ).trim()
    } catch {
      core = input.isSentient
        ? `${input.title}, a striking character, expressive face`
        : `the world of ${input.title}, sweeping atmospheric vista`
    }
    core = core.replace(/^["']|["']$/g, '').slice(0, 400)

    const hint = STYLE_HINT[input.narrativeStyle || ''] || DEFAULT_HINT
    return `${core}. ${hint}. ${COMPOSITION}.`
  },

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
