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
}

interface PromptMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export function buildPrompt(input: PromptInput): { messages: PromptMessage[] } {
  const messages: PromptMessage[] = []

  // ── SYSTEM PROMPT ──────────────────────────────
  let systemContent = ''

  // Identity framing
  if (input.isSentient) {
    systemContent += `${input.seedPrompt}\n\n`
    systemContent += `You ARE this entity. Respond in first person. You have feelings. You react to their actions emotionally and physically.\n\n`
  } else {
    systemContent += `You are the Game Master of this world. Narrate in third person. You describe the world, its inhabitants, and the consequences of the player's actions.\n\n`
    systemContent += `World Premise: ${input.seedPrompt}\n\n`
  }

  // Current state injection
  systemContent += `CURRENT WORLD STATE:\n`
  for (const [key, value] of Object.entries(input.worldState)) {
    systemContent += `- ${key}: ${value}/100\n`
  }
  systemContent += `\n`

  systemContent += `ACTIVE FLAGS:\n`
  for (const [key, value] of Object.entries(input.activeFlags)) {
    systemContent += `- ${key}: ${value}\n`
  }
  systemContent += `\n`

  // Lore injection
  systemContent += `WORLD LORE:\n${input.globalLore}\n\n`
  if (input.retrievedLore.length > 0) {
    systemContent += `RELEVANT LORE DETAILS:\n`
    for (const lore of input.retrievedLore) {
      systemContent += `- ${lore}\n`
    }
    systemContent += `\n`
  }

  // Memory injection
  if (input.retrievedMemories.length > 0) {
    systemContent += `THINGS YOU REMEMBER ABOUT THIS PLAYER:\n`
    for (const mem of input.retrievedMemories) {
      systemContent += `- ${mem}\n`
    }
    systemContent += `\n`
  }

  // Response format instructions
  systemContent += `RESPONSE FORMAT:
You MUST respond with valid JSON containing these fields:
- "narrative": Your in-character response (2-4 paragraphs, vivid, emotionally resonant)
- "state_mutations": Changes to world state as {"stat_name": {"op": "add"|"subtract"|"set", "value": number}}. Only include stats that actually change. Values should be between 1-20 for add/subtract.
- "flag_mutations": Changes to flags as {"flag_name": {"op": "set"|"increment", "value": any}}. Only include flags that change.
- "scene_tag": One of: dialogue, combat, intimate, exploration, existential, cosmic, mundane
- "emotional_tone": A single word describing the emotional tone of this response

Do NOT break character in the narrative. State mutations and flags are metadata the player does not see.`

  messages.push({ role: 'system', content: systemContent })

  // ── SCENE SUMMARY ──────────────────────────────
  if (input.sceneSummary) {
    messages.push({
      role: 'system',
      content: `PREVIOUS SCENE SUMMARY:\n${input.sceneSummary}`,
    })
  }

  // ── RECENT EVENTS (conversation history) ───────
  let tokenBudgetRemaining = input.maxTokens - countTokens(systemContent) - 500

  for (const event of input.recentEvents) {
    const playerMsg = event.data?.player_input || ''
    const aiMsg = event.data?.ai_response || ''
    const turnTokens = countTokens(playerMsg) + countTokens(aiMsg)

    if (turnTokens > tokenBudgetRemaining) break
    tokenBudgetRemaining -= turnTokens

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

  // ── CURRENT USER MESSAGE ───────────────────────
  messages.push({ role: 'user', content: input.userMessage })

  return { messages }
}
