import { callLLM, AI_MODELS } from '../ai'
import { decorateImagePrompt } from './image.service'
import { isValidStyleKey } from '../utils/narrative-styles'
import { HttpError } from '../utils/http-error'

/**
 * One-shot creation autofill. Drafts an ENTIRE world or character from a short
 * (optional) brief so the creator starts from a complete, editable draft instead
 * of a blank multi-step form. Uses the cheap/fast authoring model (deepseek-v4-
 * flash by default) with JSON output. Everything it returns is a suggestion the
 * creator can freely edit before forging.
 */

const VALID_STYLE_KEYS = [
  'default', 'modern_casual', 'anime', 'tsundere', 'romcom', 'flirty', 'noir',
  'slice_of_life', 'whimsical', 'epic_fantasy', 'grimdark',
]

export interface WorldDraft {
  title: string
  description: string
  seed_prompt: string
  global_lore: string
  narrative_style: string
  style_notes: string
  opening_line: string
  scene_tags: string[]
  stats: Array<{ name: string; default: number; min: number; max: number; description: string }>
  flags: Array<{ name: string; type: 'boolean' | 'integer' | 'string'; default: boolean | number | string; description: string }>
  image_prompt: string
}

export interface CharacterDraft {
  name: string
  tagline: string
  persona: string
  greeting: string
  backstory: string
  narrative_style: string
  style_notes: string
  image_prompt: string
}

interface AutofillInput {
  brief?: string
  isSentient: boolean
  isNsfwCapable: boolean
  narrativeStyle?: string
}

// ── helpers ───────────────────────────────────────────────────────────────

/** Parse model output as JSON, tolerating code fences / surrounding prose. */
function parseJson(raw: string): Record<string, any> {
  let s = (raw || '').trim()
  // strip ```json … ``` fences if present
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  // fall back to the outermost {...}
  if (!s.startsWith('{')) {
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a >= 0 && b > a) s = s.slice(a, b + 1)
  }
  try {
    return JSON.parse(s)
  } catch {
    throw new HttpError(502, 'The author returned an unreadable draft. Please try again.')
  }
}

const str = (v: any, max: number, fallback = ''): string => {
  const out = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim()
  return (out || fallback).slice(0, max)
}

const num = (v: any, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function cleanStyle(v: any, fallback = ''): string {
  const k = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return k && isValidStyleKey(k) ? k : fallback
}

function cleanTags(v: any): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((t) => String(t).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''))
    .filter((t) => t.length > 0 && t.length <= 30)
    .slice(0, 8)
}

function cleanStats(v: any): WorldDraft['stats'] {
  const arr = Array.isArray(v) ? v : []
  const out = arr
    .map((s) => {
      const name = str(s?.name, 40)
      if (!name) return null
      const min = num(s?.min, 0)
      const max = num(s?.max, 100)
      const lo = Math.min(min, max)
      const hi = Math.max(min, max, lo + 1)
      const def = Math.max(lo, Math.min(hi, num(s?.default, Math.round((lo + hi) / 2))))
      return { name, default: def, min: lo, max: hi, description: str(s?.description, 200) }
    })
    .filter((s): s is WorldDraft['stats'][number] => s !== null)
    .slice(0, 6)
  // Worlds require at least one stat — guarantee a sensible default.
  if (out.length === 0) {
    out.push({ name: 'Resolve', default: 50, min: 0, max: 100, description: 'Inner strength and determination.' })
  }
  return out
}

function cleanFlags(v: any): WorldDraft['flags'] {
  const arr = Array.isArray(v) ? v : []
  return arr
    .map((f) => {
      const name = str(f?.name, 40)
      if (!name) return null
      let type: 'boolean' | 'integer' | 'string' = 'boolean'
      if (f?.type === 'integer' || f?.type === 'string') type = f.type
      let def: boolean | number | string
      if (type === 'integer') def = Math.round(num(f?.default, 0))
      else if (type === 'string') def = str(f?.default, 80)
      else def = Boolean(f?.default)
      return { name, type, default: def, description: str(f?.description, 200) }
    })
    .filter((f): f is WorldDraft['flags'][number] => f !== null)
    .slice(0, 4)
}

function styleGuidance(isNsfw: boolean): string {
  return [
    'Pick the narrative_style key that best fits the concept from this exact set:',
    'default, modern_casual, anime, tsundere, romcom, flirty, noir, slice_of_life, whimsical, epic_fantasy, grimdark.',
    isNsfw
      ? 'Mature themes are permitted; you may lean flirty/romantic where it fits, but keep the draft itself non-explicit.'
      : 'Keep everything strictly safe-for-work.',
  ].join(' ')
}

// ── world ───────────────────────────────────────────────────────────────

export const autofillService = {
  async autofillWorld(input: AutofillInput): Promise<WorldDraft> {
    const lockedStyle = cleanStyle(input.narrativeStyle)
    const kind = input.isSentient
      ? 'a CONSCIOUS world — it has its own AI persona that thinks, feels and speaks AS a character inside the story'
      : 'a GAME-MASTER world — the AI is a neutral narrator orchestrating events while the player acts freely'

    const system = [
      `You are a world-design assistant for an immersive AI roleplay app. Draft ${kind}.`,
      'Return ONLY a JSON object (no markdown, no prose) with EXACTLY these keys:',
      '{',
      '"title": short evocative world name (2-5 words),',
      '"description": one compelling paragraph (2-3 sentences) shown in the browser,',
      '"seed_prompt": the core system premise the AI runs on — who/what the world is, its central situation, what the player does (3-6 sentences, second person where natural),',
      '"global_lore": key facts, factions, places, rules, history the AI must always know (one rich paragraph),',
      '"narrative_style": one key from the allowed set,',
      '"style_notes": one short sentence of extra voice guidance (may be empty string),',
      '"opening_line": the very first line the world says to open the scene (immersive, in-voice),',
      '"scene_tags": 3-6 short lowercase_snake tags describing settings/moods,',
      '"stats": 3-5 player attributes, each {name, default(0-100), min, max, description},',
      '"flags": 0-3 world state flags, each {name, type("boolean"|"integer"|"string"), default, description},',
      '"visual": ONE concrete line describing what an establishing image of this world looks like — place, atmosphere, lighting (no art-style or quality words)',
      '}',
      lockedStyle
        ? `The narrative_style MUST be "${lockedStyle}" (the creator locked it).`
        : styleGuidance(input.isNsfwCapable),
      'Make it vivid, specific, and genuinely fun to play — avoid generic medieval filler unless the brief asks for it.',
    ].join('\n')

    const user = input.brief?.trim()
      ? `Creator's brief: ${input.brief.trim().slice(0, 1500)}`
      : 'No brief given — invent something fresh, original and immediately engaging.'

    const raw = await callLLM({
      model: AI_MODELS.authoring,
      temperature: 0.9,
      maxTokens: 1400,
      responseFormat: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    })

    const j = parseJson(raw)
    const style = lockedStyle || cleanStyle(j.narrative_style)
    return {
      title: str(j.title, 200, 'Untitled World'),
      description: str(j.description, 2000),
      seed_prompt: str(j.seed_prompt, 10000),
      global_lore: str(j.global_lore, 50000),
      narrative_style: style,
      style_notes: str(j.style_notes, 500),
      opening_line: str(j.opening_line, 2000),
      scene_tags: cleanTags(j.scene_tags),
      stats: cleanStats(j.stats),
      flags: cleanFlags(j.flags),
      image_prompt: decorateImagePrompt(str(j.visual, 400, str(j.title, 200)), style),
    }
  },

  async autofillCharacter(input: AutofillInput): Promise<CharacterDraft> {
    const lockedStyle = cleanStyle(input.narrativeStyle)
    const system = [
      'You design vivid, talkable AI roleplay characters. Draft ONE character the user will chat with.',
      'Return ONLY a JSON object (no markdown, no prose) with EXACTLY these keys:',
      '{',
      '"name": the character\'s name,',
      '"tagline": one short line capturing who they are at a glance,',
      '"persona": how they think, talk, and treat the user — mood, quirks, speech patterns, relationship dynamic (one rich paragraph, second person to the user where natural),',
      '"greeting": the first thing they say when the chat opens (in their voice),',
      '"backstory": their past, world, and relationships the AI should always know (one paragraph),',
      '"narrative_style": one key from the allowed set,',
      '"style_notes": one short sentence of extra voice guidance (may be empty string),',
      '"visual": ONE concrete line describing the character\'s appearance — face, hair, build, clothing, expression, setting (no art-style or quality words)',
      '}',
      lockedStyle
        ? `The narrative_style MUST be "${lockedStyle}" (the creator locked it).`
        : styleGuidance(input.isNsfwCapable),
      'Give them a distinct, memorable voice — not a generic assistant.',
    ].join('\n')

    const user = input.brief?.trim()
      ? `Creator's brief: ${input.brief.trim().slice(0, 1500)}`
      : 'No brief given — invent a fresh, original, immediately engaging character.'

    const raw = await callLLM({
      model: AI_MODELS.authoring,
      temperature: 0.9,
      maxTokens: 1100,
      responseFormat: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    })

    const j = parseJson(raw)
    const style = lockedStyle || cleanStyle(j.narrative_style)
    return {
      name: str(j.name, 120, 'Unnamed'),
      tagline: str(j.tagline, 400),
      persona: str(j.persona, 10000),
      greeting: str(j.greeting, 2000),
      backstory: str(j.backstory, 50000),
      narrative_style: style,
      style_notes: str(j.style_notes, 500),
      image_prompt: decorateImagePrompt(str(j.visual, 400, str(j.name, 120)), style),
    }
  },
}
