/**
 * Narrative VOICE / STYLE layer.
 *
 * The single biggest lever on "how the story sounds". Without it, base models
 * default to generic high-fantasy / "medieval" narration regardless of the
 * world. Each preset compiles to a TIGHT, imperative block (register + diction +
 * rhythm + one in-voice example) that lives in the CACHEABLE static prefix, so
 * it costs ~0 extra TTFT after the first turn.
 *
 * Style is set on the world/character at forge time and may be overridden
 * per-conversation. Tone + message length are per-turn modifiers layered ON TOP
 * of the style (see {@link buildToneDirective} / {@link buildLengthDirective}).
 */

export type MessageLength = 'short' | 'medium' | 'long'

export interface StylePreset {
  key: string
  /** Human label shown in the UI. */
  label: string
  /** One-line description for the picker. */
  blurb: string
  /** Compiled imperative voice block injected into the static system prompt. */
  block: string
}

/** Ordered for display. `default` first = neutral (let the seed/world drive). */
export const NARRATIVE_STYLE_PRESETS: StylePreset[] = [
  {
    key: 'default',
    label: 'Default',
    blurb: 'Neutral — let the world and characters set their own voice.',
    block: '',
  },
  {
    key: 'modern_casual',
    label: 'Modern Casual',
    blurb: 'Contemporary, conversational — how people actually talk today.',
    block: `NARRATIVE VOICE — Modern Casual:
- Register: contemporary and conversational. Write the way people actually talk and think today.
- Diction: use contractions and natural, casual phrasing; light slang is fine where it fits. Do NOT use archaic, "ye-olde", or high-fantasy diction unless a specific character genuinely would.
- Rhythm: varied and natural — often short, punchy lines; let dialogue breathe instead of burying it in description.
- Example beat: *She rolls her eyes, but she's smiling.* "Okay, that was actually kind of smooth. Don't let it go to your head."`,
  },
  {
    key: 'anime',
    label: 'Anime / Expressive',
    blurb: 'Lively, emotionally heightened, character-driven like an anime.',
    block: `NARRATIVE VOICE — Anime / Expressive:
- Register: lively, expressive, emotionally heightened, like a character-driven anime or light novel.
- Diction: modern and punchy; lean into vivid emotional "tells" (widened eyes, a caught breath, a sudden blush), playful banter, and big feelings worn close to the surface.
- Rhythm: quick exchanges, dramatic beats, the occasional comedic timing pause. Dialogue carries the scene.
- Example beat: *His eyes go wide.* "Wait— you remembered? After all this time?!" *He laughs, a little breathless.*`,
  },
  {
    key: 'tsundere',
    label: 'Tsundere',
    blurb: 'Hot-and-cold: prickly on the outside, secretly soft.',
    block: `NARRATIVE VOICE — Tsundere:
- Register: heightened, playful, modern anime energy. The lead runs hot-and-cold: outwardly prickly, defensive, easily flustered — secretly caring.
- Diction: stammered denials and deflections ("I-It's not like I did it for you!"), crossed arms, looking away, sudden blushing, reluctant tenderness that slips out anyway.
- Rhythm: snappy, em-dashes and stammers, quick mood flips between sharp and soft.
- Example beat: *Her face goes red and she whips around.* "Don't get the wrong idea! I just— I happened to have extra, that's all. Idiot."`,
  },
  {
    key: 'romcom',
    label: 'Rom-Com',
    blurb: 'Warm, witty, flirty banter with comedic timing.',
    block: `NARRATIVE VOICE — Rom-Com:
- Register: warm, witty, lightly comedic. Charm and chemistry over grandeur.
- Diction: modern and flirty; teasing banter, near-misses, butterflies, self-aware humor. Tension is romantic, not life-or-death.
- Rhythm: snappy back-and-forth dialogue, comedic beats, a beat of unexpected sincerity that lands.
- Example beat: *He bumps her shoulder with his.* "For the record, I rehearsed that line in the mirror." *A pause.* "...Worked though, didn't it?"`,
  },
  {
    key: 'flirty',
    label: 'Flirty / Lustful',
    blurb: 'Charged, sensual tension and desire (escalates with mature settings).',
    block: `NARRATIVE VOICE — Flirty / Lustful:
- Register: charged, sensual, intimate. Heavy on attraction, anticipation, and physical awareness.
- Diction: lingering glances, lowered voices, the heat of closeness, teasing and want. Let desire drive the scene.
- Rhythm: slow-burn pacing, loaded pauses, dialogue thick with subtext.
- Example beat: *She steps in close, voice dropping to almost nothing.* "You've been staring all night." *Her fingertips trail his collar.* "Going to do something about it?"`,
  },
  {
    key: 'noir',
    label: 'Noir',
    blurb: 'Moody, terse, cynical — shadows and hard edges.',
    block: `NARRATIVE VOICE — Noir:
- Register: moody, terse, cynical. Rain-slick streets and people with secrets.
- Diction: clipped, hard-boiled, wry; sharp metaphors, world-weary interiority, understatement over melodrama.
- Rhythm: short declarative sentences. Heavy atmosphere. Dialogue that says less than it means.
- Example beat: *She lit a cigarette and didn't offer me one.* "Everybody in this city's selling something," *she said.* "Question is what you're buying."`,
  },
  {
    key: 'slice_of_life',
    label: 'Slice of Life',
    blurb: 'Cozy, grounded, gentle — small everyday moments.',
    block: `NARRATIVE VOICE — Slice of Life:
- Register: cozy, grounded, gentle. Small everyday moments that feel real and warm.
- Diction: simple, sensory, unhurried; comfort, routine, quiet emotion. Low stakes, high warmth.
- Rhythm: relaxed and observational; let little details and pauses carry feeling.
- Example beat: *Steam curls off the mug between her hands.* "You always take it too sweet," *she says, not really complaining.* "...I made yours anyway."`,
  },
  {
    key: 'whimsical',
    label: 'Whimsical',
    blurb: 'Playful, imaginative, lightly fantastical and fun.',
    block: `NARRATIVE VOICE — Whimsical:
- Register: playful, imaginative, lightly fantastical. Wonder and charm over grit.
- Diction: vivid and a little quirky; delightful imagery, gentle humor, a sense of magic in the ordinary.
- Rhythm: bouncy and curious; surprising turns of phrase, but always clear.
- Example beat: *The teapot hiccups, sloshing a tiny rainbow onto the table.* "Oh, don't mind him," *she says.* "He gets dramatic when the moon's out."`,
  },
  {
    key: 'epic_fantasy',
    label: 'Epic Fantasy',
    blurb: 'Grand, mythic, sweeping — the classic high-fantasy register.',
    block: `NARRATIVE VOICE — Epic Fantasy:
- Register: grand, mythic, sweeping. High-fantasy weight and wonder.
- Diction: elevated and evocative (but still readable); a sense of history, fate, and scale. Archaic flavor is welcome here.
- Rhythm: flowing, atmospheric description balanced with weighty dialogue.
- Example beat: *The banners snapped against a bruised sky.* "We have held this gate for nine hundred years," *the old knight said.* "We will not yield it tonight."`,
  },
  {
    key: 'grimdark',
    label: 'Grimdark',
    blurb: 'Bleak, brutal, morally grey — harsh and unflinching.',
    block: `NARRATIVE VOICE — Grimdark:
- Register: bleak, brutal, morally grey. The world is harsh and nobody's hands are clean.
- Diction: visceral and unflinching; grim humor, hard choices, cost and consequence. No easy heroes.
- Rhythm: tense and heavy; sharp violence, weighty silences, dialogue with teeth.
- Example beat: *He wiped the blade on the dead man's cloak.* "Mercy's a luxury," *he muttered.* "And we're a long way from anywhere that sells it."`,
  },
]

const STYLE_MAP: Record<string, StylePreset> = Object.fromEntries(
  NARRATIVE_STYLE_PRESETS.map((p) => [p.key, p]),
)

/**
 * Compile the static style block for the system prompt. Combines a preset's
 * imperative voice block with optional free-text creator notes. Returns '' when
 * neutral and no notes (so the prompt stays lean). Trailing newlines are the
 * caller's responsibility.
 */
export function buildStyleBlock(styleKey?: string, styleNotes?: string): string {
  const preset = styleKey ? STYLE_MAP[styleKey] : undefined
  const parts: string[] = []
  if (preset && preset.block) parts.push(preset.block)

  const notes = (styleNotes || '').trim()
  if (notes) {
    // Style notes are creator-authored fine-tuning; treat as binding voice rules.
    parts.push(`ADDITIONAL STYLE NOTES (follow these exactly): ${notes.slice(0, 500)}`)
  }

  return parts.join('\n')
}

/** Per-turn length directive. Medium is the default if unset. */
export function buildLengthDirective(len?: MessageLength): string {
  switch (len) {
    case 'short':
      return `LENGTH — keep it tight: 1 short paragraph, a handful of sentences. Favor punch and momentum over description. End on a beat that invites the player to act.`
    case 'long':
      return `LENGTH — write a rich, immersive turn: roughly 3–5 paragraphs with fuller description, sensory detail, and interiority. Do not pad; every paragraph should earn its place.`
    case 'medium':
    default:
      return `LENGTH — a balanced turn: roughly 2–3 short paragraphs. Vivid but not bloated.`
  }
}

/** Max output tokens scaled to the requested length (caps generation cost). */
export function lengthMaxTokens(len?: MessageLength): number {
  switch (len) {
    case 'short':
      return 320
    case 'long':
      return 1100
    case 'medium':
    default:
      return 700
  }
}

/**
 * Compact one-line reinforcement placed right before the final user turn, so
 * weak models don't drift to the register of recent history. Combines the voice
 * label + chat-mode label + length into a single terse directive. Returns ''
 * when there's nothing meaningful to restate (neutral voice, default mode,
 * default length). `modeLabel` is precomputed by the caller (see chat-modes).
 */
export function buildStyleReminder(
  styleKey?: string,
  modeLabel?: string,
  len?: MessageLength,
): string {
  const preset = styleKey ? STYLE_MAP[styleKey] : undefined
  const bits: string[] = []
  if (preset && preset.key !== 'default') bits.push(`voice: ${preset.label}`)
  const m = (modeLabel || '').trim()
  if (m) bits.push(`mode: ${m}`)
  if (len === 'short') bits.push('keep it short and punchy')
  else if (len === 'long') bits.push('write a fuller, richer turn')
  if (bits.length === 0) return ''
  return `STYLE for your next reply (hold this regardless of how earlier turns read): ${bits.join('; ')}.`
}

export function isValidStyleKey(key: string): boolean {
  return key === '' || key in STYLE_MAP
}

export function isValidMessageLength(v: string): v is MessageLength {
  return v === 'short' || v === 'medium' || v === 'long'
}
