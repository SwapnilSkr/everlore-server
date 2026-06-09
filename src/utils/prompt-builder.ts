import { countTokens } from './token-counter'
import {
  buildStyleBlock,
  buildLengthDirective,
  buildStyleReminder,
  type MessageLength,
} from './narrative-styles'
import { buildModeDirective, modeReminderLabel } from './chat-modes'
import { parsePlayerInput } from './player-input-parser'

interface PromptInput {
  seedPrompt: string
  isSentient: boolean
  worldState: Record<string, number>
  activeFlags: Record<string, any>
  globalLore: string
  retrievedLore: string[]
  retrievedMemories: string[]
  sceneSummary: string | null
  recentEvents: any[]
  userMessage: string
  userSpokenInput?: string
  userNarrationFacts?: string[]
  isContinuation?: boolean
  maxTokens: number
  /** When true, ask for plain narrative prose instead of the JSON envelope.
   *  Used for the uncensored NSFW model, whose structured metadata is extracted
   *  by a separate pass. */
  proseOnly?: boolean
  /** Narration person. Defaults to third. */
  narrationPov?: 'first' | 'third'
  /** Chat MODE key (see chat-modes.ts) — how the chat flows. Player-chosen. */
  chatMode?: string
  /** Narrative VOICE preset key (see narrative-styles.ts). Stable per instance. */
  narrativeStyle?: string
  /** Free-text creator/player style refinements appended to the voice block. */
  styleNotes?: string
  /** Desired reply length: 'short' | 'medium' | 'long'. Defaults to medium. */
  messageLength?: MessageLength
  /** Canonical emergent character cards enforced as story constraints. */
  characterCodex?: Array<{
    canonical_name: string
    aliases?: string[]
    role?: string
    appearance?: string
    persona?: string
    immutable_facts?: string[]
    mutable_state?: string[]
    disposition_to_player?: string
    hidden_thought?: string
    is_protagonist?: boolean
  }>
  /** Optional focused character id/name chosen by player for this instance. */
  focusCharacterName?: string
}

interface PromptMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function openingCharacterName(recentEvents: any[], names: string[]): string | null {
  const last = [...recentEvents].reverse().find((event) => String(event.data?.ai_response || '').trim())
  const text = String(last?.data?.ai_response || '')
    .trim()
    .replace(/^[\s*_]+/, '')
  for (const name of names) {
    if (!name) continue
    const re = new RegExp(`^${escapeRegExp(name)}(?:\\b|'s\\b)`, 'i')
    if (re.test(text)) return name
  }
  return null
}

function eventPlayerParts(event: any): { spoken: string; narrationFacts: string[] } {
  const data = event.data || {}
  if (typeof data.player_spoken_input === 'string' || Array.isArray(data.player_narration_facts)) {
    return {
      spoken: String(data.player_spoken_input || '').trim(),
      narrationFacts: Array.isArray(data.player_narration_facts)
        ? data.player_narration_facts.map((f: unknown) => String(f || '').trim()).filter(Boolean)
        : [],
    }
  }
  const parsed = parsePlayerInput(String(data.player_input || ''))
  return { spoken: parsed.spoken, narrationFacts: parsed.narrationFacts }
}

function continuityText(value: string): string {
  return String(value || '')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700)
}

function formatRecentTurnForContinuity(event: any): string {
  const parts = eventPlayerParts(event)
  const ai = continuityText(event.data?.ai_response || '')
  const lines = [`Turn ${event.sequence || '?'}:`]
  if (parts.narrationFacts.length > 0) {
    lines.push(`- Player actions already happened: ${parts.narrationFacts.join('; ')}`)
  }
  if (parts.spoken) {
    lines.push(`- Player spoke: ${parts.spoken}`)
  } else if (parts.narrationFacts.length === 0) {
    lines.push(`- Player waited/observed without speaking.`)
  }
  if (ai) lines.push(`- Prior outcome facts: ${ai}`)
  return lines.join('\n')
}

function currentTurnUserMessage(input: PromptInput): string {
  const spoken = (input.userSpokenInput ?? input.userMessage).trim()
  const facts = (input.userNarrationFacts || []).map((f) => String(f || '').trim()).filter(Boolean)
  const fallbackInstruction = !spoken && facts.length === 0 && input.userMessage.trim() && !/no spoken dialogue/i.test(input.userMessage)
    ? input.userMessage.trim()
    : ''
  const lines = ['CURRENT PLAYER TURN:']
  if (facts.length > 0) {
    lines.push('Player actions/narration already happened in this turn. Treat them as immediate canon, not suggestions or future intent:')
    for (const fact of facts) lines.push(`- ${fact}`)
  }
  lines.push(`Player spoken aloud: ${spoken || '(none)'}`)
  if (fallbackInstruction) lines.push(`Turn instruction: ${fallbackInstruction}`)
  lines.push('Now respond to this exact current turn. Do not replay, paraphrase, line-edit, or lightly modify the previous assistant response. Advance from the latest established beat and directly acknowledge any player action facts that just happened.')
  return lines.join('\n')
}

export function buildPrompt(input: PromptInput): { messages: PromptMessage[] } {
  const messages: PromptMessage[] = []

  // ── STATIC SYSTEM PROMPT (cacheable prefix) ─────
  // World-stable content emitted first and kept byte-identical across every turn
  // of this instance so OpenAI automatic prompt caching can reuse it. NOTHING
  // that varies per turn (state, flags, retrieved lore/memories) belongs here.
  let staticContent = ''

  // Identity framing — POV is player-controllable (defaults to third person)
  const pov = input.narrationPov ?? 'third'
  if (input.isSentient) {
    staticContent += `${input.seedPrompt}\n\n`
    if (pov === 'first') {
      staticContent += `You ARE this entity. Speak and act in the FIRST person (I, me, my). You have feelings and react to the player's actions emotionally and physically.\n\n`
    } else {
      staticContent += `You ARE this entity, but portray yourself in the THIRD person — narrate your own speech, actions, and feelings with pronouns by default (she/he/they), using your name only when clarity genuinely requires it. You still have feelings and react emotionally and physically.\n\n`
    }
  } else {
    // For a Game Master, POV chooses how the player is addressed: second-person
    // immersive (you) vs third-person (the adventurer).
    if (pov === 'first') {
      staticContent += `You are the Game Master of this world. Narrate in the SECOND person, addressing the player directly as you (e.g. You push open the tavern door and the room falls silent). You describe the world, its inhabitants, and the consequences of the player's actions.\n\n`
    } else {
      staticContent += `You are the Game Master of this world. Narrate in the THIRD person, referring to the player by their role rather than you (e.g. The adventurer pushes open the tavern door). You describe the world, its inhabitants, and the consequences of the player's actions.\n\n`
    }
    staticContent += `World Premise: ${input.seedPrompt}\n\n`
  }

  // Narrative VOICE / STYLE — the single biggest lever on how it sounds.
  // World-stable (per instance) so it stays in the cacheable prefix and costs ~0
  // extra TTFT after turn 1. Placed high so it frames everything that follows.
  const styleBlock = buildStyleBlock(input.narrativeStyle, input.styleNotes)
  if (styleBlock) {
    staticContent += `${styleBlock}\n\n`
  }

  // Global lore — typically the largest block, hence the biggest caching payoff
  staticContent += `WORLD LORE:\n${input.globalLore}\n\n`

  staticContent += `NON-NEGOTIABLE NATURAL PROSE HYGIENE:
- Natural conversation flow is mandatory. Character-name repetition is a quality failure.
- Character names are for disambiguation only: first entrance, reintroduction after absence, direct address, multiple same-gender/ambiguous actors, or explicit contrast between characters.
- If the active character is already clear, do NOT name them again. Use pronouns, body language, gesture, action, silence, dialogue, role descriptors, or setting beats instead.
- Do not use a protagonist's or character's full canonical name in ordinary narration unless the scene genuinely requires formal identification. Prefer a first name or pronoun when a name is unavoidable.
- Do not open replies with a character name by default. Open with speech, action, reaction, body language, silence, setting, or a pronoun.
- Never start consecutive sentences or paragraphs with any character name.
- Never repeat the same character name as a rhythmic sentence starter.
- Do not mention every character in the codex. Refer only to characters actually present, speaking, acting, or being directly discussed in this turn.
- In a one-on-one beat, avoid names almost entirely after the character is established. A single short name is acceptable only if clarity would otherwise suffer.
- In multi-character scenes, use names sparingly to establish who acts or speaks, then switch back to pronouns and distinct actions as soon as clarity is restored.

`

  staticContent += `ANTI-HALLUCINATION RULES:
- Treat lore, memories, summaries, and character cards as reference constraints, not a menu of things to insert.
- Do not introduce new named characters, locations, factions, lore objects, powers, dangers, romance escalations, or plot twists unless the current player turn, recent continuity, or active scene clearly calls for them.
- If a detail is not in the current turn, recent continuity, world state, active flags, relevant lore, memories, or character cards, do not assert it as fact.
- If only one character is active in the beat, keep the reply focused on them and the player. Do not cut away to off-screen characters.
- Prefer reacting to the player's latest action over expanding the setting with unrelated inventions.

`

  // Response format instructions (static for the life of the world)
  if (input.proseOnly) {
    staticContent += `RESPONSE FORMAT:
Write your reply as in-character story prose. Follow this style EXACTLY:
- ONLY the exact words a character speaks ALOUD are wrapped in double quotes, like "I missed you."
- EVERYTHING else is narration and MUST be wrapped in single-asterisk italics: scene, actions, body language, inner thoughts, AND dialogue tags/attributions such as *she said softly* or *I reply, my voice steady*. This applies even mid-line — between or after quoted speech, the attribution still goes in italics.
- Scene description and atmosphere are narration too: *The hearth crackles between you.* Never leave that kind of prose plain.
- Example: "You came back," *she whispered, her hand trembling. The hearth crackled between you.* "I didn't think you would."
- Do not use double asterisks for story prose.
- Never leave an attribution like I reply or she said as plain text. If it is not a spoken quote, it is italicized.
- The player may include their OWN *actions or narration in asterisks* (in any point of view). Treat these as canonical events that truly happen in the story — honor them and react; do not override or contradict them. Their unmarked text is what the player says aloud.
- Vivid and emotionally resonant; match the requested length and voice below.
- Output ONLY the story. No JSON, no field names, no headings, no bullet points, no commentary before or after. Never break character.`
  } else {
    staticContent += `RESPONSE FORMAT:
You MUST respond with valid JSON containing these fields:
- "narrative": Your in-character response (2-4 paragraphs, vivid, emotionally resonant)
- In "narrative", spoken words are wrapped in double quotes; non-spoken narration/actions/attributions are wrapped in single-asterisk italics.
- "state_mutations": Changes to world state as {"stat_name": {"op": "add"|"subtract"|"set", "value": number}}. Only include stats that actually change. Values should be between 1-20 for add/subtract.
- "flag_mutations": Changes to flags as {"flag_name": {"op": "set"|"increment", "value": any}}. Only include flags that change.
- "scene_tag": One of: dialogue, combat, romantic, intimate, exploration, existential, cosmic, mundane. Use "romantic" for affectionate/romantic but non-explicit moments (flirting, kissing, emotional intimacy). Use "intimate" ONLY for explicit sexual content.
- "emotional_tone": A single word describing the emotional tone of this response

Do NOT break character in the narrative. State mutations and flags are metadata the player does not see.`
  }

  messages.push({ role: 'system', content: staticContent })

  // ── DYNAMIC SYSTEM PROMPT (per-turn state) ──────
  // Everything that changes each turn lives after the cacheable prefix.
  let dynamicContent = ''

  // Per-turn modifiers layered on top of the static VOICE block. Chat mode and
  // length change turn-to-turn (player-toggleable), so they live in the dynamic
  // block. Mode governs pacing/intent only; the locked voice owns diction.
  const modeDirective = buildModeDirective(input.chatMode)
  if (modeDirective) dynamicContent += `${modeDirective}\n\n`
  dynamicContent += `${buildLengthDirective(input.messageLength)}\n\n`

  // The locked protagonist is handled separately from side-character NPCs.
  const protagonistCard = (input.characterCodex || []).find((c) => c.is_protagonist)
  const npcCodex = (input.characterCodex || []).filter((c) => !c.is_protagonist)

  if (protagonistCard) {
    // Show the most recent facts (storage may hold more between compactions).
    const facts = (protagonistCard.immutable_facts || []).slice(-14)
    const state = protagonistCard.mutable_state || []
    if (input.isSentient) {
      // Identity is already in the seed ("You ARE Elara"), so don't re-inject
      // persona/appearance. But DO inject evolving history/status so first-person
      // narration stays consistent (e.g. she remembers she broke the engagement).
      if (facts.length || state.length) {
        dynamicContent += `YOUR EVOLVING STATE (you are ${protagonistCard.canonical_name} — stay consistent with what has happened to you):\n`
        for (const f of facts) dynamicContent += `- (happened) ${f}\n`
        for (const s of state) dynamicContent += `- (current) ${s}\n`
        dynamicContent += `\n`
      }
    } else {
      // GM world: the protagonist is the PLAYER. Tell the narrator who they are
      // so the story stays anchored to the player's character + their changes.
      dynamicContent += `THE PLAYER (protagonist — narrate the world around them): ${protagonistCard.canonical_name}\n`
      if (protagonistCard.persona) dynamicContent += `- identity: ${protagonistCard.persona}\n`
      for (const f of facts) dynamicContent += `- (happened) ${f}\n`
      for (const s of state) dynamicContent += `- (current) ${s}\n`
      dynamicContent += `\n`
    }
  }

  if (npcCodex.length > 0) {
    dynamicContent += `CANONICAL CHARACTER CODEX (continuity reference only — not the current scene roster):
- Never contradict these facts when a listed character is actually relevant.
- Do NOT introduce, mention, name-drop, summarize, or cut away to a codex character merely because they appear in this list.
- A codex character belongs in the next reply only if they are already present in the active scene, the player directly mentions them, recent events put them in focus, or their absence would create a clear continuity error.
- If the current beat involves one active character, keep the reply centered on that character and leave unrelated codex characters unmentioned.
CHARACTER CARDS:
`
    for (const c of npcCodex.slice(0, 16)) {
      dynamicContent += `- ${c.canonical_name}`
      if (c.role) dynamicContent += ` | role: ${c.role}`
      if (c.aliases && c.aliases.length) dynamicContent += ` | aliases: ${c.aliases.join(', ')}`
      if (c.appearance) dynamicContent += ` | appearance: ${c.appearance}`
      if (c.persona) dynamicContent += ` | persona: ${c.persona}`
      if (c.immutable_facts && c.immutable_facts.length) {
        dynamicContent += ` | immutable facts: ${c.immutable_facts.slice(-14).join('; ')}`
      }
      if (c.mutable_state && c.mutable_state.length) {
        dynamicContent += ` | current state: ${c.mutable_state.join('; ')}`
      }
      if (c.disposition_to_player) {
        dynamicContent += ` | disposition toward player: ${c.disposition_to_player}`
      }
      if (c.hidden_thought) {
        dynamicContent += ` | private thought (internal only, never quoted verbatim): ${c.hidden_thought}`
      }
      dynamicContent += '\n'
    }
    dynamicContent += '\n'
  }

  if (input.focusCharacterName && input.focusCharacterName.trim()) {
    dynamicContent += `FOCUS CHARACTER: ${input.focusCharacterName.trim()} (continuity anchor, not a forced cameo)\n`
    dynamicContent += `Use this character as the preferred point of continuity only when they are already present, directly addressed, recently central, or naturally relevant to the player's action. Do NOT force them into unrelated scenes, cut away to them, or mention them just because they are focused. If the player shifts away, follow the active scene and let the focus resume only when relevant again.\n\n`
  }

  if (input.userNarrationFacts && input.userNarrationFacts.length > 0) {
    dynamicContent += `PLAYER CANONICAL NARRATION FOR THIS TURN (GROUND TRUTH — these events/facts already happened):\n`
    for (const fact of input.userNarrationFacts) {
      dynamicContent += `- ${fact}\n`
    }
    dynamicContent += `\nHonor these as established reality in THIS SAME reply. Do not postpone them to the next turn, reinterpret them as attempted actions, or answer as if only the spoken text exists. If they imply character changes, portray a believable in-story shift immediately instead of ignoring or contradicting them.\n\n`
  }

  // Stat-less Characters have no world state / flags — omit the blocks entirely
  // so the prompt reads like a conversation, not an RPG dashboard.
  const worldStateEntries = Object.entries(input.worldState || {})
  if (worldStateEntries.length > 0) {
    dynamicContent += `CURRENT WORLD STATE:\n`
    for (const [key, value] of worldStateEntries) {
      dynamicContent += `- ${key}: ${value}/100\n`
    }
    dynamicContent += `\n`
  }

  const activeFlagEntries = Object.entries(input.activeFlags || {})
  if (activeFlagEntries.length > 0) {
    dynamicContent += `ACTIVE FLAGS:\n`
    for (const [key, value] of activeFlagEntries) {
      dynamicContent += `- ${key}: ${value}\n`
    }
    dynamicContent += `\n`
  }

  if (input.retrievedLore.length > 0) {
    dynamicContent += `RELEVANT LORE DETAILS (reference only — use only if it directly applies to the current turn; do not introduce these as active scene elements by default):\n`
    for (const lore of input.retrievedLore) {
      dynamicContent += `- ${lore}\n`
    }
    dynamicContent += `\n`
  }

  if (input.retrievedMemories.length > 0) {
    dynamicContent += `THINGS YOU REMEMBER ABOUT THIS PLAYER (reference only — use for continuity, not as a reason to change topic or summon unrelated events):\n`
    for (const mem of input.retrievedMemories) {
      dynamicContent += `- ${mem}\n`
    }
    dynamicContent += `\n`
  }

  messages.push({ role: 'system', content: dynamicContent })

  // ── SCENE SUMMARY ──────────────────────────────
  if (input.sceneSummary) {
    messages.push({
      role: 'system',
      content: `PREVIOUS SCENE SUMMARY:\n${input.sceneSummary}`,
    })
  }

  // ── RECENT EVENTS (continuity ledger, not style examples) ───────
  let tokenBudgetRemaining =
    input.maxTokens - countTokens(staticContent) - countTokens(dynamicContent) - 500

  const continuityTurns: string[] = []
  for (const event of input.recentEvents) {
    const playerMsg = event.data?.player_input || ''
    const aiMsg = event.data?.ai_response || ''
    const turnTokens = countTokens(playerMsg) + countTokens(aiMsg)

    if (turnTokens > tokenBudgetRemaining) break
    tokenBudgetRemaining -= turnTokens

    if (input.proseOnly) {
      continuityTurns.push(formatRecentTurnForContinuity(event))
    } else {
      messages.push({ role: 'user', content: playerMsg })
      messages.push({
        role: 'assistant',
        content: JSON.stringify({
          narrative: aiMsg,
          state_mutations: event.data?.state_mutations || {},
          flag_mutations: event.data?.flag_mutations || {},
          scene_tag: event.scene_tag || 'dialogue',
          emotional_tone: 'continuation',
        }),
      })
    }
  }

  if (continuityTurns.length > 0) {
    messages.push({
      role: 'system',
      content: `RECENT TURN CONTINUITY (facts only — prior wording has been flattened; do not imitate rhythm, sentence order, formatting mistakes, openings, or imagery):
${continuityTurns.join('\n\n')}`,
    })
  }

  // ── POV REMINDER (last system word before the user turn) ──
  // The recent history above may be written in a DIFFERENT point of view than
  // the player currently has selected (POV is toggleable mid-chat). Models
  // imitate the POV of recent turns over an instruction placed far up in the
  // prefix, so when there is history we restate the directive here — right
  // before the user's message — with a concrete example, and explicitly tell
  // the model to override the earlier pattern. It is kept BEFORE the user turn
  // (not after) so the model answers the player rather than echoing the rule.
  // Empty history (turn 1) doesn't need this; the static instruction governs.
  if (input.recentEvents.length > 0) {
    const selfName = protagonistCard?.canonical_name || 'the character'
    const codexNames = (input.characterCodex || []).map((c) => c.canonical_name).filter(Boolean)
    const previousOpeningName = openingCharacterName(input.recentEvents, codexNames)
    let povReminder: string
    if (input.isSentient) {
      povReminder =
        pov === 'first'
          ? `POINT OF VIEW for your next reply (override any earlier style): write in the FIRST person as ${selfName} — I, me, my. If the turns above were third person, switch now. e.g. *I lower my eyes* NOT *${selfName} lowers her eyes*.`
          : `POINT OF VIEW for your next reply (override any earlier style): write in the THIRD person — use she/he/they by default, and use ${selfName}'s name only when clarity requires it. NEVER I/me/my. If the turns above were first person, switch now. e.g. *She lowers her eyes* NOT *I lower my eyes*.`
    } else {
      povReminder =
        pov === 'first'
          ? `POINT OF VIEW for your next reply (override any earlier style): write in the SECOND person, addressing the player as you. If the turns above did otherwise, switch now. e.g. *You push the door open* NOT *The adventurer pushes the door open*.`
          : `POINT OF VIEW for your next reply (override any earlier style): write in the THIRD person, referring to the player by their role, NEVER you. If the turns above used second person, switch now. e.g. *The adventurer pushes the door open* NOT *You push the door open*.`
    }
    // Reinforce VOICE + tone + length here too: weak models imitate the register
    // of recent history over a static instruction far up the prefix, exactly like
    // POV. A compact restatement right before the user turn keeps the writing on
    // the chosen voice regardless of which model is serving.
    const styleCue = buildStyleReminder(
      input.narrativeStyle,
      modeReminderLabel(input.chatMode),
      input.messageLength,
    )
    if (styleCue) povReminder += `\n${styleCue}`
    povReminder +=
      `\nNAME HYGIENE for your next reply: natural flow is mandatory. Do not open with a character name unless there is no other clear option. Use full names only for formal identification or unavoidable disambiguation. Prefer pronouns, action, body language, dialogue, silence, setting, or role descriptors. Do not repeat the same name as a sentence rhythm.`
    if (previousOpeningName) {
      povReminder += ` Do not start this reply with ${previousOpeningName}; the previous assistant turn already opened that way.`
    }
    if (input.isContinuation && input.isSentient) {
      povReminder += ` This is an autonomous continuation with no new player speech, so do not open with ${selfName}; start with pronoun, action, body language, speech, or setting instead.`
    }
    povReminder +=
      `\nHISTORY HYGIENE: treat previous assistant turns as continuity facts, not prose style to imitate. If earlier turns overused names, repeated sentence shapes, malformed formatting, awkward phrasing, or drifted from the current voice, correct course and follow the current instructions instead.`
    povReminder +=
      `\nANTI-HALLUCINATION: answer only from the current player turn, recent continuity, active scene, and provided reference material. Do not add unrelated lore, off-screen characters, sudden dangers, new locations, or new plot complications just to make the response dramatic.`
    povReminder +=
      `\nFORMAT HYGIENE: spoken words must be wrapped in double quotes. Every non-spoken element must be wrapped in single-asterisk italics, including actions, scene description, atmosphere, inner thoughts, and dialogue tags such as *she said* or *I whisper*. Text outside asterisks must be quoted speech only. Do not use double asterisks. Do not leave narration or attributions as plain text.`

    messages.push({ role: 'system', content: povReminder })
  }

  // ── CURRENT USER MESSAGE ───────────────────────
  messages.push({
    role: 'user',
    content: currentTurnUserMessage(input),
  })

  return { messages }
}
