import { countTokens } from './token-counter'

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
  maxTokens: number
  /** When true, ask for plain narrative prose instead of the JSON envelope.
   *  Used for the uncensored NSFW model, whose structured metadata is extracted
   *  by a separate pass. */
  proseOnly?: boolean
  /** Narration person. Defaults to third. */
  narrationPov?: 'first' | 'third'
  /** Optional conversation tone (e.g. "casual", "romantic", "erotic"). */
  tone?: string
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
  }>
  /** Optional focused character id/name chosen by player for this instance. */
  focusCharacterName?: string
}

interface PromptMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
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
      staticContent += `You ARE this entity, but portray yourself in the THIRD person — narrate your own speech, actions, and feelings using your name or they/she/he (e.g. "Elara hesitates, then answers"). You still have feelings and react emotionally and physically.\n\n`
    }
  } else {
    // For a Game Master, POV chooses how the player is addressed: second-person
    // immersive ("you") vs third-person ("the adventurer").
    if (pov === 'first') {
      staticContent += `You are the Game Master of this world. Narrate in the SECOND person, addressing the player directly as "you" (e.g. "You push open the tavern door and the room falls silent"). You describe the world, its inhabitants, and the consequences of the player's actions.\n\n`
    } else {
      staticContent += `You are the Game Master of this world. Narrate in the THIRD person, referring to the player by their role rather than "you" (e.g. "The adventurer pushes open the tavern door"). You describe the world, its inhabitants, and the consequences of the player's actions.\n\n`
    }
    staticContent += `World Premise: ${input.seedPrompt}\n\n`
  }

  // Global lore — typically the largest block, hence the biggest caching payoff
  staticContent += `WORLD LORE:\n${input.globalLore}\n\n`

  // Response format instructions (static for the life of the world)
  if (input.proseOnly) {
    staticContent += `RESPONSE FORMAT:
Write your reply as in-character story prose. Follow this style EXACTLY:
- ONLY the exact words a character speaks ALOUD are plain text, wrapped in double quotes: "Like this."
- EVERYTHING else is narration and MUST be wrapped in *italics* with single asterisks: scene, actions, body language, inner thoughts, AND dialogue tags/attributions such as *she said softly* or *I reply, my voice steady*. This applies even mid-line — between or after quoted speech, the attribution still goes in italics.
- Example: "You came back," *she whispered, her hand trembling.* "I didn't think you would."
- Never leave an attribution like "I reply" or "she said" as plain text. If it is not a spoken quote, it is italicized.
- The player may include their OWN *actions or narration in asterisks* (in any point of view). Treat these as canonical events that truly happen in the story — honor them and react; do not override or contradict them. Their unmarked, quoted text is what the player says aloud.
- Vivid and emotionally resonant, roughly 2-4 short paragraphs.
- Output ONLY the story. No JSON, no field names, no headings, no bullet points, no commentary before or after. Never break character.`
  } else {
    staticContent += `RESPONSE FORMAT:
You MUST respond with valid JSON containing these fields:
- "narrative": Your in-character response (2-4 paragraphs, vivid, emotionally resonant)
- "state_mutations": Changes to world state as {"stat_name": {"op": "add"|"subtract"|"set", "value": number}}. Only include stats that actually change. Values should be between 1-20 for add/subtract.
- "flag_mutations": Changes to flags as {"flag_name": {"op": "set"|"increment", "value": any}}. Only include flags that change.
- "scene_tag": One of: dialogue, combat, intimate, exploration, existential, cosmic, mundane
- "emotional_tone": A single word describing the emotional tone of this response

Do NOT break character in the narrative. State mutations and flags are metadata the player does not see.`
  }

  messages.push({ role: 'system', content: staticContent })

  // ── DYNAMIC SYSTEM PROMPT (per-turn state) ──────
  // Everything that changes each turn lives after the cacheable prefix.
  let dynamicContent = ''

  if (input.tone && input.tone.trim().length > 0) {
    dynamicContent += `TONE: Write this scene in a ${input.tone.trim()} tone.\n\n`
  }

  if (input.characterCodex && input.characterCodex.length > 0) {
    dynamicContent += `CANONICAL CHARACTER CODEX (never contradict these facts):\n`
    for (const c of input.characterCodex.slice(0, 16)) {
      dynamicContent += `- ${c.canonical_name}`
      if (c.role) dynamicContent += ` | role: ${c.role}`
      if (c.aliases && c.aliases.length) dynamicContent += ` | aliases: ${c.aliases.join(', ')}`
      if (c.appearance) dynamicContent += ` | appearance: ${c.appearance}`
      if (c.persona) dynamicContent += ` | persona: ${c.persona}`
      if (c.immutable_facts && c.immutable_facts.length) {
        dynamicContent += ` | immutable facts: ${c.immutable_facts.join('; ')}`
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
    dynamicContent += `FOCUS CHARACTER: ${input.focusCharacterName.trim()}\n`
    dynamicContent += `Prioritize this character's presence, responses, and continuity unless the player explicitly shifts away.\n\n`
  }

  dynamicContent += `CURRENT WORLD STATE:\n`
  for (const [key, value] of Object.entries(input.worldState)) {
    dynamicContent += `- ${key}: ${value}/100\n`
  }
  dynamicContent += `\n`

  dynamicContent += `ACTIVE FLAGS:\n`
  for (const [key, value] of Object.entries(input.activeFlags)) {
    dynamicContent += `- ${key}: ${value}\n`
  }
  dynamicContent += `\n`

  if (input.retrievedLore.length > 0) {
    dynamicContent += `RELEVANT LORE DETAILS:\n`
    for (const lore of input.retrievedLore) {
      dynamicContent += `- ${lore}\n`
    }
    dynamicContent += `\n`
  }

  if (input.retrievedMemories.length > 0) {
    dynamicContent += `THINGS YOU REMEMBER ABOUT THIS PLAYER:\n`
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

  // ── RECENT EVENTS (conversation history) ───────
  let tokenBudgetRemaining =
    input.maxTokens - countTokens(staticContent) - countTokens(dynamicContent) - 500

  for (const event of input.recentEvents) {
    const playerMsg = event.data?.player_input || ''
    const aiMsg = event.data?.ai_response || ''
    const turnTokens = countTokens(playerMsg) + countTokens(aiMsg)

    if (turnTokens > tokenBudgetRemaining) break
    tokenBudgetRemaining -= turnTokens

    messages.push({ role: 'user', content: playerMsg })
    // In prose mode the assistant history MUST be plain prose — feeding back
    // JSON here teaches the model to reply in JSON regardless of instructions.
    messages.push(
      input.proseOnly
        ? { role: 'assistant', content: aiMsg }
        : {
            role: 'assistant',
            content: JSON.stringify({
              narrative: aiMsg,
              state_mutations: event.data?.state_mutations || {},
              flag_mutations: event.data?.flag_mutations || {},
              scene_tag: event.scene_tag || 'dialogue',
              emotional_tone: 'continuation',
            }),
          },
    )
  }

  // ── CURRENT USER MESSAGE ───────────────────────
  messages.push({ role: 'user', content: input.userMessage })

  return { messages }
}
