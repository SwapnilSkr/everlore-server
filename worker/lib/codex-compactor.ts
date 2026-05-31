import { callLLM, AI_MODELS } from '../../src/ai'

/**
 * Distill an overgrown immutable-fact list back down without losing identity or
 * important irreversible history. Runs async (off the gameplay hot path) when a
 * long-lived character's fact list grows large, so the codex stays bounded over
 * thousands of turns. Returns null on no-op/failure (caller keeps the original).
 */
export async function compactImmutableFacts(
  name: string,
  facts: string[],
  max: number,
): Promise<string[] | null> {
  if (!facts || facts.length <= max) return null

  const system = `You compress a character's PERMANENT fact list for an RPG codex. Distill the facts below to AT MOST ${max} concise, concrete bullet facts.
- Merge redundant or closely related facts; drop trivia.
- PRESERVE core identity (who they are, role, defining traits, key relationships) and important irreversible history (deaths, births, marriages, betrayals, powers gained, oaths).
- Keep each fact short and specific.
Respond ONLY with JSON: {"facts":["fact one","fact two", ...]}`

  let raw: string
  try {
    raw = await callLLM({
      model: AI_MODELS.codexCompaction,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `Character: ${name}\nFacts:\n${facts.map((f) => `- ${f}`).join('\n')}`,
        },
      ],
      temperature: 0.2,
      maxTokens: 700,
      responseFormat: { type: 'json_object' },
    })
  } catch {
    return null
  }

  try {
    const match = raw.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(match ? match[0] : raw)
    const out = Array.isArray(parsed.facts)
      ? parsed.facts.map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, max)
      : null
    return out && out.length ? out : null
  } catch {
    return null
  }
}
