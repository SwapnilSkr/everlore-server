/**
 * Stage 2 — kinship epithet resolver (micro-LLM, residue-only).
 *
 * Stage 1 resolves the EASY coreferences deterministically (lexical/alias/role
 * overlap, unique structural slot). What's left is genuine SEMANTIC coreference —
 * "the golden child" has no lexical hook and two children exist. Exactly as
 * prose-hygiene escalates its residue to a targeted callLLM, this maps ONLY the
 * unresolved person-epithets to a card, and fires only when Stage 1 leaves
 * residue (most turns: never). Off the TTFT path (post-stream tail). Fail-safe:
 * any error / disabled → returns no mappings (the epithet stays ungrounded, which
 * is safe — the narrator re-interprets the free-text choice anyway).
 */
import { callLLM, AI_MODELS } from '../../src/ai'

export interface EpithetResolverInput {
  epithets: string[]
  roster: { id: string; name: string; role?: string; aliases?: string[] }[]
  sceneText: string
}

export interface EpithetMapping {
  epithet: string
  resolvedId: string | null
  confidence: number
}

function safeParse(raw: string): any {
  try { return JSON.parse(raw) } catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) { try { return JSON.parse(m[0]) } catch { /* fall through */ } }
    return {}
  }
}

export async function resolveEpithets(
  input: EpithetResolverInput,
): Promise<EpithetMapping[]> {
  const epithets = (input.epithets || []).map((e) => e.trim()).filter(Boolean)
  if (epithets.length === 0 || (input.roster || []).length === 0) return []
  if (process.env.KINSHIP_EPITHET_RESOLVER === 'off') return []

  const rosterLines = input.roster
    .map((r) => `- id:${r.id} | ${r.name}${r.role ? ` (${r.role})` : ''}${r.aliases?.length ? ` [aka ${r.aliases.join(', ')}]` : ''}`)
    .join('\n')
  const system = `You resolve ambiguous person-references to a known character, using ONLY the scene text and roster. A reference like "the golden child" is a figurative epithet for an existing person. For each epithet, return the roster id it refers to, or null if it clearly refers to no one on the roster (a new/background person). Do NOT guess — null is correct when unsure. Respond ONLY JSON: { "mappings": [ { "epithet": "string", "id": "roster id or null", "confidence": 0.0-1.0 } ] }.

ROSTER:
${rosterLines}`

  let raw: string
  try {
    raw = await callLLM({
      model: AI_MODELS.metadata,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `SCENE:\n${(input.sceneText || '').slice(0, 2000)}\n\nEPITHETS TO RESOLVE: ${epithets.join(' | ')}` },
      ],
      temperature: 0,
      maxTokens: 300,
      responseFormat: { type: 'json_object' },
    })
  } catch {
    return []
  }

  const parsed = safeParse(raw)
  const list = Array.isArray(parsed?.mappings) ? parsed.mappings : []
  const validIds = new Set(input.roster.map((r) => r.id))
  const out: EpithetMapping[] = []
  for (const m of list) {
    const epithet = typeof m?.epithet === 'string' ? m.epithet.trim() : ''
    if (!epithet) continue
    const id = typeof m?.id === 'string' && validIds.has(m.id) ? m.id : null
    const confidence = Number.isFinite(Number(m?.confidence)) ? Math.max(0, Math.min(1, Number(m.confidence))) : 0.5
    out.push({ epithet, resolvedId: id, confidence })
  }
  return out
}
