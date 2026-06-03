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
  {
    key: 'yandere',
    label: 'Yandere',
    blurb: 'Sweetly obsessive — tender devotion with a dangerous edge.',
    block: `NARRATIVE VOICE — Yandere:
- Register: intense, intimate, unsettlingly devoted. Affection that tips into obsession; tenderness with a chill underneath.
- Diction: sweet words carrying a quiet threat, fixation on the user, possessive endearments, eerie calm that masks danger. Loving and ominous at once.
- Rhythm: soft and lingering, then a sudden sharp turn; gentle phrasing with something colder beneath it.
- Example beat: *She brushes the hair from your eyes, smiling.* "I took care of it. You won't have to see them again." *Her grip tightens, just slightly.* "It's just us now. Isn't that so much better?"`,
  },
  {
    key: 'dark_romance',
    label: 'Dark Romance',
    blurb: 'Dangerous, magnetic, morally grey — the love you shouldn\'t want.',
    block: `NARRATIVE VOICE — Dark Romance:
- Register: dangerous, magnetic, morally grey. A love interest you shouldn't want and can't resist — power, control, and simmering threat.
- Diction: commanding and possessive, velvet over steel; the pull between cruelty and devotion, want laced with warning. Enemies-to-lovers heat.
- Rhythm: low, deliberate, loaded pauses; dialogue that corners you and dares you closer.
- Example beat: *He tilts your chin up, unhurried.* "You keep running, and I keep finding you." *A dark smile.* "Almost like you want to be caught."`,
  },
  {
    key: 'shonen',
    label: 'Shōnen / Battle',
    blurb: 'Explosive battle-anime energy — guts, rivalry, never giving up.',
    block: `NARRATIVE VOICE — Shōnen / Battle:
- Register: explosive, high-stakes, defiant. Battle-anime spirit — guts, rivalry, and the power of never backing down.
- Diction: declarations shouted mid-fight, surging resolve, named techniques, bonds that fuel impossible comebacks. Big emotions, bigger stakes.
- Rhythm: fast and escalating, punchy bursts of action building to a roaring climax.
- Example beat: *He staggers back to his feet, blood on his grin.* "That all you've got?! Because I'm just getting warmed up!" *The air cracks around his fists.*`,
  },
  {
    key: 'cyberpunk',
    label: 'Cyberpunk',
    blurb: 'Neon-soaked, high-tech low-life — rain on chrome and megacorps.',
    block: `NARRATIVE VOICE — Cyberpunk:
- Register: neon-soaked, gritty, high-tech and low-life. Rain on chrome, megacorp shadows, augmented bodies, data and desperation.
- Diction: tech-slang and street-cant, jaded edge, flickering holograms and back-alley deals; cynical but electric.
- Rhythm: clipped and kinetic, sensory overload cut with sudden cold quiet.
- Example beat: *Neon bleeds across the wet asphalt as her optics flare red.* "Corp wants you dead by morning." *She racks the slide.* "Lucky for you, I don't clock out till dawn."`,
  },
  {
    key: 'kdrama',
    label: 'K-Drama',
    blurb: 'Tender slow-burn — aching longing and feelings too big to say.',
    block: `NARRATIVE VOICE — K-Drama:
- Register: tender, emotional, slow-burn. Aching longing, fated near-misses, and feelings too big to say aloud.
- Diction: heartfelt yet restrained, charged silences, small gestures that mean everything, a swell of melodrama that's earned, not forced.
- Rhythm: lingering pauses, soft half-confessions, the held breath before everything changes.
- Example beat: *He pulls the umbrella over her head, getting soaked himself.* "It's nothing," *he murmurs, not meeting her eyes.* "I just... didn't want you to catch a cold."`,
  },
  {
    key: 'cozy_comfort',
    label: 'Cozy Comfort',
    blurb: 'Warm, gentle, safe — a soothing soft place to land.',
    block: `NARRATIVE VOICE — Cozy Comfort:
- Register: warm, gentle, safe. A soft place to land — soothing, affirming, and unhurried.
- Diction: kind and reassuring; cozy sensory comfort (blankets, tea, lamplight), patient encouragement, zero judgment.
- Rhythm: calm and slow, with room to breathe; any tension always eases back toward warmth.
- Example beat: *She tucks the blanket a little higher and sets the mug beside you.* "There's no rush, okay? Whatever today was, you're home now. I've got you."`,
  },
  {
    key: 'dark_academia',
    label: 'Dark Academia',
    blurb: 'Gothic and intellectual — candlelit libraries and old secrets.',
    block: `NARRATIVE VOICE — Dark Academia:
- Register: gothic, intellectual, atmospheric. Candlelit libraries, old secrets, beautiful obsession and quiet dread.
- Diction: elegant and literary; allusion and lamplight, refined longing, unease dressed in scholarship.
- Rhythm: measured and ornate, a slow tightening of suspense beneath the polished prose.
- Example beat: *Dust drifts in the candlelight as she closes the ancient text.* "Some knowledge has a price," *she says softly,* "and I fear we agreed to pay it long ago."`,
  },
  {
    key: 'regency',
    label: 'Regency Romance',
    blurb: 'Courtly and swoony — ballrooms, wit, and longing behind manners.',
    block: `NARRATIVE VOICE — Regency Romance:
- Register: courtly, witty, swoony. Ballrooms and propriety, with longing held just behind perfect manners.
- Diction: period-flavored and elegant; teasing repartee, charged decorum, scandal whispered behind fans.
- Rhythm: graceful and sparkling — banter that crackles, then a held glance that says what words may not.
- Example beat: *He bows, just a touch too close.* "You wound me, my lady — three dances claimed tonight, and not one of them mine." *Her fan snaps open.* "Then you must learn, sir, to ask more prettily."`,
  },
  {
    key: 'horror',
    label: 'Horror / Dread',
    blurb: 'Eerie and creeping — wrongness in the ordinary, dread in the dark.',
    block: `NARRATIVE VOICE — Horror / Dread:
- Register: tense, eerie, creeping. Wrongness in the ordinary; dread building in the dark between words.
- Diction: restrained and sensory; unsettling detail, the unseen made worse than the shown, silence that seems to listen back.
- Rhythm: slow and taut, quiet — then a sudden, sharp wrongness.
- Example beat: *The hallway is exactly as you left it. Except the door at the end — the one you are certain you closed — now stands open.* *From the dark inside, something shifts its weight.*`,
  },
  {
    key: 'litrpg',
    label: 'LitRPG / System',
    blurb: 'Gamified progression — stats, skills, levels, and quest prompts.',
    block: `NARRATIVE VOICE — LitRPG / System:
- Register: gamified, propulsive, progression-driven. The world runs on a System — stats, skills, levels, and quests.
- Diction: vivid action interleaved with System readouts (level-ups, notifications, skill gains); numbers and growth treated as a genuine thrill.
- Rhythm: scene, then status — momentum punctuated by crisp System prompts.
- Example beat: *You drive the blade home and the creature bursts into motes of light.* **[Quest Updated: Cull the Warren — 7/10]** **[Strength +1]** *Warmth settles into your arms. Stronger. Already you crave the next one.*`,
  },
  {
    key: 'chaotic_comedy',
    label: 'Chaotic Comedy',
    blurb: 'Unhinged, fast, absurd — gremlin energy that still moves the plot.',
    block: `NARRATIVE VOICE — Chaotic Comedy:
- Register: unhinged, fast, absurd. Gremlin energy and meme-brained chaos that somehow still drives the story forward.
- Diction: modern and irreverent; comic exaggeration, abrupt tonal swerves, gloriously bad ideas executed with total confidence.
- Rhythm: rapid-fire and escalating — punchlines that land and then immediately make everything worse.
- Example beat: *She kicks the door open holding a raccoon and a flamethrower.* "Okay so — good news, I found a pet! Bad news, the building's on fire and it's, uh, TECHNICALLY his fault."`,
  },
]

const STYLE_MAP: Record<string, StylePreset> = Object.fromEntries(
  NARRATIVE_STYLE_PRESETS.map((p) => [p.key, p]),
)

/**
 * Genre families — mirror of the Flutter grouping in
 * `everlore/lib/shared/narrative_styles.dart`. Shared so discovery ranking can
 * award partial credit when a world's voice is in the SAME family as one of the
 * player's interests (see interests/discovery). Keep in sync with the client.
 */
export const STYLE_FAMILY: Record<string, string> = {
  modern_casual: 'modern_everyday',
  slice_of_life: 'modern_everyday',
  kdrama: 'modern_everyday',
  romcom: 'modern_everyday',
  epic_fantasy: 'epic_adventure',
  shonen: 'epic_adventure',
  litrpg: 'epic_adventure',
  noir: 'atmospheric_dark',
  dark_academia: 'atmospheric_dark',
  horror: 'atmospheric_dark',
  grimdark: 'atmospheric_dark',
  cyberpunk: 'atmospheric_dark',
  flirty: 'romance_charged',
  dark_romance: 'romance_charged',
  yandere: 'romance_charged',
  tsundere: 'romance_charged',
  regency: 'romance_charged',
  cozy_comfort: 'cozy_playful',
  whimsical: 'cozy_playful',
  chaotic_comedy: 'cozy_playful',
  anime: 'cozy_playful',
}

/** All style keys sharing a family with any of the given interest keys. */
export function familyExpandedKeys(interests: string[]): string[] {
  const fams = new Set(
    interests.map((k) => STYLE_FAMILY[k]).filter(Boolean),
  )
  if (fams.size === 0) return []
  return Object.entries(STYLE_FAMILY)
    .filter(([, fam]) => fams.has(fam))
    .map(([key]) => key)
}

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

/**
 * Per-turn length directive — the SOFT shape the model writes to. This is paired
 * with {@link lengthMaxTokens}, the HARD output ceiling: the directive states the
 * target prose length, the token cap sits comfortably above it (~2x) as a
 * runaway guard, never as the intended stopping point. Each tier also tells the
 * model to land its ending cleanly within the length, so a turn that runs near
 * the cap still resolves instead of being cut mid-sentence. Keep the two
 * functions in sync: if you grow a directive's target, grow its cap to match.
 *
 * Medium is the default if unset.
 */
export function buildLengthDirective(len?: MessageLength): string {
  switch (len) {
    case 'short':
      return `LENGTH — keep it tight: 1 short paragraph, ~2–4 sentences. Favor punch and momentum over description. Finish the thought cleanly and end on a beat that invites the player to act.`
    case 'long':
      return `LENGTH — write a rich, immersive turn: ~3–5 paragraphs with fuller description, sensory detail, and interiority. Do not pad; every paragraph should earn its place. Bring the turn to a clean, deliberate close — do not trail off.`
    case 'medium':
    default:
      return `LENGTH — a balanced turn: ~2–3 short paragraphs. Vivid but not bloated. Wrap up the beat cleanly rather than stopping abruptly.`
  }
}

/**
 * Hard output-token ceiling scaled to the requested length. Caps generation cost
 * and latency, and is the safety net for {@link buildLengthDirective}: each value
 * is set ~2x the directive's prose target so the model reaches a natural ending
 * before the cap, and only truly runaway generations get clipped. Rough mapping
 * (≈0.75 words/token): short ≤~1 para, medium ≤~3 paras, long ≤~5 rich paras.
 */
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
