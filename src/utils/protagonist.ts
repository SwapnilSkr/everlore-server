import { getOpenAI } from '../config/openai'
import type { ProtagonistDoc } from '../models/world-template.model'

/**
 * Derive the locked protagonist (name + brief persona/appearance) of a sentient
 * world from its seed prompt. Best-effort: returns null on any failure so the
 * caller can fall back to emergent codex tagging. Runs at template authoring
 * time (off the gameplay hot path).
 */
export async function deriveProtagonist(seedPrompt: string): Promise<ProtagonistDoc | null> {
  const seed = (seedPrompt || '').trim()
  if (seed.length < 8) return null

  const system = `You identify the single MAIN CHARACTER described by an AI roleplay system prompt — the persona the player talks TO. Respond ONLY with JSON:
{"name":"the character's name (or a short title if unnamed, e.g. 'The Oracle')","persona":"one concise sentence on personality/role","appearance":"one concise sentence, or empty string"}`

  try {
    const openai = getOpenAI()
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: seed.slice(0, 2000) },
      ],
    })
    const raw = res.choices[0]?.message?.content || '{}'
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
    if (!name) return null
    return {
      name: name.slice(0, 120),
      persona: typeof parsed.persona === 'string' ? parsed.persona.trim().slice(0, 400) : undefined,
      appearance:
        typeof parsed.appearance === 'string' && parsed.appearance.trim()
          ? parsed.appearance.trim().slice(0, 400)
          : undefined,
    }
  } catch {
    return null
  }
}
