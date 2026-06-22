/**
 * Premise kinship extractor (one-time, LLM) — Step 0 / the `system_seed` producer.
 *
 * Runs ONCE per instance at setup (creation for sentient, onboarding for GM), fully
 * off any turn's TTFT path, so we can spend an LLM call for accuracy. It reads the
 * authored premise + the protagonist's persona and returns the family/relationship
 * ties the lore ESTABLISHES up front, as `system_seed` RelationAssertions — the
 * highest-authority floor every later turn builds on.
 *
 * The anchor rule: in the premise "you/your" is the PROTAGONIST (the player's own
 * character in GM, the authored AI character in sentient), so it is emitted as the
 * endpoint "player" — which the graph resolves to the protagonist entity. This is
 * exactly why the per-turn deterministic extractor can't do this job: it drops
 * "your" as unanchored; here "your" is unambiguous.
 *
 * Fail-safe: any error / disabled / empty premise → returns []. No edges, no harm.
 */
import { callLLM, AI_MODELS } from '../../src/ai'
import { RELATION_KINDS, RELATION_MODIFIERS, isRelationKind, surfaceToKind, isFigurativeKinship } from '../../src/utils/kinship-ontology'
import type { RelationAssertion } from '../../src/services/character-codex.service'

export interface PremiseKinshipInput {
  premise: string
  persona?: string | null
  protagonistName: string
}

function safeParse(raw: string): any {
  try { return JSON.parse(raw) } catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) { try { return JSON.parse(m[0]) } catch { /* ignore */ } }
    return {}
  }
}

export async function extractPremiseKinship(
  input: PremiseKinshipInput,
): Promise<RelationAssertion[]> {
  const premise = (input.premise || '').trim()
  const persona = (input.persona || '').trim()
  if (!premise && !persona) return []
  if (process.env.PREMISE_KINSHIP_SEED === 'off') return []

  const name = (input.protagonistName || 'the protagonist').trim()
  const system = `You extract the family/relationship ties an RPG premise ESTABLISHES up front, for the protagonist "${name}".

RULES:
- "you" / "your" in the premise refers to the protagonist — emit it as the endpoint "player".
- Only ties the premise STATES or clearly implies as already-true at the start. Never invent, never guess, never include a tie that merely COULD form during play.
- NEVER a figurative tie ("like a father to the village", "a brother in arms").
- "kind" MUST be one of: ${RELATION_KINDS.join(', ')} — read as "from is to's <kind>".
- "modifier" (optional) is one of: ${RELATION_MODIFIERS.join(', ')} — use step/half/adoptive/foster/in_law when the premise says so; omit for an ordinary blood/married tie.
- "label" is the world-native word ("father", "twin sister", "sire", "consort").
- "gender": m|f|n implied by the label, when clear.
Respond ONLY JSON: { "ties": [ { "from": "...", "to": "...", "kind": "...", "modifier": "...", "label": "...", "gender": "m|f|n" } ] }. Empty list when the premise establishes no concrete tie.`

  let raw: string
  try {
    raw = await callLLM({
      model: AI_MODELS.metadata,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `PREMISE:\n${premise.slice(0, 2500)}${persona ? `\n\nPROTAGONIST PERSONA:\n${persona.slice(0, 1500)}` : ''}` },
      ],
      temperature: 0,
      maxTokens: 500,
      responseFormat: { type: 'json_object' },
    })
  } catch {
    return []
  }

  const parsed = safeParse(raw)
  const ties = Array.isArray(parsed?.ties) ? parsed.ties : []
  const out: RelationAssertion[] = []
  for (const t of ties) {
    const from = typeof t?.from === 'string' ? t.from.trim() : ''
    const to = typeof t?.to === 'string' ? t.to.trim() : ''
    let kind = typeof t?.kind === 'string' ? t.kind.trim() : ''
    const label = typeof t?.label === 'string' ? t.label.trim() : undefined
    if (!from || !to || from.toLowerCase() === to.toLowerCase()) continue
    if (label && isFigurativeKinship(label)) continue
    // Trust the label's structural reading over a mis-assigned kind, and recover the
    // modifier from the label ("stepfather" → step) even if the model omitted it.
    const mapped = label ? surfaceToKind(label) : null
    if (mapped && isRelationKind(mapped.kind)) kind = mapped.kind
    if (!isRelationKind(kind)) continue
    const modifier = (typeof t?.modifier === 'string' && (RELATION_MODIFIERS as string[]).includes(t.modifier))
      ? t.modifier
      : mapped?.modifier
    const gender = t?.gender === 'm' || t?.gender === 'f' || t?.gender === 'n' ? t.gender : mapped?.gender
    out.push({ from, to, kind, label, gender, modifier, polarity: 'assert', source: 'system_seed' })
  }
  return out
}
