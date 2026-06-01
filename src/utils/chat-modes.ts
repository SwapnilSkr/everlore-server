/**
 * CHAT MODES — the player's per-conversation lever for HOW THE CHAT FLOWS
 * (pacing, intent, escalation, emotional distance). This is deliberately
 * ORTHOGONAL to narrative style (narrative-styles.ts):
 *
 *   - narrative_style = how it's WRITTEN (diction/register/rhythm). LOCKED by the
 *     creator at world/character creation. Objective truth; players never change it.
 *   - chat mode = how the CHAT BEHAVES (pace/initiative/heat). Chosen by the
 *     player per conversation. Must NOT touch diction — so it can never fight the
 *     locked voice. Every directive is subordinate to the voice and the
 *     character's nature.
 *
 * Mode is an instance-level setting (default 'free_play'); it is not stored on
 * the template. `ardent` additionally acts as the structured NSFW on-ramp (see
 * generation.processor) when the world is mature-capable and the player opted in.
 */

export interface ChatMode {
  key: string
  label: string
  blurb: string
  /** Behavioral directive injected per-turn. '' for the neutral default. */
  directive: string
}

/** Suffix appended to every non-empty directive to guarantee it never overrides
 *  the locked voice or rewrites the character. */
const SUBORDINATE =
  ' (This shapes pacing and intent ONLY — keep the established narrative voice and the character\'s core nature fully intact.)'

export const CHAT_MODES: ChatMode[] = [
  {
    key: 'free_play',
    label: 'Free Play',
    blurb: 'Versatile and responsive — follows your lead.',
    // Neutral default: no directive keeps the common-case prompt lean.
    directive: '',
  },
  {
    key: 'saga',
    label: 'Saga',
    blurb: 'Plot momentum — events, stakes, and twists.',
    directive:
      'CHAT MODE — Saga: drive the story forward. Introduce events, complications, and consequences; give scenes momentum and stakes. Do not wait passively — make things happen while staying true to the world.',
  },
  {
    key: 'slow_burn',
    label: 'Slow Burn',
    blurb: 'Closeness builds gradually — small, tender moments.',
    directive:
      'CHAT MODE — Slow Burn: build closeness gradually. Favor small, intimate moments, lingering attention, and emotional tension over rushing. Let connection deepen step by step.',
  },
  {
    key: 'grounded',
    label: 'Grounded',
    blurb: 'Natural and present — real, understated reactions.',
    directive:
      'CHAT MODE — Grounded: keep it natural and present. React the way a real person would — understated, believable, unforced. Less theatrical flourish, more authenticity.',
  },
  {
    key: 'composed',
    label: 'Composed',
    blurb: 'Calm and measured — restrained and even-keeled.',
    directive:
      'CHAT MODE — Composed: stay calm and measured. Responses are restrained, even-keeled, and unhurried; strong emotion stays controlled beneath the surface.',
  },
  {
    key: 'ardent',
    label: 'Ardent',
    blurb: 'Passionate and fast — heat rises quickly.',
    directive:
      'CHAT MODE — Ardent: passionate and fast-paced. Lean into desire, heat, and bold escalation; let tension build quickly and physically. Escalate the SITUATION boldly — never abandon who the character is.',
  },
]

const MODE_MAP: Record<string, ChatMode> = Object.fromEntries(
  CHAT_MODES.map((m) => [m.key, m]),
)

export const DEFAULT_CHAT_MODE = 'free_play'

/** The mode that forces the NSFW path (when allowed). */
export const NSFW_MODE = 'ardent'

/** Per-turn behavioral directive for the chosen mode. '' for the default. */
export function buildModeDirective(modeKey?: string): string {
  const mode = modeKey ? MODE_MAP[modeKey] : undefined
  if (!mode || !mode.directive) return ''
  return mode.directive + SUBORDINATE
}

/** Short label for the pre-user-turn reminder. '' for the default. */
export function modeReminderLabel(modeKey?: string): string {
  const mode = modeKey ? MODE_MAP[modeKey] : undefined
  if (!mode || mode.key === DEFAULT_CHAT_MODE) return ''
  return mode.label
}

export function isValidModeKey(key: string): boolean {
  return key in MODE_MAP
}
