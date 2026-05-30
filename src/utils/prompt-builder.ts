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

  // Identity framing
  if (input.isSentient) {
    staticContent += `${input.seedPrompt}\n\n`
    staticContent += `You ARE this entity. Respond in first person. You have feelings. You react to their actions emotionally and physically.\n\n`
  } else {
    staticContent += `You are the Game Master of this world. Narrate in third person. You describe the world, its inhabitants, and the consequences of the player's actions.\n\n`
    staticContent += `World Premise: ${input.seedPrompt}\n\n`
  }

  // Global lore — typically the largest block, hence the biggest caching payoff
  staticContent += `WORLD LORE:\n${input.globalLore}\n\n`

  // Response format instructions (static for the life of the world)
  if (input.proseOnly) {
    staticContent += `RESPONSE FORMAT:
Write your reply as in-character story prose. Follow this style strictly:
- Put ALL narration, scene description, actions, and inner thoughts in *italics* (wrapped in single asterisks).
- Write characters' actual SPOKEN words as plain text (no asterisks), e.g. on their own line: "I won't let you pass."
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
