import { callLLM, AI_MODELS } from '../../src/ai'
import { env } from '../../src/config/env'
import { replyLanguageWriteStyle } from '../../src/utils/reply-language'
import type { ChoiceEnglish } from '../../src/utils/witness'
import type { EffectivePlayerGender } from '../../src/models/player-gender'
import { enforceSchema, untranslatedChoices, type GenerationOutput, type SchemaOptions } from './structured-output'

/** Structured fields derived from a narrative — everything except the prose itself. */
export type SceneMetadata = Omit<GenerationOutput, 'narrative'>

/**
 * The metadata pass is SPLIT into two focused LLM calls so the most fragile
 * half (the SCENE WITNESS: who is present / where / how time moved, plus the
 * stat and flag changes, the scene tag and the tone) can fail without corrupting
 * the CHOICE half, and vice versa. `extractSceneMetadata`
 * runs both in parallel and merges — every caller (main turn, edit, replay) gets
 * the isolation for free with an identical return shape. See METADATA_SPLIT.md.
 */

/** The four fields the buttons call used to write and the scene witness now
 *  owns: the buttons are published before the tail settles, so the scene type
 *  and the gauges must not depend on their model. Kept as property definitions
 *  so the witness schema carries them unchanged. */
const MOVED_FIELDS_SCHEMA_PROPERTIES = {
  state_mutations: {
    type: 'object',
    additionalProperties: {
      type: 'object',
      additionalProperties: false,
      properties: {
        op: { type: 'string', enum: ['add', 'subtract', 'set'] },
        value: { type: 'number' },
      },
      required: ['op', 'value'],
    },
  },
  flag_mutations: {
    type: 'object',
    additionalProperties: {
      type: 'object',
      additionalProperties: false,
      properties: {
        op: { type: 'string', enum: ['set', 'increment', 'decrement'] },
        value: {
          anyOf: [
            { type: 'string' },
            { type: 'number' },
            { type: 'boolean' },
            { type: 'null' },
          ],
        },
      },
      required: ['op', 'value'],
    },
  },
  scene_tag: {
    type: 'string',
    enum: ['dialogue', 'combat', 'romantic', 'intimate', 'exploration', 'existential', 'cosmic', 'mundane'],
  },
  emotional_tone: { type: 'string' },
}

/** WITNESS schema — the fragile, low-token scene-observation half: presence,
 *  departures, location, movement, time, place facts, and (since the buttons
 *  were split onto their own model) the stat/flag changes, scene tag and tone.
 *  A bad/truncated witness response falls back to safe defaults and never
 *  touches choices. */
const WITNESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    present_characters: {
      type: 'array',
      maxItems: 12,
      items: { type: 'string' },
    },
    characters_departed: {
      type: 'array',
      maxItems: 12,
      items: { type: 'string' },
    },
    physical_state_opened: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['restraint', 'contact', 'posture', 'held'] },
          statement: { type: 'string' },
          actors: { type: 'array', maxItems: 4, items: { type: 'string' } },
        },
        required: ['kind', 'statement', 'actors'],
      },
    },
    physical_state_closed: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          statement: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['statement', 'evidence'],
      },
    },
    current_location: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
    },
    player_destination: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
    },
    player_travel_confirmed: { type: 'boolean' },
    location_evidence: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
    },
    location_evidence_source: {
      anyOf: [{ type: 'string', enum: ['player', 'narrative', 'prior'] }, { type: 'null' }],
    },
    containment_hint: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
    },
    movement: {
      type: 'string',
      enum: ['none', 'deeper', 'out', 'lateral', 'world_shift'],
    },
    viewpoint_moved: { type: 'boolean' },
    time_elapsed: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
    },
    time_evidence: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
    },
    location_state_changes: {
      type: 'array',
      maxItems: 6,
      items: { type: 'string' },
    },
    location_permanent_facts: {
      type: 'array',
      maxItems: 6,
      items: { type: 'string' },
    },
    ...MOVED_FIELDS_SCHEMA_PROPERTIES,
  },
  required: ['present_characters', 'characters_departed', 'physical_state_opened', 'physical_state_closed', 'current_location', 'player_destination', 'player_travel_confirmed', 'location_evidence', 'location_evidence_source', 'containment_hint', 'movement', 'viewpoint_moved', 'time_elapsed', 'time_evidence', 'location_state_changes', 'location_permanent_facts', 'state_mutations', 'flag_mutations', 'scene_tag', 'emotional_tone'],
}

/** CHOICE schema — the player-moves + bookkeeping half: choices, the beat ledger
 *  and the milestone. The stat/flag changes, scene tag and tone moved to the
 *  witness half (the buttons call no longer returns them). */
const CHOICE_META_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    beat_ledger: {
      type: 'object',
      additionalProperties: false,
      properties: {
        npc_beats: {
          type: 'array',
          maxItems: 4,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              character: { type: 'string' },
              intent: { type: 'string' },
              reaction: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            },
            required: ['character', 'intent', 'reaction'],
          },
        },
        emotional_shift: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        setting: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        consequence: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        unresolved_hook: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['npc_beats', 'emotional_shift', 'setting', 'consequence', 'unresolved_hook'],
    },
    choices: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          kind: { type: 'string', enum: ['act', 'say'] },
          send: { type: 'string' },
        },
        required: ['label', 'kind', 'send'],
      },
    },
    milestone: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
    },
  },
  required: ['beat_ledger', 'choices', 'milestone'],
}

// Preserve property order in the legacy schema: the ledger precedes choices.
const { beat_ledger: ledgerSchema, ...choiceProperties } = CHOICE_META_SCHEMA.properties
const CHOICES_ONLY_SCHEMA = {
  ...CHOICE_META_SCHEMA,
  properties: choiceProperties,
  required: CHOICE_META_SCHEMA.required.filter((key) => key !== 'beat_ledger'),
}
const LEDGER_ONLY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { beat_ledger: ledgerSchema }, required: ['beat_ledger'],
}

/** One choice in the non-English variant: the English choice the rules describe,
 *  then the same choice for the player. English comes first because the whole
 *  rules block above teaches it: asked for the native text under those same names,
 *  the model wrote English there or left the pair out on two turns in five. */
const CHOICE_LANGUAGE_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    label: { type: 'string' },
    kind: { type: 'string', enum: ['act', 'say'] },
    send: { type: 'string' },
    label_local: { type: 'string' },
    send_local: { type: 'string' },
  },
  required: ['label', 'kind', 'send', 'label_local', 'send_local'],
}

/** `choices` replaced with the paired shape, keeping every other property in
 *  its original order. */
function withEnglishChoices(schema: { properties: Record<string, unknown>; [key: string]: unknown }): object {
  return {
    ...schema,
    properties: { ...schema.properties, choices: { type: 'array', maxItems: 4, items: CHOICE_LANGUAGE_ITEM } },
  }
}

const CHOICE_META_SCHEMA_EN = withEnglishChoices(CHOICE_META_SCHEMA)
const CHOICES_ONLY_SCHEMA_EN = withEnglishChoices(CHOICES_ONLY_SCHEMA)

/**
 * The one line the non-English choice system prompt gains at its very end. The
 * other fields stay English: this pass is what the extractors and the ledger
 * read, and only the chips the player sees are native. The language's authored
 * style (`variety`, `choiceLabelForm`) is added where a model is being told how
 * to write; a name without them yields exactly the old text.
 */
export function choiceLanguageInstruction(name: string): string {
  const { variety, choiceLabelForm } = replyLanguageWriteStyle(name)
  const varietyLine = variety ? ` Use ${variety}.` : ''
  const formLine = choiceLabelForm ? ` Every label_local uses one form: ${choiceLabelForm}.` : ''
  return `CHOICE LANGUAGE: the player reads this story in ${name}.${varietyLine} Every choice object has FIVE required fields, in this order: label, kind and send in English exactly as described above, whatever language the passage is in; then label_local and send_local, that same label and send translated into natural ${name}, first person kept, names and *asterisks* kept.${formLine} Example shape: {"label":"Take her hand","kind":"act","send":"*I reach out and take her hand.*","label_local":"<the label in ${name}>","send_local":"<the send in ${name}, asterisks kept>"}. Never leave label_local or send_local in English. The milestone, when there is one, is in ${name}. Every other field is in English.`
}

/**
 * The one gender line the choice half gains, so first-person buttons agree with
 * the narrator. On a non-English turn it names the player's copy; the English
 * pair is the extractors' bookkeeping and keeps the rules' own wording.
 */
export function choiceGenderInstruction(gender: EffectivePlayerGender, local = false): string {
  const fields = local ? 'label_local and send_local' : 'label and send'
  const englishNote = local ? ' The English label and send stay as the rules teach.' : ''
  if (gender === 'male') {
    return `PLAYER GENDER (canon): the player character is male; write ${fields} with masculine forms for the player, first person kept.${englishNote}`
  }
  if (gender === 'female') {
    return `PLAYER GENDER (canon): the player character is female; write ${fields} with feminine forms for the player, first person kept.${englishNote}`
  }
  return `PLAYER GENDER (canon): the player character's gender is not stated; never assign one. Write ${fields} without gendered words for the player — no gendered adjectives, participles or nouns (this matters in languages with grammatical gender).${englishNote}`
}

const CHOICE_TRANSLATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    choices: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label_en: { type: 'string' },
          send_en: { type: 'string' },
          label_local: { type: 'string' },
          send_local: { type: 'string' },
        },
        required: ['label_en', 'send_en', 'label_local', 'send_local'],
      },
    },
  },
  required: ['choices'],
}
/** Below this many usable pairs the missing ones are rebuilt in one call. */
const CHOICE_PAIR_FLOOR = 2
const CHOICE_TRANSLATION_TIMEOUT_MS = 6_000

/** The language-bearing fields of a dropped choice, whatever language each is
 *  in. `kind` is not language and stays with the original row. */
function choiceRescueSource(item: Record<string, unknown>): Record<string, string> {
  const source: Record<string, string> = {}
  for (const field of ['label', 'send', 'label_local', 'send_local'] as const) {
    if (typeof item[field] === 'string') source[field] = item[field]
  }
  return source
}

/**
 * The raw answer with its unusable buttons rebuilt. Only for a turn left with
 * fewer than two buttons; any failure returns the answer as it was, so a turn
 * never loses a button it had.
 *
 * The model may write the player's language into the English slots (that is the
 * bug this replaces: on 5 of 37 Spanish turns it did), so one call is asked for
 * both sides of every dropped choice, with the source stated as possibly in
 * either language. The rebuilt pairs go back through the unchanged
 * `sanitizeChoicePairs`, so a side that is still the same text is still dropped.
 */
async function withMissingChoiceCopies(
  raw: string,
  name: string,
  invoke: typeof callLLM,
): Promise<string> {
  const parsed = safeParseObject(raw)
  const missing = untranslatedChoices(parsed.choices)
  if (missing.length === 0) return raw
  const { variety, choiceLabelForm } = replyLanguageWriteStyle(name)
  const varietyLine = variety ? ` Use ${variety}.` : ''
  const formLine = choiceLabelForm ? ` Every label_local uses one form: ${choiceLabelForm}.` : ''
  try {
    const answer = await invoke({
      model: AI_MODELS.choices,
      noReasoning: true,
      purpose: 'choice_translation',
      messages: [
        {
          role: 'system',
          content: `You rebuild the tap-to-play buttons of an interactive story in ${name}. Each button may carry its text in English, in ${name}, or a mix: label and send are the ordinary fields, label_local and send_local the player's copy. Return label_en and send_en in English: label_en is the short imperative the player gives themselves (e.g. "Take her hand"), send_en the move in the first person. Return label_local and send_local in natural ${name}, first person kept, every name and the *asterisks* around actions kept with spoken words outside them.${varietyLine}${formLine} Return the same buttons in the same order.`,
        },
        { role: 'user', content: JSON.stringify(missing.map(choiceRescueSource)) },
      ],
      temperature: 0,
      maxTokens: 700,
      responseSchema: CHOICE_TRANSLATION_SCHEMA,
      responseFormat: { type: 'json_schema', json_schema: { name: 'choice_translation', strict: true } },
      timeoutMs: CHOICE_TRANSLATION_TIMEOUT_MS,
    })
    const copies = safeParseObject(answer).choices
    // A different count cannot be matched to its button, and one malformed row
    // would drop a button the turn already had.
    if (!Array.isArray(copies) || copies.length !== missing.length) return raw
    const usable = copies.every((copy) =>
      !!copy && typeof copy === 'object' &&
      ['label_en', 'send_en', 'label_local', 'send_local'].every(
        (field) => typeof (copy as Record<string, unknown>)[field] === 'string',
      ))
    if (!usable) return raw
    const filled = new Map<Record<string, unknown>, Record<string, unknown>>()
    missing.forEach((item, index) => {
      const copy = copies[index] as Record<string, string>
      filled.set(item, {
        label: copy.label_en,
        kind: item.kind,
        send: copy.send_en,
        label_local: copy.label_local,
        send_local: copy.send_local,
      })
    })
    return JSON.stringify({ ...parsed, choices: (parsed.choices as Record<string, unknown>[]).map((item) => filled.get(item) ?? item) })
  } catch {
    return raw
  }
}

/** Default for the WITNESS half — used when its call fails so a witness outage
 *  never throws or pollutes the choice half. Presence/location stay empty/unchanged. */
const WITNESS_FALLBACK: SceneMetadata = {
  present_characters: [],
  characters_departed: [],
  physical_state_opened: [],
  physical_state_closed: [],
  current_location: null,
  player_destination: null,
  player_travel_confirmed: false,
  location_evidence: null,
  location_evidence_source: null,
  containment_hint: null,
  movement: 'none',
  viewpoint_moved: false,
  time_elapsed: null,
  time_evidence: null,
  location_state_changes: [],
  location_permanent_facts: [],
  state_mutations: {},
  flag_mutations: {},
  scene_tag: 'dialogue',
  emotional_tone: 'neutral',
  beat_ledger: { npc_beats: [], emotional_shift: null, setting: null, consequence: null, unresolved_hook: null },
  choices: [],
  milestone: null,
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw)
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        return JSON.parse(match[0])
      } catch {
        // fall through
      }
    }
    return {}
  }
}

/**
 * STATIC rules block — identical for every turn and every world, so it forms a
 * stable cacheable PREFIX. All per-turn / per-world values (who the player is,
 * prior location/presence, tracked stat & flag names, roster, known places, world
 * context) live in the CONTEXT section APPENDED after this — never interpolated
 * here — so OpenAI prompt caching can reuse this ~2.5K-token prefix across turns.
 * The rules below reference "the CONTEXT section below" for those specifics.
 */
const METADATA_RULES = `You are a game-state analyst for a narrative RPG engine. Given a narrative passage, determine what changed in the world and suggest next moves. Respond ONLY with JSON matching the required schema.

Rules:
- state_mutations: the tracked stats are this world's live gauges, and judging them is a PRIMARY job of this pass, not an afterthought. Walk EVERY tracked stat listed in CONTEXT below and ask whether this passage moved it, using that stat's own description as the definition of what moves it. Report the ones that moved and omit the ones that did not — but do NOT default to reporting none: a passage with a visible cause (violence, a threat, exposure or being seen, a public act, a favour, trust earned or broken, a betrayal, a loss, a reward, or time spent lying low) almost always moves at least one gauge, and you must record it. op is "add"|"subtract"|"set"; for add/subtract keep value between 1 and 20 — 1-4 for an incidental nudge, 5-10 for a clear beat, 11-20 only for a decisive, world-visible event. Use "set" only when the prose makes the new level absolute (a gauge wiped clean, a rank formally conferred). Only the tracked stat names listed in CONTEXT below may be used, spelled EXACTLY as listed — never invent a stat and never substitute a synonym; a change with no matching tracked stat is simply not reported. Worked examples, for a world tracking heat [0-100] ("how much attention the corps and cops are paying to you") and reputation [0-100] ("how much the city's players respect or fear you"): the protagonist guns down a guard on camera and the incident is logged with their name → {"heat":{"op":"add","value":12}}; they win a public duel in front of the whole district → {"reputation":{"op":"add","value":8},"heat":{"op":"add","value":3}}; they spend a month underground under a false ID and the bounty notice stops running → {"heat":{"op":"subtract","value":8}}; two people talk quietly over a meal and nothing is risked, revealed, or witnessed → {}.
- flag_mutations: include ONLY flags that changed. op is "set"|"increment"|"decrement". Only the tracked flag names listed in CONTEXT below may be used.
- scene_tag: one of dialogue, combat, romantic, intimate, exploration, existential, cosmic, mundane. Use "romantic" for affectionate/romantic but non-explicit scenes (flirting, kissing, emotional intimacy). Use "intimate" ONLY for explicit sexual content.
- emotional_tone: a single word.
- beat_ledger: a compact semantic handoff for the NEXT turn, not a recap for the player. It has five fields: npc_beats, emotional_shift, setting, consequence, unresolved_hook. Use only what this passage establishes. npc_beats lists up to four NPCs who materially spoke, acted, or reacted, each as { character, intent, reaction }. The intent is the purpose or pressure behind their contribution; reaction is their observable/emotional response. emotional_shift is the scene's meaningful change in feeling or power dynamic. setting is the concrete current place/setting ONLY when the prose makes it clear (for example "at the royal table" or "in the library"); never guess it. consequence is the concrete new situation caused this turn. unresolved_hook is the next question, decision, threat, promise, or pressure left open. Keep each string concise (roughly 4-16 words). NEVER quote dialogue, copy distinctive phrasing, or closely paraphrase a spoken line; write neutral semantic facts instead. Example: {"npc_beats":[{"character":"Lyra","intent":"challenges Aurelius's standing","reaction":"openly disdainful"}],"emotional_shift":"the family conflict sharpens","setting":"at the royal table","consequence":"invasion news raises the stakes","unresolved_hook":"whether Aurelius will answer the challenge"}. Use null/[] when nothing applies.
- choices: 2-4 distinct suggested next moves for the player, ALWAYS written from the PLAYER's own first-person viewpoint ("I ..."). Who the player is — and whether this is a Game-Master world where the player IS the protagonist, or a sentient world where the player is a separate person talking to the main character — is given under WORLD MODE in the CONTEXT section below; honor it. NEVER refer to the player's own character in the third person or by role in either the label or the send (e.g. do not write "Observe the son" when the player IS the son — write "Watch my brother" / "*I watch him closely*"). Each is an object { label, kind, send }:
    - label: the short chip caption shown to the player — an imperative the player gives THEMSELF, 2-6 words, no trailing punctuation (e.g. "Take her hand", "Ask what she's hiding", "Draw your blade"). It must share the send's first-person viewpoint: address other people from the player's vantage ("Confront my brother"), never narrate the player's own character from outside ("Observe the son" when the player is the son is WRONG).
    - send: the player's move, in FIRST PERSON ("I ..."), pre-formatted so the player can edit it before sending. Wrap any narrated action/gesture in *single asterisks*; write spoken words as plain text OUTSIDE the asterisks (no quotation marks). You MAY combine a brief narration and a spoken line when it fits the moment. Examples:
        - silent action → send "*I reach out and take her hand.*"
        - spoken line → send "What are you hiding from me?"
        - narration + speech → send "*I step closer, lowering my voice.* What are you hiding from me?"
    - kind: "say" if send contains any spoken words (even alongside an action); "act" only for a silent action. Drives the chip's icon.
  The set must be distinct in spirit — mix bold / cautious / emotional / curious, and include at least one "say" and one "act" when both fit. A destination label is a commitment: if the label says to head/go/walk/travel to a specific place, its send MUST explicitly name the exact same place and describe going there. Never label a destination while sending vague prose such as "the one place that feels neutral". Ground every choice in what THIS passage just established; never invent new characters, places, or facts. When a choice refers to another person, name them by their CANONICAL name from the KNOWN CAST (in CONTEXT below) when they are one of them. FIGURATIVE vs LITERAL — read the WORLD CONTEXT (in CONTEXT below) to judge whether the world actually contains supernatural / non-human beings (ghosts, spirits, monsters, gods, demons, angels, AIs, aliens). In a GROUNDED, realistic world that has none, an evocative noun the prose applies to a PERSON — "the ghost in the doorway", "the monster at the head of the table", "the shadow of a man", "a wolf in a suit" — is a METAPHOR for an existing character (very often the protagonist or someone present), NOT a real new entity. NEVER write a choice that treats such a metaphor as a literal separate someone to ask about, observe, or approach ("Ask her about the ghost" when "the ghost" is just the overlooked protagonist is WRONG) — address the actual person instead. Treat such a being as a literal entity ONLY when the WORLD CONTEXT establishes that kind of being is real here.
- milestone: null almost always. Set a short evocative label (3-8 words) ONLY when this passage crossed a true story landmark: a vow or marriage, a first kiss, a death of a significant character, a title/power gained, a major victory or betrayal, a life-changing decision. Routine progress is NOT a milestone.
- present_characters: the PEOPLE who appear physically in the scene WITH the viewpoint during THIS passage — anyone who speaks, acts, or is shown to be in the room right now. List the closed set for THIS place at the END of the passage. If the viewpoint has gone into a different room, do not list people left behind in the old one, even if CONTEXT still shows them as last turn's cast. The system only carries last turn's people forward when the place has not changed; it will not drop a quiet person in the same room, so you do not need to re-list someone who is still here and simply was not named. For anyone matching the KNOWN CAST, use their CANONICAL name (not the alias/role/pronoun the prose used); for a genuinely new person not in the cast, use the clearest name the prose gives. NEVER put a location, landmark, building, city, district, country, vehicle, or object here — even if it is capitalized or personified by prose ("Milan greeted him", "near the Duomo"). Those are places/things, never scene participants. EXCLUDE the player/narrator themself, and anyone only mentioned, remembered, or written about while not actually in the room. Also EXCLUDE a figurative epithet that is really an existing person under a metaphor (per the FIGURATIVE vs LITERAL rule above) — "the ghost", "the monster" for the overlooked protagonist is NOT a separate present character in a grounded world. CRUCIAL: if a person LEAVES by the end of the passage, do NOT list them here — list them in characters_departed instead, even if they spoke or acted earlier in the same passage.
- characters_departed: the people who physically LEFT the scene by the end of this passage — walked out, exited, stormed off, were dismissed, sent away, or died — EVEN IF they spoke or acted earlier in the same passage before leaving. Use their CANONICAL name. A person who rises and leaves the room this turn belongs HERE, not in present_characters. If the viewpoint itself moved into a new place, the people who did not come along are departed even when the prose never names each exit. Empty array [] only when nobody left and the viewpoint is still in the same place.
- physical_state_opened: sustained PHYSICAL configurations that BEGAN in this passage and are still true at the end of it. Not emotions, not intentions, not one-off motions that complete themselves. A configuration qualifies only if the next moment of the story would still be inside it: a grip or restraint ("Aurelius has Cedric by the collar against the wall"), sustained contact (an embrace still held, a hand still clasped), a body position that persists (kneeling, seated at the head of the council table), or an object actively held/wielded (a blade drawn and levelled). kind is one of restraint/contact/posture/held. statement is ONE short third-person clause naming the people involved. actors lists the CANONICAL names of everyone the configuration binds — both the person acting and the person acted upon. A slap, a shove that ends, a glance, a step taken, or a door closed is NOT a sustained configuration: leave those out. Empty array [] almost always.
- physical_state_closed: ONLY the ongoing configurations that this passage actually ENDED — the grip released, the embrace broken, the blade sheathed, the character rising out of the chair. For each one give { "statement": the text copied from ONGOING PHYSICAL STATE, "evidence": an EXACT verbatim excerpt (4-20 words) from the player turn or the narrative that shows it ending }. The evidence is machine-checked against the text: if it cannot be found verbatim, the close is DISCARDED and the configuration stays open, so never paraphrase or invent it.
  DO NOT simply copy the ONGOING PHYSICAL STATE list here. Most passages end nothing, and the correct answer is then []. A configuration that is merely mentioned, described again, tightened, resisted, or endured is STILL OPEN and must NOT be listed. Worked examples, with ongoing state "Aurelian has Doran by the collar against the wall": the player turn is "*I hold him tighter, refusing to back down*" and the prose says his grip does not loosen → physical_state_closed is [] (it INTENSIFIED, it did not end). The player turn is "*I release Doran, but keep my gaze steady*" → [{"statement":"Aurelian has Doran by the collar against the wall","evidence":"I release Doran"}]. The prose says only that Doran's face goes pale and he speaks → [] (nothing about the grip changed).
  A configuration also ends implicitly when a person it binds leaves the scene, and you do NOT need to list that case — the system closes it. But if the player's own action ends it ("I let go of him", "I lower the blade"), it MUST be listed here with the player's words as evidence.
- current_location: the place the viewpoint/protagonist is PHYSICALLY STANDING IN at the end of the passage — where this turn's action and dialogue actually happen. Report ONLY a compact PLACE NAME (not a sentence, quote, player action, or a person's name): "war room", "Royal Council Chamber", "Milan". NEVER report a place that is merely mentioned, named, planned, anticipated, remembered, or where some future event will be held while the characters are not yet there. Worked example: if they sit at the table in the dining room discussing a party that will be held in the great room, current_location is "dining room" — NOT "great room". If the scene simply continues where it already was, return the prior known location unchanged. If the viewpoint is at a place listed in KNOWN PLACES (in CONTEXT below) — including returning to one they left earlier — return that place's EXACT canonical name, never a new variant spelling ("the garden" when KNOWN PLACES has "Night Garden" → return "Night Garden"). Use a fresh name only for a place that is genuinely not yet known. NEVER report a vague or relative label as the location — "the room", "here", "inside", "outside", "this place" are NOT place names; use the SPECIFIC place's name (e.g. "dining room", "the night garden"), or return the prior known location if the viewpoint has not moved. If the viewpoint moves into a personal space the prose marks as someone's OWN ("my room", "her chambers", "his study"), name it for its owner so it is specific and distinct — e.g. the protagonist retreating to "my room" → the protagonist's name (from CONTEXT) + "'s room" (for a protagonist named Mara, "Mara's room"), NOT the bare "the room". If you are NOT SURE where they are, return null. Returning null is CORRECT and costs nothing — the map simply keeps what it had. GUESSING costs a great deal: a wrong place is written to the map and the story is told from there. Never name a place to avoid leaving the field empty, never infer one from the kind of scene it feels like, and never promote a thing in the room to be the room ('the table', 'the terminal', 'the bench', 'the hearth' are objects, not places). Return null ONLY if no place has ever been established. The Prior known location is given in CONTEXT below. Return THAT only when the viewpoint is still physically there. If this passage puts the viewpoint in a different place, name that place and set viewpoint_moved true — do not hold the prior name out of caution.
- location_evidence and location_evidence_source: REQUIRED provenance for current_location. Return one SHORT exact excerpt (3-20 words) from the indicated source that proves the viewpoint is physically there. source="player" only when the PLAYER TURN itself moves/arrives there; source="narrative" when the completed narrative establishes the setting; source="prior" only when you return the prior known location unchanged (then evidence may be null). Never invent or paraphrase the excerpt. If you cannot cite an exact excerpt, current_location must be null. The excerpt MUST contain the place's own name and MUST show the viewpoint being AT it — a locative statement ("back in the root cellars, the air is cold", "we reach the village square", "The hall is quiet") — not a sentence that merely mentions it ("the low road to Marrow Ford"), and not a sentence about where somebody ELSE is ("Bram's down there in the cellars"). Prefer the sentence that establishes the setting over an atmosphere line that never names the place. This evidence is machine-checked before a location enters the map.
- player_destination and player_travel_confirmed: read the PLAYER TURN in CONTEXT together with the narrative. Set player_travel_confirmed true ONLY when the player is physically travelling/arriving NOW in that turn, not merely discussing, planning, remembering, or promising a future trip. player_destination is the clean compact place name the player actually goes to/arrives at; remove purpose clauses and direct addresses ("go to the living room to say goodbye to Lisa" → "living room"; "go to the airport, Dad" → "airport"). An unnamed but physically entered venue is still a destination: "I take a hotel to stay at", "I check into a hotel", or "I get a room at an inn" → player_travel_confirmed true and player_destination "hotel" or "inn" (not "hotel lobby" unless the player named the lobby). Return null/false when no travel happened.
- viewpoint_moved: a boolean. true whenever THIS passage narrates the viewpoint/protagonist physically CHANGING place — walking out, entering another room, setting off on a journey, RETURNING TO or RE-ENTERING a place they had left (e.g. coming back indoors from the garden, stepping back into the mansion), or a scene-cut that puts them somewhere new. It is false when they stay put and nothing relocates them, and ESPECIALLY when another place is only mentioned, named, discussed, or planned while they remain where they are. Rule of thumb: if current_location differs from the prior known location because they actually went there, viewpoint_moved is true; if current_location is unchanged, it is false.
- containment_hint: the name of the place that DIRECTLY CONTAINS current_location, but ONLY when THIS passage actually states or makes it plain (e.g. the prose says they are "in the library of the manor" → containment_hint "the manor"; "a tavern in the riverside district" → "riverside district"). This is the immediate parent, one level up — a room's building, a building's district, a city's realm. Return null when the passage does not make the container explicit. NEVER guess or invent a container to fill this in.
- movement: how current_location relates to the PRIOR known location this turn — one of: "none" (did not move / stayed put), "deeper" (went INTO a place contained by where they were — entered a room of the current building), "out" (LEFT the current place to its surrounding area — stepped outside the house onto the street), "lateral" (moved to another place at the SAME level — one room to another in the same building), "world_shift" (crossed into a wholly different world/realm/plane — a portal to the shadow realm, abduction to another planet, waking in a dream-world). Use "none" whenever viewpoint_moved is false. Choose the single best fit; when unsure between out/lateral use "lateral".
- time_elapsed: how much IN-WORLD time the passage itself narrates passing during this turn — a short human label ("three days", "a week later", "a few hours", "the next morning"). Use this ONLY when the prose clearly skips or spans time (a journey, a "later that night", "weeks passed"). Return null for a continuous, real-time scene where no meaningful time elapses (most dialogue/combat turns). Do not invent time; report only what the passage states or strongly implies.
- time_evidence: REQUIRED whenever time_elapsed is not null. One SHORT exact excerpt (3-20 words) from the COMPLETED NARRATIVE that states the span passing ("Two days later, the rain finally stopped", "weeks wore on"). It must contain the same time unit the label claims. Never paraphrase. If you cannot cite the sentence, time_elapsed must be null — this is machine-checked before the story calendar moves.
- location_state_changes: short clauses for what BECAME TRUE about the CURRENT place this turn — its mutable condition. Capture changes in EITHER direction, not only destruction: damage/decline ("the gate now lies in ruins", "the tavern has burned down", "soldiers occupy the square") AND improvement/transformation ("the garden has been restored to bloom", "the hall is now decorated for the feast", "the overgrown courtyard has been cleared", "the hearth is lit and the room is warm again"). If the prose shows the place visibly altered — repaired, rebuilt, cleaned, decorated, brought to life, flooded, emptied, transformed — record it. Each clause must be self-contained and name what changed. Empty array [] when the place's condition did not change (the usual case).
- location_permanent_facts: short clauses for ENDURING, canonical facts about the current place newly established this turn ("the temple was built over a buried god", "this bridge is the only crossing for fifty miles"). These are lasting truths, not passing events or moods. Empty array [] almost always — use sparingly.`

/** The rules the buttons half is no longer told, because it no longer writes
 *  these fields: the witness half reads the whole rules block and owns them.
 *  Each is one line of METADATA_RULES, and each must exist exactly once — a
 *  missing or duplicated line would silently change a model's instructions. */
const MOVED_RULE_PREFIXES = ['- state_mutations:', '- flag_mutations:', '- scene_tag:', '- emotional_tone:'] as const
const MOVED_RULES = MOVED_RULE_PREFIXES.map((prefix) => {
  const lines = METADATA_RULES.split('\n').filter((line) => line.startsWith(prefix))
  if (lines.length !== 1) {
    throw new Error(`METADATA_RULES must carry exactly one "${prefix}" rule line (found ${lines.length})`)
  }
  return lines[0]
})

/**
 * Derive ALL structured fields (state/flag mutations, scene tag, tone, choices,
 * milestone, presence, location, time) from a finished narrative. Runs on EVERY
 * turn: the narrator is always `proseOnly` (streamed prose, uncensored-model
 * compatible), so this cheap reliable model handles the structured bookkeeping.
 * `opts.protagonist` anchors first-person choice generation to the player so the
 * choice viewpoint can't drift in third-person prose. Falls back to a no-op
 * (scene stays `intimate` to preserve NSFW momentum) if extraction fails.
 */
export type MetadataOpts = {
  /** Model override. Production omits it and gets `AI_MODELS.metadata`; the
   *  corpus tier experiment uses it to run the same prompt on another tier. */
  model?: string
  /** Test-only observability hook. Production callers omit it; it never changes
   * request construction or validation. */
  onRaw?: (stage: 'scene_witness' | 'choice_metadata', raw: string) => void
  /** Test-only transport. Production callers omit it and get `callLLM`; an audit
   * injects its own function to read the exact request body without a network. */
  call?: typeof callLLM
  /** Where each model call went. Both halves run in parallel, so the caller
   *  cannot time them from outside the pair; each half reports its own
   *  start-to-settle here, failure included. `beat_ledger` is reported only when
   *  the split is on — unsplit there is no ledger call to time. Never changes
   *  what is requested. */
  onStage?: (stage: 'scene_witness' | 'choice_metadata' | 'beat_ledger', ms: number) => void
  onChoiceFirstToken?: (ms: number, winner: 'primary' | 'hedge') => void
  onChoiceHedge?: () => void
  /** Which model produced the kept buttons; logged as `choice_model`. */
  onChoiceModel?: (model: string) => void
  /** Called once with the button half's result as soon as it settles, before the
   *  ledger join. The returned promise still carries the ledger. */
  onChoices?: (result: SceneMetadata) => void
  /** Raw player-authored turn. The witness uses this to identify actual travel
   * intent; it never treats narration alone as player authority. */
  playerInput?: string | null
  isSentient?: boolean
  currentLocationName?: string | null
  /** Characters present at the END of the PRIOR turn, so a character still in
   *  the scene but not named in this passage isn't dropped to "elsewhere". */
  priorPresent?: string[]
  /** Open physical configurations entering this turn, rendered as statements. */
  priorPhysical?: string[]
  /** Places this world already knows (canonical name + aliases). Lets a RETURN
   *  to a known place reuse its canonical name instead of minting a duplicate. */
  knownPlaces?: { name: string; aliases?: string[] }[]
  /** Who the player is in this world — their GM character or their persona —
   *  by name + any aliases. Used to anchor first-person choices to the right
   *  person so the choice viewpoint never drifts in third-person prose. */
  protagonist?: { name?: string | null; aliases?: string[] } | null
  /** Known OTHER characters (the selected codex, excluding the player) by
   *  canonical name + aliases. Lets the extractor return `present_characters`
   *  and name people in choices by their CANONICAL name instead of whatever
   *  alias/role/pronoun the prose happened to use — the app matches presence
   *  against canonical names with an exact check, so source-normalizing here
   *  keeps "approach vs. seek out" and the Cast presence tags correct. */
  roster?: { name: string; aliases?: string[] }[]
  /** A short description of the WORLD's nature (premise/lore), so the extractor
   *  can judge whether an unusual noun in the prose is LITERAL or FIGURATIVE —
   *  e.g. "the ghost in the doorway" is a real spirit in a horror world but a
   *  metaphor for an overlooked person in a grounded drama. */
  worldContext?: string | null
  /**
   * Bounded, narrator-equivalent story facts for the choice half only. This
   * carries the selected lore/memories/threads and active cast that made the
   * prose possible, without copying the narrator's large instruction prefix or
   * historical prose into a second request.
   */
  choiceContext?: string | null
  /**
   * Choice labels already offered and not taken.
   *
   * MEASURED, and it is NOT used to steer the model. Listing them in the prompt
   * as "do not repeat these" made repetition WORSE on a controlled replay of 20
   * real turns -- 5 repeats blind, 13 informed -- which is ordinary anchoring:
   * naming the labels raised their salience. The list is applied
   * DETERMINISTICALLY after generation instead, by `dropRepeatedChoices`.
   */
  recentChoiceLabels?: string[]
  /**
   * The one effective gender for this turn (persona, else onboarding, else
   * unknown). Only the choice half reads it: the buttons are the player's own
   * first-person words, so they must agree with the narrator's gender line.
   */
  playerGender?: EffectivePlayerGender
  /**
   * The hidden English copy of this turn's player line, when it is already
   * known. A non-English turn compares its English choice pair with it; the
   * pass never waits for a copy that has not settled.
   */
  playerInputEnglish?: string | null
  /**
   * Non-English turn launched before the English copy: the ledger's player turn
   * and the English repeat check wait for this; the button call itself does not.
   */
  englishTurn?: Promise<{ playerInput: string | null | undefined; playerInputEnglish: string | null | undefined }>
  /**
   * Non-English turn: the choice half runs on these native values while the
   * witness half (and the ledger) read the English copy passed as `narrative`.
   * Absent on an English turn, where every request and result is unchanged.
   */
  choiceLanguage?: ChoiceLanguage
}

/** The native side of the split choice pass on a non-English turn. */
export interface ChoiceLanguage {
  /** Model-facing language name, e.g. "Brazilian Portuguese". */
  name: string
  /** The native prose the chips are written from (always available at stream end). */
  narrative: string
  /** The native player turn, so the choice prompt's PLAYER TURN stays native. */
  playerInput: string
}

/** Build the STATIC rules + dynamic CONTEXT system prompt shared by both halves.
 *  Keeping all per-turn/per-world values after the rules lets OpenAI prompt
 *  caching reuse the ~2.5K-token rules prefix across turns and worlds. */
type StatDescriptor = { name: string; min: number; max: number; description: string }
type StatInput = StatDescriptor[] | string[]

/**
 * Build the extractor's stat descriptors from a template's `base_stats_template`
 * (or, when only the runtime gauge map is at hand, from its bare keys). The
 * authored description and bounds are what let the metadata pass judge each
 * gauge on its own terms, so every caller — live turn, replay, edit — must pass
 * these rather than bare stat names.
 */
export function statDescriptors(
  defs: Record<string, unknown> | null | undefined,
): StatDescriptor[] {
  return Object.entries(defs || {}).map(([name, raw]) => {
    const def = (raw && typeof raw === 'object' ? raw : {}) as {
      min?: unknown
      max?: unknown
      description?: unknown
    }
    return {
      name,
      min: Number.isFinite(def.min) ? (def.min as number) : 0,
      max: Number.isFinite(def.max) ? (def.max as number) : 100,
      description: typeof def.description === 'string' && def.description.trim()
        ? def.description.slice(0, 160)
        : name,
    }
  })
}

function normalizeStats(stats: StatInput): StatDescriptor[] {
  return stats.map((stat) =>
    typeof stat === 'string'
      ? { name: stat, min: 0, max: 100, description: stat }
      : stat,
  )
}

function buildMetadataSystem(
  opts: MetadataOpts | undefined,
  stats: StatDescriptor[],
  flagKeys: string[],
  /** The choice half on a non-English turn reads the NATIVE player turn while
   *  the witness/ledger read the English copy — so the turn is overridable. */
  playerTurnOverride?: string,
): string {
  // Resolve who "I" is for the choices. In third-person GM prose the protagonist
  // is referred to by role ("the son", "the boy"); without naming them the
  // extractor cannot tell which character is the player and drifts the choice POV
  // (an external "Observe the son" label paired with a first-person "*I glance at
  // my brother*" send). The aliases carry the merged role-titles from the codex.
  const protagName = opts?.protagonist?.name?.trim() || null
  const protagAliases = (opts?.protagonist?.aliases || [])
    .map((a) => a.trim())
    .filter((a) => a && a.toLowerCase() !== (protagName || '').toLowerCase())
  const aliasClause = protagAliases.length
    ? ` (the prose may refer to them as: ${protagAliases.join(', ')} — all the same person)`
    : ''

  // Known cast (other characters), so present_characters and choice references
  // resolve to CANONICAL names instead of whatever alias/role/pronoun the prose
  // used — the app matches presence against canonical names exactly.
  const roster = (opts?.roster || [])
    .map((r) => {
      const name = (r.name || '').trim()
      if (!name) return null
      // Cap aliases PER entry too (not just rows) so one card with a long alias
      // list can't bloat the prompt — rows are capped at 24 below.
      const al = (r.aliases || []).map((a) => a.trim()).filter((a) => a && a.toLowerCase() !== name.toLowerCase()).slice(0, 6)
      return al.length ? `${name} (also called: ${al.join(', ')})` : name
    })
    .filter(Boolean)
    .slice(0, 24)
  const rosterClause = roster.length
    ? `\n\nKNOWN CAST (other characters in this story — match anyone in the prose to one of these by name, alias, role, or pronoun, and ALWAYS refer to them by their CANONICAL name, the part before any parenthesis):\n${roster.map((r) => `- ${r}`).join('\n')}`
    : ''

  const priorPresent = (opts?.priorPresent || []).map((p) => p.trim()).filter(Boolean)
  const priorPresentLabel = priorPresent.length ? priorPresent.join(', ') : '(none / unknown)'
  // The open physical configurations this passage may close. Without them the
  // model has no idea a grip is still on, so it can neither sustain it nor end
  // it — and an unclosed grip outlives the release by however long the state
  // happens to survive downstream.
  const priorPhysical = (opts?.priorPhysical || []).map((p) => p.trim()).filter(Boolean)
  const priorPhysicalLabel = priorPhysical.length ? priorPhysical.join(' | ') : '(none)'
  const priorLocationLabel = opts?.currentLocationName || '(none established yet)'
  // BOOTSTRAP. With no cursor yet there is nothing to carry, so source="prior" is
  // not an available answer — but the witness kept returning it anyway (with a
  // null current_location), and because a null location leaves the cursor unset,
  // the next turn asked the same question with the same empty prior and got the
  // same answer. The opening scene of a world could therefore never anchor: eight
  // consecutive turns of `location_anchor: null` while the authored opening said
  // "the great hall" in its first sentence. Say the quiet part explicitly.
  const bootstrapClause = opts?.currentLocationName
    ? ''
    : '\nNO LOCATION IS ESTABLISHED YET. "prior" is therefore NOT a valid location_evidence_source this turn: there is nothing to carry forward. Read the passage and name the place the viewpoint is physically in, citing the exact sentence that establishes it (source="narrative"), or the player turn if that is what puts them there (source="player"). Only return current_location null if the passage genuinely names no physical setting at all.'

  const playerTurn = (playerTurnOverride ?? opts?.playerInput ?? '').replace(/\s+/g, ' ').trim().slice(0, 900)


  const places = (opts?.knownPlaces || [])
    .map((p) => {
      const name = (p.name || '').trim()
      if (!name) return null
      const al = (p.aliases || []).map((a) => a.trim()).filter((a) => a && a.toLowerCase() !== name.toLowerCase()).slice(0, 6)
      return al.length ? `${name} (also called: ${al.join(', ')})` : name
    })
    .filter(Boolean)
    .slice(0, 30)
  const knownPlacesClause = places.length
    ? `\n\nKNOWN PLACES (locations this world already has — if the viewpoint is at one of these, reuse its EXACT canonical name, the part before any parenthesis, so it isn't duplicated):\n${places.map((p) => `- ${p}`).join('\n')}`
    : ''
  const worldCtx = (opts?.worldContext || '').trim().slice(0, 700)
  const worldContextClause = worldCtx
    ? `\n\nWORLD CONTEXT (the nature of THIS world — use it to judge whether an unusual noun in the prose is LITERAL or FIGURATIVE):\n${worldCtx}`
    : ''
  // Identity + world MODE only (the behavioral first-person / no-3rd-person rule
  // is static in METADATA_RULES). Lives in the CONTEXT tail so the rules prefix
  // stays identical across turns/worlds and stays cacheable.
  const viewpointContext = opts?.isSentient
    ? `SENTIENT world — the player is a person interacting with the character(s) in the scene${
        protagName ? `; the player is "${protagName}"${aliasClause}` : ''
      }. Choices are the PLAYER's own next moves (what they say or do), NOT the character's.`
    : `GAME-MASTER world — the player IS the protagonist${
        protagName
          ? `: "${protagName}"${aliasClause}. Whenever the prose refers to ${protagName} — by name, role, or pronoun — that is the player, and "I" in every choice means ${protagName}.`
          : '; their character acts within the world.'
      }`

  // Order within the dynamic tail by how much the rules LEAN on it: WORLD MODE and
  // WORLD CONTEXT (the figurative-vs-literal signal) go FIRST so a small model
  // doesn't have to reach past long roster/place lists to apply them; the bulky
  // roster/places lists go LAST. (All of it still sits AFTER the static rules
  // prefix, so caching is preserved.)
  const context = `

--- CONTEXT (specific to this world and this turn) ---
WORLD MODE & VIEWPOINT: ${viewpointContext}${worldContextClause}
Prior known location (return THIS unless the viewpoint has physically moved): ${priorLocationLabel}${bootstrapClause}
PLAYER TURN (authoritative for player movement; empty means no new player turn): ${playerTurn || '(none)'}
People present at the end of last turn (carried forward automatically — for your reference): ${priorPresentLabel}
ONGOING PHYSICAL STATE (still true entering this passage — list any that ENDED in physical_state_closed): ${priorPhysicalLabel}
Tracked stats (only these names may appear in state_mutations): ${stats.length ? stats.map((s) => `${s.name} [${s.min}–${s.max}]: ${s.description}`).join('; ') : '(none)'}
Tracked flags (only these names may appear in flag_mutations): ${flagKeys.length ? flagKeys.join(', ') : '(none)'}${rosterClause}${knownPlacesClause}`
  return METADATA_RULES + context
}

/**
 * Normalise a label or a player line for comparison.
 *
 * Unicode letters and digits, with accents folded (NFKD, marks dropped) and
 * lower case. The old ASCII class `[^a-z0-9 ]` deleted every non-ASCII letter
 * — "lâmpada" became "lmpada" and a Cyrillic label became empty, which was then
 * never filtered. For an ASCII English label the result is byte-identical to
 * the old normaliser.
 */
export function normalizeChoiceText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A send with its `*action*` segments removed, so the spoken remainder can be
 *  compared on its own. */
function spokenOnly(value: unknown): string {
  return String(value ?? '').replace(/\*[^*]*\*/g, ' ')
}

/**
 * Is this choice the move the player just made? Both the whole text and its
 * spoken remainder are compared; the remainder only when speech is left on both
 * sides, so a pair of pure actions with different wording never collides.
 */
export function choiceRepeatsPlayerLine(
  choice: { label?: string; send?: string } | null | undefined,
  playerLine: string | null | undefined,
): boolean {
  const whole = normalizeChoiceText(playerLine)
  if (!whole) return false
  const speech = normalizeChoiceText(spokenOnly(playerLine))
  for (const field of [choice?.label, choice?.send]) {
    if (typeof field !== 'string') continue
    if (normalizeChoiceText(field) === whole) return true
    if (speech) {
      const fieldSpeech = normalizeChoiceText(spokenOnly(field))
      if (fieldSpeech && fieldSpeech === speech) return true
    }
  }
  return false
}

/**
 * The kept indices for a choice set, in the order the survivors were produced
 * (a floor restore appends the earliest dropped options, as before).
 */
function keptChoiceIndices(
  choices: Array<{ label?: string; send?: string }>,
  englishChoices: readonly ChoiceEnglish[] | undefined,
  recentLabels: string[],
  floor: number,
  playerInput: string | null | undefined,
  playerInputEnglish: string | null | undefined,
): number[] {
  const recent = new Set(recentLabels.map(normalizeChoiceText).filter(Boolean))
  const kept: number[] = []
  const dropped: number[] = []
  const seen = new Set<string>()
  choices.forEach((choice, index) => {
    const english = englishChoices?.[index]
    // A chip without its English pair cannot be carried half-paired.
    if (englishChoices !== undefined && !english) { dropped.push(index); return }
    const key = normalizeChoiceText(choice?.label || '')
    let repeat = false
    // Within-turn duplicates are dropped whether or not there is any history.
    if (key && seen.has(key)) repeat = true
    if (key) seen.add(key)
    if (key && recent.has(key)) repeat = true
    // The move the player already made this turn is not an unanswered suggestion.
    if (choiceRepeatsPlayerLine(choice, playerInput)) repeat = true
    // On a non-English turn the English pair is compared with the English line
    // when that copy has already settled; never awaited here.
    if (english && choiceRepeatsPlayerLine(english, playerInputEnglish)) repeat = true
    if (repeat) dropped.push(index)
    else kept.push(index)
  })
  while (kept.length < floor && dropped.length) {
    const index = dropped.shift()!
    if (englishChoices !== undefined && !englishChoices[index]) continue
    kept.push(index)
  }
  return kept
}

/**
 * DROP CHOICES THE PLAYER HAS ALREADY BEEN OFFERED AND PASSED OVER.
 *
 * Over one live 83-turn save the choice half offered 323 suggestions of which
 * 242 were distinct, and "Challenge Isolde's authority" came up SIXTEEN times
 * across the scene it belonged to. Turn-to-turn duplication was rare (5 of 82
 * consecutive pairs shared two labels), so this is not a stuck loop: it is a
 * generator with no memory of its own output re-deriving the same obvious move
 * from the same standing situation.
 *
 * Telling the model about it in the prompt was tried and measured and made
 * things worse (5 repeats blind, 13 informed, over the same 20 turns) — naming
 * the labels anchors on them. So the rule is applied here, where it is
 * arithmetic rather than persuasion.
 *
 * A floor of two keeps a turn from collapsing to a single option: the set may
 * shrink, never disappear. The comparison is on the normalized label (and, when
 * `playerInput` is given, on the label/send against the player's own line), so
 * punctuation and casing drift do not smuggle a repeat back in.
 */
export function dropRepeatedChoices<T extends { label?: string; send?: string }>(
  choices: T[],
  recentLabels: string[],
  floor = 2,
  playerInput?: string | null,
): T[] {
  return keptChoiceIndices(choices, undefined, recentLabels, floor, playerInput, undefined)
    .map((index) => choices[index])
}

/** Reuse enforceSchema's field validation on a raw half-response by injecting a
 *  placeholder narrative (enforceSchema requires one) and returning the full
 *  validated GenerationOutput; each half picks its own fields. */
export function validateHalf(raw: string, opts?: SchemaOptions): GenerationOutput {
  return enforceSchema(JSON.stringify({ narrative: 'placeholder', ...safeParseObject(raw) }), opts)
}

/**
 * WITNESS half — the dedicated low-token scene observation: who is present, who
 * left, where the viewpoint stands, how it moved, how time elapsed, what changed
 * about the place, and the stat/flag changes, scene tag and tone the buttons
 * half no longer writes. Isolated from the choice half so a witness failure
 * (truncation, bad JSON) falls back to safe defaults and never corrupts the
 * choices, and vice versa. Returns a full SceneMetadata with only the witness
 * fields populated; the rest are the safe fallback.
 */
export async function extractSceneWitness(
  narrative: string,
  opts?: MetadataOpts,
  stats?: StatInput,
  flagKeys?: string[],
): Promise<SceneMetadata> {
  const system = buildMetadataSystem(opts, normalizeStats(stats ?? []), flagKeys ?? [])
  const startedAt = Date.now()
  try {
    const raw = await (opts?.call || callLLM)({
      model: opts?.model || AI_MODELS.metadata,
      purpose: 'scene_witness',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: narrative },
      ],
      temperature: 0.2,
      // Raised with the physical-state fields: at 450 a turn with a grip plus a
      // location change could truncate, and a truncated witness falls back to
      // empty — silently losing the presence read for that turn. Raised again
      // (620 → 720) because the stat/flag mutations and the scene tag now come
      // back in this answer too.
      maxTokens: 720,
      responseSchema: WITNESS_SCHEMA,
    })
    opts?.onRaw?.('scene_witness', raw)
    const v = validateHalf(raw)
    return {
      ...WITNESS_FALLBACK,
      present_characters: v.present_characters,
      characters_departed: v.characters_departed ?? [],
      physical_state_opened: v.physical_state_opened ?? [],
      physical_state_closed: v.physical_state_closed ?? [],
      current_location: v.current_location ?? null,
      player_destination: v.player_destination ?? null,
      player_travel_confirmed: v.player_travel_confirmed === true,
      location_evidence: v.location_evidence ?? null,
      location_evidence_source: v.location_evidence_source ?? null,
      containment_hint: v.containment_hint ?? null,
      movement: v.movement ?? 'none',
      viewpoint_moved: v.viewpoint_moved === true,
      time_elapsed: v.time_elapsed ?? null,
      time_evidence: v.time_evidence ?? null,
      location_state_changes: v.location_state_changes ?? [],
      location_permanent_facts: v.location_permanent_facts ?? [],
      state_mutations: v.state_mutations ?? {},
      flag_mutations: v.flag_mutations ?? {},
      scene_tag: v.scene_tag ?? 'dialogue',
      emotional_tone: v.emotional_tone ?? 'neutral',
    }
  } catch {
    return { ...WITNESS_FALLBACK, scene_tag: 'intimate' }
  } finally {
    // A failed call is still time the tail waited, so the stage is reported on
    // both paths; only a call that never happened leaves no stage.
    opts?.onStage?.('scene_witness', Date.now() - startedAt)
  }
}

/** Explicit execution controls let the read-only experiment use the production
 * request builder, validator and fallback without changing process-global flags. */
export interface ChoiceMetadataExecution {
  split?: boolean
  call?: typeof callLLM
}

/**
 * Keep two index-aligned choice lists together through an arbitrary filter.
 * Exported for rl-3: the processor's later filters (deceased names, grounding)
 * must drop a native chip and its English pair in one step. With no English
 * list (an English save) the native list is filtered alone and `choices_en` is
 * empty. A choice with no English entry is dropped rather than kept half-paired.
 */
export function filterChoicePairs<T extends { label?: string }>(
  choices: T[],
  choicesEn: readonly ChoiceEnglish[] | undefined,
  keep: (choice: T, english: ChoiceEnglish | undefined, index: number) => boolean,
): { choices: T[]; choices_en: ChoiceEnglish[] } {
  const keptChoices: T[] = []
  const keptEnglish: ChoiceEnglish[] = []
  choices.forEach((choice, index) => {
    const english = choicesEn?.[index]
    if (choicesEn !== undefined && !english) return
    if (!keep(choice, english, index)) return
    keptChoices.push(choice)
    if (english) keptEnglish.push(english)
  })
  return { choices: keptChoices, choices_en: keptEnglish }
}

/**
 * Whether any button names one of `names`, read exactly as the processor's
 * this-turn deaths filter reads it: the English pair when there is one, else
 * the chip, `label send`, whole word, any case. The deaths call can only report
 * a name from the cast list, and that filter only drops a button naming a
 * reported name, so when this is false for the cast list the deaths answer
 * cannot change the buttons and they need not wait for it.
 */
export function choicesNameAnyone<T extends { label?: string; send?: string }>(
  choices: T[],
  choicesEn: readonly ChoiceEnglish[] | undefined,
  names: readonly string[],
): boolean {
  const escaped = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = names.filter(Boolean).map((name) => new RegExp(`\\b${escaped(name)}\\b`, 'i'))
  if (!patterns.length) return false
  return choices.some((choice, index) => {
    const pair = choicesEn?.[index] ?? choice
    const text = `${pair.label} ${pair.send}`
    return patterns.some((pattern) => pattern.test(text))
  })
}

/**
 * CHOICE half — suggested player moves, the milestone and the beat ledger. The
 * stat/flag mutations, scene tag and tone belong to the witness half now; this
 * answer fills them with the safe defaults and the merge takes the witness's.
 * Falls back to an `intimate` scene tag to preserve NSFW momentum (matching the
 * legacy no-op fallback) on failure.
 *
 * `narrative` may be a Promise on a non-English turn: rl-3 can launch this half
 * with the native text in `opts.choiceLanguage` before the English copy exists.
 * The witness half and the ledger read the (possibly awaited) `narrative`.
 */
export async function extractChoiceMetadata(
  narrative: string | Promise<string>,
  stats: StatInput,
  flagKeys: string[],
  opts?: MetadataOpts,
  execution?: ChoiceMetadataExecution,
): Promise<SceneMetadata> {
  const language = opts?.choiceLanguage
  const normalizedStats = normalizeStats(stats)
  const baseSystem = buildMetadataSystem(opts, normalizedStats, flagKeys)
  const choiceContext = String(opts?.choiceContext || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 18_000)
  const withChoiceContext = (base: string): string => choiceContext
    ? `${base}\n\n--- CHOICE DECISION CONTEXT (selected story facts available to the narrator) ---\n${choiceContext}\nUse these facts together with the completed narrative. They are canon for grounding choices, not dialogue to quote or replay.\n--- END CHOICE DECISION CONTEXT ---`
    : base
  const system = withChoiceContext(baseSystem)
  const split = execution?.split ?? env.CHOICE_LEDGER_SPLIT === 'on'
  const ledgerRule = METADATA_RULES.split('\n').find((line) => line.startsWith('- beat_ledger:'))!
  // The choice half reads the NATIVE prose and player turn on a non-English
  // turn; the witness half and the ledger keep the main (English) narrative.
  const choiceBase = language
    ? withChoiceContext(buildMetadataSystem(opts, normalizedStats, flagKeys, language.playerInput))
    : system
  const strippedChoiceBase = split ? choiceBase.replace(ledgerRule + '\n', '') : choiceBase
  // This half no longer returns the four moved fields, so it is not told their
  // rules — in the split and the unsplit case alike. The ledger's own system is
  // built from `ledgerSystem` (today's `system`), so it keeps its rule.
  const buttonsBase = MOVED_RULES.reduce((base, rule) => base.replace(rule + '\n', ''), strippedChoiceBase)
  // The gender line, then the one language line at the very end — after the
  // choice context too. Absent gender leaves both strings as they were.
  const genderRule = opts?.playerGender
    ? choiceGenderInstruction(opts.playerGender, !!language)
    : ''
  const choicesSystem = language
    ? `${buttonsBase}${genderRule ? `\n${genderRule}` : ''}\n${choiceLanguageInstruction(language.name)}`
    : `${buttonsBase}${genderRule ? `\n${genderRule}` : ''}`
  const invoke = execution?.call || opts?.call || callLLM
  // Launch before awaiting choices, and catch independently: a ledger outage
  // must never discard successful choices (or vice versa). Timed around this
  // call alone: the ledger runs beside the choices request, so a reading taken
  // around the pair would charge the ledger's wait to `choice_metadata`.
  const ledgerPromise = split ? (async () => {
    const ledgerStartedAt = Date.now()
    try {
      // A non-English turn hands the ledger the English copy, so it waits for
      // that copy — never for the native-only choice call.
      const ledgerNarrative = typeof narrative === 'string' ? narrative : await narrative
      // An early launch was given the native player line; the ledger's PLAYER
      // TURN is the English one, so it is rebuilt from the copy's own value.
      const english = opts?.englishTurn ? await opts.englishTurn : undefined
      const ledgerSystem = english
        ? withChoiceContext(buildMetadataSystem({ ...opts, playerInput: english.playerInput }, normalizedStats, flagKeys))
        : system
      const raw = await invoke({
        model: AI_MODELS.metadata,
        purpose: 'beat_ledger',
        firstTokenHedge: {
          delayMs: env.CHOICE_HEDGE_MS,
          lostPurpose: 'beat_ledger_hedge_lost',
        },
        messages: [
          { role: 'system', content: ledgerSystem.replace(METADATA_RULES,
            METADATA_RULES.slice(0, METADATA_RULES.indexOf('\n\nRules:')) + '\n\nRules:\n' + ledgerRule + '\n') },
          { role: 'user', content: ledgerNarrative },
        ],
        temperature: 0.2,
        maxTokens: 450,
        responseSchema: LEDGER_ONLY_SCHEMA,
      })
      return validateHalf(raw).beat_ledger
    } catch {
      return WITNESS_FALLBACK.beat_ledger
    } finally {
      // A failed ledger call is still time the join waited. Only an unsplit
      // choice pass — no ledger call at all — leaves no stage.
      opts?.onStage?.('beat_ledger', Date.now() - ledgerStartedAt)
    }
  })() : undefined
  // Starts at the choices request, and settles when it does: the join with the
  // ledger happens after this stage is recorded, so `choice_metadata` never
  // includes the ledger's wait.
  const startedAt = Date.now()
  const choicePromise = (async () => {
    try {
      const askChoices = async (model: string, noReasoning: boolean): Promise<SceneMetadata> => {
        const choiceNarrative = language
          ? language.narrative
          : typeof narrative === 'string' ? narrative : await narrative
        const raw = await invoke({
          model,
          ...(noReasoning ? { noReasoning: true } : {}),
          purpose: 'choice_metadata',
          firstTokenHedge: {
            delayMs: env.CHOICE_HEDGE_MS,
            lostPurpose: 'choice_metadata_hedge_lost',
            onHedge: opts?.onChoiceHedge,
            onFirstToken: (winner) => opts?.onChoiceFirstToken?.(Date.now() - startedAt, winner),
          },
          messages: [
            { role: 'system', content: choicesSystem },
            { role: 'user', content: choiceNarrative },
          ],
          temperature: 0.2,
          // The beat ledger adds a handful of short semantic fields to this
          // existing post-stream pass. It never sits on the narrator's first-token
          // path, but leave enough room that a valid ledger cannot crowd out the
          // core choices/state metadata. The paired (non-English) variant carries
          // two more short fields per choice.
          maxTokens: language ? 900 : 450,
          responseSchema: language
            ? split ? CHOICES_ONLY_SCHEMA_EN : CHOICE_META_SCHEMA_EN
            : split ? CHOICES_ONLY_SCHEMA : CHOICE_META_SCHEMA,
        })
        opts?.onRaw?.('choice_metadata', raw)
        let v = validateHalf(raw, language ? { choiceLanguage: true } : undefined)
        if (language && v.choices.length < CHOICE_PAIR_FLOOR) {
          v = validateHalf(await withMissingChoiceCopies(raw, language.name, invoke), { choiceLanguage: true })
        }
        const nativeChoices = v.choices || []
        const englishChoices = language ? (v.choices_en || []) : undefined
        // Drop repeats on the native side (labels and the player's own line) and,
        // on a non-English turn, on the English pair against the known English
        // line — keeping the two lists index-aligned through the same order.
        const nativePlayerLine = language ? language.playerInput : opts?.playerInput
        const keptOrder = keptChoiceIndices(
          nativeChoices,
          englishChoices,
          opts?.recentChoiceLabels || [],
          CHOICE_PAIR_FLOOR,
          nativePlayerLine,
          // An early launch has no English line yet; it is awaited here, after
          // the model answered, so the buttons never wait on the copy.
          language ? (opts?.englishTurn ? (await opts.englishTurn).playerInputEnglish : opts?.playerInputEnglish) : undefined,
        )
        return {
          ...WITNESS_FALLBACK,
          // The witness half now writes these four; the buttons answer cannot
          // carry them, so the safe defaults stand until the halves are merged.
          state_mutations: WITNESS_FALLBACK.state_mutations,
          flag_mutations: WITNESS_FALLBACK.flag_mutations,
          scene_tag: WITNESS_FALLBACK.scene_tag,
          emotional_tone: WITNESS_FALLBACK.emotional_tone,
          beat_ledger: v.beat_ledger,
          choices: keptOrder.map((index) => nativeChoices[index]),
          ...(englishChoices === undefined
            ? {}
            : { choices_en: keptOrder.map((index) => englishChoices[index]) }),
          milestone: v.milestone,
        }
      }
      try {
        const first = await askChoices(AI_MODELS.choices, true)
        if ((first.choices?.length ?? 0) > 0) { opts?.onChoiceModel?.(AI_MODELS.choices); return first }
      } catch { /* fall through to the one retry */ }
      // A host outage or a refused adult scene must never leave the turn without buttons.
      const retry = await askChoices(AI_MODELS.metadata, false)
      opts?.onChoiceModel?.(AI_MODELS.metadata)
      return retry
    } catch {
      return { ...WITNESS_FALLBACK, scene_tag: 'intimate' }
    } finally {
      opts?.onStage?.('choice_metadata', Date.now() - startedAt)
    }
  })()
  const choices = await choicePromise
  // The buttons are publishable now; the ledger join below must not hold them.
  // A throwing callback cannot change what this function returns.
  try { opts?.onChoices?.(choices) } catch {}
  return ledgerPromise ? { ...choices, beat_ledger: await ledgerPromise } : choices
}

/**
 * Derive ALL structured fields (state/flag mutations, scene tag, tone, choices,
 * milestone, presence, location, time) from a finished narrative by running the
 * WITNESS and CHOICE halves in parallel and merging. The tracked stats and flags
 * go to the witness half, which judges them. Runs on EVERY turn:
 * the narrator is always `proseOnly` (streamed prose, uncensored-model
 * compatible), so this cheap reliable model handles the structured bookkeeping.
 * `opts.protagonist` anchors first-person choice generation to the player so the
 * choice viewpoint can't drift in third-person prose. A failure in one half
 * falls back to safe defaults for ONLY that half — the other half is unaffected.
 */
export async function extractSceneMetadata(
  narrative: string | Promise<string>,
  stats: StatInput,
  flagKeys: string[],
  opts?: MetadataOpts,
): Promise<SceneMetadata> {
  const [witness, choice] = await Promise.all([
    (async () => extractSceneWitness(typeof narrative === 'string' ? narrative : await narrative, opts, stats, flagKeys))(),
    extractChoiceMetadata(narrative, stats, flagKeys, opts),
  ])
  return mergeSceneMetadata(witness, choice)
}

/**
 * Join the two halves. Exported so rl-3 can launch them separately: the choice
 * half starts on the native text at stream end while the witness half waits for
 * the English copy, then both are merged here with the same shape as before.
 */
export function mergeSceneMetadata(witness: SceneMetadata, choice: SceneMetadata): SceneMetadata {
  return {
    // WITNESS half
    present_characters: witness.present_characters,
    characters_departed: witness.characters_departed,
    physical_state_opened: witness.physical_state_opened,
    physical_state_closed: witness.physical_state_closed,
    current_location: witness.current_location,
    player_destination: witness.player_destination,
    player_travel_confirmed: witness.player_travel_confirmed,
    location_evidence: witness.location_evidence,
    location_evidence_source: witness.location_evidence_source,
    containment_hint: witness.containment_hint,
    movement: witness.movement,
    viewpoint_moved: witness.viewpoint_moved,
    time_elapsed: witness.time_elapsed,
    time_evidence: witness.time_evidence,
    location_state_changes: witness.location_state_changes,
    location_permanent_facts: witness.location_permanent_facts,
    state_mutations: witness.state_mutations,
    flag_mutations: witness.flag_mutations,
    scene_tag: witness.scene_tag,
    emotional_tone: witness.emotional_tone,
    // CHOICE half
    beat_ledger: choice.beat_ledger,
    choices: choice.choices,
    ...(choice.choices_en ? { choices_en: choice.choices_en } : {}),
    milestone: choice.milestone,
  }
}
