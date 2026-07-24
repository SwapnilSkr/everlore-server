/**
 * Player-selected prose register for a single world instance.
 *
 * A template's narrative_style still supplies its genre and authored texture.
 * This layer controls how that story is phrased for this player: diction,
 * rhythm, and literary density. It must never alter canon, scene pacing, or
 * what a character is willing to say.
 */
export interface NarrationTonePreset {
  key: string;
  label: string;
  blurb: string;
  directive: string;
  /** Compact reinforcement placed immediately before the player turn. */
  reminder: string;
  /** Authoring library only: exactly one short reference is selected per
   * instance and emitted into a prompt. The whole library is never sent. */
  examples: string[];
}

export const DEFAULT_NARRATION_TONE = "modern";

/** Ordered for the in-chat picker. Keep keys mirrored in Flutter. */
export const NARRATION_TONE_PRESETS: NarrationTonePreset[] = [
  {
    key: "modern",
    label: "Modern natural",
    blurb: "Contemporary, clear, and emotionally real.",
    directive: `NARRATION TONE — Modern Natural (player-selected, highest priority for wording):
- Write in a contemporary 2026 register: clear, direct, emotionally credible, and natural to read aloud.
- Prefer ordinary current vocabulary, contractions where they fit, concrete details, and dialogue that sounds like real people.
- Do NOT use archaic, royal, faux-medieval, high-fantasy, or needlessly ornate phrasing in narration. A character may use formal language only when their established identity or the immediate situation genuinely calls for it.
- Keep the world's genre, facts, and stakes intact; modern natural means modern phrasing, not a modernized setting.`,
    reminder:
      "Use contemporary, natural English now. No archaic, royal, faux-medieval, high-fantasy, or needlessly ornate narration unless an established character deliberately speaks that way.",
    examples: [
      '*She checks her phone, then looks up.* "I saw it. I just needed a minute."',
      '*He shifts his bag off the chair for you.* "Sit. You look like today picked a fight."',
      '*The elevator doors close on the argument.* "Okay. Start over. What actually happened?"',
      '*She lets out a breath through her nose.* "That was a lot. You okay?"',
    ],
  },
  {
    key: "cinematic",
    label: "Cinematic",
    blurb: "Visual, vivid, and controlled — like a great scene on screen.",
    directive: `NARRATION TONE — Cinematic (player-selected, highest priority for wording):
- Write with precise visual action, sensory detail, and clean scene cuts.
- Let gestures, objects, and silence carry emotion; keep sentences controlled rather than ornate.
- Favor vivid specificity over poetic abstraction. Do not lapse into archaic or royal diction unless the scene itself requires it.`,
    reminder:
      "Write cinematically: precise visual action, controlled language, and no ornamental or archaic drift.",
    examples: [
      '*The lift stops between floors. The lights blink once, then hold.* "Nobody move."',
      '*A glass rolls to the table edge and hangs there.* "You heard that too, right?"',
      '*Rain stitches silver lines across the windshield. He kills the engine.* "We walk from here."',
      '*Her hand pauses on the door handle.* "If I open this, we do not get to pretend."',
    ],
  },
  {
    key: "literary",
    label: "Literary",
    blurb: "Evocative and polished, without purple prose.",
    directive: `NARRATION TONE — Literary (player-selected, highest priority for wording):
- Write polished, evocative prose with measured imagery and emotional subtext.
- Use a memorable image only when it clarifies the moment. Vary sentence rhythm and leave room for plain, sharp lines.
- Never stack metaphors, inflate every beat, or substitute archaic/royal language for feeling.`,
    reminder:
      "Write literary but restrained: one clear image when earned, never purple or archaic for its own sake.",
    examples: [
      '*The apology sits between them, small and stubborn as a cup gone cold.* "I should have called."',
      '*He turns the ring in his palm until the metal warms.* "I kept waiting for it to feel easier."',
      '*The kitchen clock keeps working through the silence.* "Say something honest."',
      '*She smiles without quite arriving there.* "That is not the same as being fine."',
    ],
  },
  {
    key: "tense",
    label: "Tense",
    blurb: "Lean, sharp, and suspenseful.",
    directive: `NARRATION TONE — Tense (player-selected, highest priority for wording):
- Use lean, immediate prose. Favor pressure, implication, and specific physical reactions over lengthy explanation.
- Keep dialogue clipped when tension is high and let silence matter.
- Be contemporary and readable; do not use melodramatic, archaic, or royal language to manufacture stakes.`,
    reminder:
      "Keep the prose lean and immediate. Build pressure through specifics, not melodrama or archaic language.",
    examples: [
      '*The lock clicks behind them. Her phone buzzes once, then goes dark.* "Don’t answer that."',
      '*He reads the message twice. The second time, his face changes.* "We need to leave."',
      '*A car idles across the street with its lights off.* "Tell me you don’t know them."',
      '*She keeps her voice low.* "You have thirty seconds to explain."',
    ],
  },
  {
    key: "warm",
    label: "Warm",
    blurb: "Human, intimate, and quietly tender.",
    directive: `NARRATION TONE — Warm (player-selected, highest priority for wording):
- Write with human closeness, attentive emotional detail, and gentle sincerity.
- Notice small acts of care, hesitation, humor, and the meaning underneath ordinary words.
- Keep the language contemporary and unforced. Warmth is not melodrama, sentimentality, or courtly speech.`,
    reminder:
      "Keep the prose close, human, and contemporary. Tenderness must stay unforced, never courtly or sentimental.",
    examples: [
      '*She nudges the mug toward you before you ask.* "It’s too sweet. The way you like it."',
      '*He waits until your hands stop shaking.* "You don’t have to make it sound okay for me."',
      '*Her shoulder brushes yours on the walk home.* "I’m here. That’s all I’ve got right now."',
      '*He laughs softly, then looks embarrassed by it.* "You make this place less awful."',
    ],
  },
  {
    key: "wry",
    label: "Wry",
    blurb: "Dry, contemporary wit with a little bite.",
    directive: `NARRATION TONE — Wry (player-selected, highest priority for wording):
- Use dry, contemporary wit and observant understatement where it suits the scene.
- Let humor come from character, timing, and contradiction — never turn danger or grief into a joke when the scene does not support it.
- Keep it natural and current; avoid grand, archaic, or royal phrasing.`,
    reminder:
      "Use dry, contemporary wit only where the moment supports it. Avoid grand or archaic phrasing.",
    examples: [
      '*He eyes the smoking toaster.* "Good news: breakfast has ambition."',
      '*She reads the email, then closes the laptop very carefully.* "That feels legally suspicious."',
      '*The plan falls apart on the first slide.* "Amazing. We failed before lunch."',
      '*He glances at the security camera.* "Smile. We’re making evidence."',
    ],
  },
  {
    key: "formal_period",
    label: "Formal & period",
    blurb: "Deliberate, elegant, and more ceremonious.",
    directive: `NARRATION TONE — Formal & Period (player-selected, highest priority for wording):
- Use elegant, restrained, ceremonious prose with a light period flavor when it fits the world.
- Favor precision and poise over faux-Shakespeare, excessive archaism, or unreadable ornament.
- Let only characters and settings that plausibly warrant it speak with royal or historical formality.`,
    reminder:
      "Use deliberate formal/period language sparingly and readably; never lapse into faux-Shakespeare.",
    examples: [
      '*She folds the letter along its old crease.* "You have my word. I will see it done."',
      '*He inclines his head, but does not retreat.* "Respectfully, that course would ruin us."',
      '*The hall falls quiet as she enters.* "Let us speak plainly, for once."',
      '*He sets the seal beside the ledger.* "This matter is settled, unless you wish to contest it."',
    ],
  },
];

const TONE_MAP: Record<string, NarrationTonePreset> = Object.fromEntries(
  NARRATION_TONE_PRESETS.map((tone) => [tone.key, tone]),
);

export function isValidNarrationTone(key: string): boolean {
  return key in TONE_MAP;
}

function resolvedTone(key?: string): NarrationTonePreset {
  return TONE_MAP[key || DEFAULT_NARRATION_TONE] || TONE_MAP[DEFAULT_NARRATION_TONE];
}

function stableExampleIndex(seed: string, length: number): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % length;
}

/**
 * Compiles a tone rule plus one compact imitation target. The library stays in
 * source only; no more than one ≤35-word example reaches the model. The seed
 * is stable per instance so the cacheable prompt prefix does not churn.
 */
export function buildNarrationToneDirective(key?: string, exampleSeed = ''): string {
  const tone = resolvedTone(key);
  const example = tone.examples[stableExampleIndex(`${tone.key}:${exampleSeed}`, tone.examples.length)];
  return `${tone.directive}
- LAYERING RULE: template narrative style owns genre, setting texture, and character archetypes. This player-selected tone owns diction, sentence rhythm, and literary density. If they disagree about wording, preserve the world but use this tone's wording.
- Tiny in-voice reference (imitate the register, never reuse its situation or wording): ${example}`;
}

export function narrationToneLabel(key?: string): string {
  return resolvedTone(key).label;
}

export function buildNarrationToneReminder(key?: string): string {
  const tone = resolvedTone(key);
  return `NARRATION TONE for your next reply (${tone.label}, override earlier prose habits): ${tone.reminder}`;
}
