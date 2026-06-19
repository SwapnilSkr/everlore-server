import { callLLM, AI_MODELS } from '../../src/ai'
import { enforceSchema, type GenerationOutput } from './structured-output'

/** Structured fields derived from a narrative — everything except the prose itself. */
export type SceneMetadata = Omit<GenerationOutput, 'narrative'>

/**
 * The metadata pass is SPLIT into two focused LLM calls so the most fragile
 * half (the SCENE WITNESS: who is present / where / how time moved) can fail
 * without corrupting the CHOICE/STAT half, and vice versa. `extractSceneMetadata`
 * runs both in parallel and merges — every caller (main turn, edit, replay) gets
 * the isolation for free with an identical return shape. See METADATA_SPLIT.md.
 */

/** WITNESS schema — the fragile, low-token scene-observation half: presence,
 *  departures, location, movement, time, and place facts. A bad/truncated
 *  witness response falls back to safe defaults and never touches choices. */
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
    current_location: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
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
  },
  required: ['present_characters', 'characters_departed', 'current_location', 'containment_hint', 'movement', 'viewpoint_moved', 'time_elapsed', 'location_state_changes', 'location_permanent_facts'],
}

/** CHOICE/STAT schema — the player-moves + bookkeeping half: choices, scene tag,
 *  tone, milestone, stat/flag mutations. Isolated from the witness half. */
const CHOICE_META_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
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
  required: ['state_mutations', 'flag_mutations', 'scene_tag', 'emotional_tone', 'choices', 'milestone'],
}

/** Default for the WITNESS half — used when its call fails so a witness outage
 *  never throws or pollutes the choice half. Presence/location stay empty/unchanged. */
const WITNESS_FALLBACK: SceneMetadata = {
  present_characters: [],
  characters_departed: [],
  current_location: null,
  containment_hint: null,
  movement: 'none',
  viewpoint_moved: false,
  time_elapsed: null,
  location_state_changes: [],
  location_permanent_facts: [],
  state_mutations: {},
  flag_mutations: {},
  scene_tag: 'dialogue',
  emotional_tone: 'neutral',
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
- state_mutations: include ONLY stats that actually changed this passage. op is "add"|"subtract"|"set"; for add/subtract keep value between 1 and 20. Only the tracked stat names listed in CONTEXT below may be used.
- flag_mutations: include ONLY flags that changed. op is "set"|"increment"|"decrement". Only the tracked flag names listed in CONTEXT below may be used.
- scene_tag: one of dialogue, combat, romantic, intimate, exploration, existential, cosmic, mundane. Use "romantic" for affectionate/romantic but non-explicit scenes (flirting, kissing, emotional intimacy). Use "intimate" ONLY for explicit sexual content.
- emotional_tone: a single word.
- choices: 2-4 distinct suggested next moves for the player, ALWAYS written from the PLAYER's own first-person viewpoint ("I ..."). Who the player is — and whether this is a Game-Master world where the player IS the protagonist, or a sentient world where the player is a separate person talking to the main character — is given under WORLD MODE in the CONTEXT section below; honor it. NEVER refer to the player's own character in the third person or by role in either the label or the send (e.g. do not write "Observe the son" when the player IS the son — write "Watch my brother" / "*I watch him closely*"). Each is an object { label, kind, send }:
    - label: the short chip caption shown to the player — an imperative the player gives THEMSELF, 2-6 words, no trailing punctuation (e.g. "Take her hand", "Ask what she's hiding", "Draw your blade"). It must share the send's first-person viewpoint: address other people from the player's vantage ("Confront my brother"), never narrate the player's own character from outside ("Observe the son" when the player is the son is WRONG).
    - send: the player's move, in FIRST PERSON ("I ..."), pre-formatted so the player can edit it before sending. Wrap any narrated action/gesture in *single asterisks*; write spoken words as plain text OUTSIDE the asterisks (no quotation marks). You MAY combine a brief narration and a spoken line when it fits the moment. Examples:
        - silent action → send "*I reach out and take her hand.*"
        - spoken line → send "What are you hiding from me?"
        - narration + speech → send "*I step closer, lowering my voice.* What are you hiding from me?"
    - kind: "say" if send contains any spoken words (even alongside an action); "act" only for a silent action. Drives the chip's icon.
  The set must be distinct in spirit — mix bold / cautious / emotional / curious, and include at least one "say" and one "act" when both fit. Ground every choice in what THIS passage just established; never invent new characters, places, or facts. When a choice refers to another person, name them by their CANONICAL name from the KNOWN CAST (in CONTEXT below) when they are one of them. FIGURATIVE vs LITERAL — read the WORLD CONTEXT (in CONTEXT below) to judge whether the world actually contains supernatural / non-human beings (ghosts, spirits, monsters, gods, demons, angels, AIs, aliens). In a GROUNDED, realistic world that has none, an evocative noun the prose applies to a PERSON — "the ghost in the doorway", "the monster at the head of the table", "the shadow of a man", "a wolf in a suit" — is a METAPHOR for an existing character (very often the protagonist or someone present), NOT a real new entity. NEVER write a choice that treats such a metaphor as a literal separate someone to ask about, observe, or approach ("Ask her about the ghost" when "the ghost" is just the overlooked protagonist is WRONG) — address the actual person instead. Treat such a being as a literal entity ONLY when the WORLD CONTEXT establishes that kind of being is real here.
- milestone: null almost always. Set a short evocative label (3-8 words) ONLY when this passage crossed a true story landmark: a vow or marriage, a first kiss, a death of a significant character, a title/power gained, a major victory or betrayal, a life-changing decision. Routine progress is NOT a milestone.
- present_characters: the people who appear physically in the scene WITH the viewpoint during THIS passage — anyone who speaks, acts, or is shown to be in the room right now. (You do NOT need to re-list people from earlier who simply weren't mentioned this turn; the system carries them forward automatically — the people present at the end of last turn are listed in CONTEXT below for your reference.) For anyone matching the KNOWN CAST, use their CANONICAL name (not the alias/role/pronoun the prose used); for a genuinely new person not in the cast, use the clearest name the prose gives. EXCLUDE the player/narrator themself, and anyone only mentioned, remembered, or written about while not actually in the room. Also EXCLUDE a figurative epithet that is really an existing person under a metaphor (per the FIGURATIVE vs LITERAL rule above) — "the ghost", "the monster" for the overlooked protagonist is NOT a separate present character in a grounded world. CRUCIAL: if a person LEAVES by the end of the passage, do NOT list them here — list them in characters_departed instead, even if they spoke or acted earlier in the same passage.
- characters_departed: the people who physically LEFT the scene by the end of this passage — walked out, exited, stormed off, were dismissed, sent away, or died — EVEN IF they spoke or acted earlier in the same passage before leaving. Use their CANONICAL name. A person who rises and leaves the room this turn belongs HERE, not in present_characters. This is the only way someone stops being "present" (the system keeps everyone else from the prior turn in the scene), so a clearly narrated exit MUST be listed. Worked example: prose says "Bram set down his cup, bowed stiffly, and strode from the hall" → characters_departed includes "Bram" (and he is NOT in present_characters). Empty array [] when no one left.
- current_location: the place the viewpoint/protagonist is PHYSICALLY STANDING IN at the end of the passage — where this turn's action and dialogue actually happen. Report ONLY a place the prose shows them physically occupying RIGHT NOW. NEVER report a place that is merely mentioned, named, planned, anticipated, remembered, or where some future event will be held while the characters are not yet there. Worked example: if they sit at the table in the dining room discussing a party that will be held in the great room, current_location is "dining room" — NOT "great room". If the scene simply continues where it already was, return the prior known location unchanged. If the viewpoint is at a place listed in KNOWN PLACES (in CONTEXT below) — including returning to one they left earlier — return that place's EXACT canonical name, never a new variant spelling ("the garden" when KNOWN PLACES has "Night Garden" → return "Night Garden"). Use a fresh name only for a place that is genuinely not yet known. NEVER report a vague or relative label as the location — "the room", "here", "inside", "outside", "this place" are NOT place names; use the SPECIFIC place's name (e.g. "dining room", "the night garden"), or return the prior known location if the viewpoint has not moved. If the viewpoint moves into a personal space the prose marks as someone's OWN ("my room", "her chambers", "his study"), name it for its owner so it is specific and distinct — e.g. the protagonist retreating to "my room" → the protagonist's name (from CONTEXT) + "'s room" (for a protagonist named Mara, "Mara's room"), NOT the bare "the room". Return null ONLY if no place has ever been established. The Prior known location is given in CONTEXT below — return THAT unless the viewpoint has physically moved.
- viewpoint_moved: a boolean. true whenever THIS passage narrates the viewpoint/protagonist physically CHANGING place — walking out, entering another room, setting off on a journey, RETURNING TO or RE-ENTERING a place they had left (e.g. coming back indoors from the garden, stepping back into the mansion), or a scene-cut that puts them somewhere new. It is false when they stay put and nothing relocates them, and ESPECIALLY when another place is only mentioned, named, discussed, or planned while they remain where they are. Rule of thumb: if current_location differs from the prior known location because they actually went there, viewpoint_moved is true; if current_location is unchanged, it is false.
- containment_hint: the name of the place that DIRECTLY CONTAINS current_location, but ONLY when THIS passage actually states or makes it plain (e.g. the prose says they are "in the library of the manor" → containment_hint "the manor"; "a tavern in the riverside district" → "riverside district"). This is the immediate parent, one level up — a room's building, a building's district, a city's realm. Return null when the passage does not make the container explicit. NEVER guess or invent a container to fill this in.
- movement: how current_location relates to the PRIOR known location this turn — one of: "none" (did not move / stayed put), "deeper" (went INTO a place contained by where they were — entered a room of the current building), "out" (LEFT the current place to its surrounding area — stepped outside the house onto the street), "lateral" (moved to another place at the SAME level — one room to another in the same building), "world_shift" (crossed into a wholly different world/realm/plane — a portal to the shadow realm, abduction to another planet, waking in a dream-world). Use "none" whenever viewpoint_moved is false. Choose the single best fit; when unsure between out/lateral use "lateral".
- time_elapsed: how much IN-WORLD time the passage itself narrates passing during this turn — a short human label ("three days", "a week later", "a few hours", "the next morning"). Use this ONLY when the prose clearly skips or spans time (a journey, a "later that night", "weeks passed"). Return null for a continuous, real-time scene where no meaningful time elapses (most dialogue/combat turns). Do not invent time; report only what the passage states or strongly implies.
- location_state_changes: short clauses for what BECAME TRUE about the CURRENT place this turn — its mutable condition. Capture changes in EITHER direction, not only destruction: damage/decline ("the gate now lies in ruins", "the tavern has burned down", "soldiers occupy the square") AND improvement/transformation ("the garden has been restored to bloom", "the hall is now decorated for the feast", "the overgrown courtyard has been cleared", "the hearth is lit and the room is warm again"). If the prose shows the place visibly altered — repaired, rebuilt, cleaned, decorated, brought to life, flooded, emptied, transformed — record it. Each clause must be self-contained and name what changed. Empty array [] when the place's condition did not change (the usual case).
- location_permanent_facts: short clauses for ENDURING, canonical facts about the current place newly established this turn ("the temple was built over a buried god", "this bridge is the only crossing for fifty miles"). These are lasting truths, not passing events or moods. Empty array [] almost always — use sparingly.`

/**
 * Derive ALL structured fields (state/flag mutations, scene tag, tone, choices,
 * milestone, presence, location, time) from a finished narrative. Runs on EVERY
 * turn: the narrator is always `proseOnly` (streamed prose, uncensored-model
 * compatible), so this cheap reliable model handles the structured bookkeeping.
 * `opts.protagonist` anchors first-person choice generation to the player so the
 * choice viewpoint can't drift in third-person prose. Falls back to a no-op
 * (scene stays `intimate` to preserve NSFW momentum) if extraction fails.
 */
type MetadataOpts = {
  isSentient?: boolean
  currentLocationName?: string | null
  /** Characters present at the END of the PRIOR turn, so a character still in
   *  the scene but not named in this passage isn't dropped to "elsewhere". */
  priorPresent?: string[]
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
}

/** Build the STATIC rules + dynamic CONTEXT system prompt shared by both halves.
 *  Keeping all per-turn/per-world values after the rules lets OpenAI prompt
 *  caching reuse the ~2.5K-token rules prefix across turns and worlds. */
function buildMetadataSystem(opts: MetadataOpts | undefined, statKeys: string[], flagKeys: string[]): string {
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
  const priorLocationLabel = opts?.currentLocationName || '(none established yet)'

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
Prior known location (return THIS unless the viewpoint has physically moved): ${priorLocationLabel}
People present at the end of last turn (carried forward automatically — for your reference): ${priorPresentLabel}
Tracked stats (only these names may appear in state_mutations): ${statKeys.length ? statKeys.join(', ') : '(none)'}
Tracked flags (only these names may appear in flag_mutations): ${flagKeys.length ? flagKeys.join(', ') : '(none)'}${rosterClause}${knownPlacesClause}`
  return METADATA_RULES + context
}

/** Reuse enforceSchema's field validation on a raw half-response by injecting a
 *  placeholder narrative (enforceSchema requires one) and returning the full
 *  validated GenerationOutput; each half picks its own fields. */
function validateHalf(raw: string): GenerationOutput {
  return enforceSchema(JSON.stringify({ narrative: 'placeholder', ...safeParseObject(raw) }))
}

/**
 * WITNESS half — the dedicated low-token scene observation: who is present, who
 * left, where the viewpoint stands, how it moved, how time elapsed, and what
 * changed about the place. Isolated from the choice/stat half so a witness
 * failure (truncation, bad JSON) falls back to safe defaults and never corrupts
 * the choices/stats, and vice versa. Returns a full SceneMetadata with only the
 * witness fields populated; the rest are the safe fallback.
 */
export async function extractSceneWitness(
  narrative: string,
  opts?: MetadataOpts,
): Promise<SceneMetadata> {
  const system = buildMetadataSystem(opts, [], [])
  try {
    const raw = await callLLM({
      model: AI_MODELS.metadata,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: narrative },
      ],
      temperature: 0.2,
      maxTokens: 450,
      responseSchema: WITNESS_SCHEMA,
    })
    const v = validateHalf(raw)
    return {
      ...WITNESS_FALLBACK,
      present_characters: v.present_characters,
      characters_departed: v.characters_departed ?? [],
      current_location: v.current_location ?? null,
      containment_hint: v.containment_hint ?? null,
      movement: v.movement ?? 'none',
      viewpoint_moved: v.viewpoint_moved === true,
      time_elapsed: v.time_elapsed ?? null,
      location_state_changes: v.location_state_changes ?? [],
      location_permanent_facts: v.location_permanent_facts ?? [],
    }
  } catch {
    return WITNESS_FALLBACK
  }
}

/**
 * CHOICE/STAT half — suggested player moves, scene tag, tone, milestone, and
 * stat/flag mutations. Kept together (they share one JSON pass) but isolated
 * from the witness half. Falls back to an `intimate` scene tag to preserve NSFW
 * momentum (matching the legacy no-op fallback) on failure.
 */
export async function extractChoiceMetadata(
  narrative: string,
  statKeys: string[],
  flagKeys: string[],
  opts?: MetadataOpts,
): Promise<SceneMetadata> {
  const system = buildMetadataSystem(opts, statKeys, flagKeys)
  try {
    const raw = await callLLM({
      model: AI_MODELS.metadata,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: narrative },
      ],
      temperature: 0.2,
      maxTokens: 350,
      responseSchema: CHOICE_META_SCHEMA,
    })
    const v = validateHalf(raw)
    return {
      ...WITNESS_FALLBACK,
      state_mutations: v.state_mutations,
      flag_mutations: v.flag_mutations,
      scene_tag: v.scene_tag,
      emotional_tone: v.emotional_tone,
      choices: v.choices,
      milestone: v.milestone,
    }
  } catch {
    return { ...WITNESS_FALLBACK, scene_tag: 'intimate' }
  }
}

/**
 * Derive ALL structured fields (state/flag mutations, scene tag, tone, choices,
 * milestone, presence, location, time) from a finished narrative by running the
 * WITNESS and CHOICE/STAT halves in parallel and merging. Runs on EVERY turn:
 * the narrator is always `proseOnly` (streamed prose, uncensored-model
 * compatible), so this cheap reliable model handles the structured bookkeeping.
 * `opts.protagonist` anchors first-person choice generation to the player so the
 * choice viewpoint can't drift in third-person prose. A failure in one half
 * falls back to safe defaults for ONLY that half — the other half is unaffected.
 */
export async function extractSceneMetadata(
  narrative: string,
  statKeys: string[],
  flagKeys: string[],
  opts?: MetadataOpts,
): Promise<SceneMetadata> {
  const [witness, choice] = await Promise.all([
    extractSceneWitness(narrative, opts),
    extractChoiceMetadata(narrative, statKeys, flagKeys, opts),
  ])
  return {
    // WITNESS half
    present_characters: witness.present_characters,
    characters_departed: witness.characters_departed,
    current_location: witness.current_location,
    containment_hint: witness.containment_hint,
    movement: witness.movement,
    viewpoint_moved: witness.viewpoint_moved,
    time_elapsed: witness.time_elapsed,
    location_state_changes: witness.location_state_changes,
    location_permanent_facts: witness.location_permanent_facts,
    // CHOICE/STAT half
    state_mutations: choice.state_mutations,
    flag_mutations: choice.flag_mutations,
    scene_tag: choice.scene_tag,
    emotional_tone: choice.emotional_tone,
    choices: choice.choices,
    milestone: choice.milestone,
  }
}
