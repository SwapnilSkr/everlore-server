import { callLLM, AI_MODELS } from '../../src/ai'
import { normalizeEntityName } from '../../src/services/entity-graph.service'

/**
 * A deliberately independent, post-stream check of the player-facing endpoint
 * of a narration. The normal scene witness extracts broad state (choices,
 * movement, departures, etc.). This judge has one narrow job: distinguish who
 * is physically with the PLAYER at the END from people who appeared earlier,
 * in a cutaway, or only in dialogue/memory. It cannot create prose, a graph
 * location, or a character; callers may only use evidence-backed candidates.
 */
export type EndpointPresence = { name: string; evidence: string }

export type SceneEndpointAdjudication = {
  available: boolean
  /** The final narrated camera is with the player, not an NPC cutaway. */
  playerViewpointAtEnd: boolean
  /** A physical transition or time-cut moved the player's scene. */
  sceneTransition: boolean
  present: EndpointPresence[]
}

function compact(value: unknown, max: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Keep the check literal: evidence must be a real contiguous excerpt, after
 * harmless markdown/whitespace normalization, rather than model paraphrase. */
function comparable(value: string): string {
  return String(value || '')
    .replace(/[\\*_`~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase()
}

function hasExactEvidence(evidence: string, prose: string): boolean {
  const excerpt = comparable(evidence)
  return excerpt.length >= 3 && excerpt.length <= 240 && comparable(prose).includes(excerpt)
}

/**
 * Verify only supplied candidate identities. Candidates are assembled from the
 * previous cast, current metadata, known cards, and already-gated walk-on
 * candidates; this prevents a second model from inventing a new person.
 */
export async function adjudicateSceneEndpoint(params: {
  prose: string
  playerInput?: string | null
  candidates: string[]
  onRaw?: (raw: string) => void
}): Promise<SceneEndpointAdjudication> {
  const candidates = [...new Map(
    params.candidates
      .map((name) => compact(name, 100))
      .filter(Boolean)
      .map((name) => [normalizeEntityName(name), name]),
  ).values()].slice(0, 40)

  const fallback: SceneEndpointAdjudication = {
    available: false,
    playerViewpointAtEnd: false,
    sceneTransition: false,
    present: [],
  }
  if (!String(params.prose || '').trim()) return fallback

  const prompt = `You are a strict end-of-scene continuity verifier for an RPG. Inspect the completed prose and decide ONLY what is true at its FINAL MOMENT from the PLAYER'S viewpoint.

Return only JSON exactly in this shape:
{"player_viewpoint_at_end":true,"scene_transition":false,"present_at_end":[{"name":"exact supplied candidate","evidence":"exact 3-24 word excerpt from prose"}]}

Rules:
- player_viewpoint_at_end is false if the prose ENDS in an NPC-only cutaway or you cannot tell where the player's camera ends.
- scene_transition is true only if the player physically moved, arrived somewhere, or the player-facing scene clearly time-cut. It is not true for an NPC moving or a mere plan.
- present_at_end contains ONLY people physically co-located with the PLAYER at that final moment. Never include the player themself.
- A person shown earlier, left behind, mentioned, remembered, speaking in a letter, or appearing in a cutaway is NOT present at the endpoint.
- Every item needs a SHORT VERBATIM excerpt from the completed prose proving that this person is there at the endpoint. If no such excerpt exists, omit them. Never paraphrase evidence.
- You may use ONLY the supplied candidates. If no candidate is proven, return [].

PLAYER ACTION (context only; do not treat it as proof that an NPC is present):
${compact(params.playerInput || '', 1400) || '(none)'}

SUPPLIED CANDIDATES:
${JSON.stringify(candidates)}

COMPLETED PROSE:
${compact(params.prose, 18000)}`

  try {
    const raw = await callLLM({
      model: AI_MODELS.metadata,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      maxTokens: 280,
      responseFormat: { type: 'json_object' },
    })
    params.onRaw?.(raw)
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed.player_viewpoint_at_end !== 'boolean' || typeof parsed.scene_transition !== 'boolean') return fallback

    const allowed = new Map(candidates.map((name) => [normalizeEntityName(name), name]))
    const present: EndpointPresence[] = []
    const seen = new Set<string>()
    for (const row of Array.isArray(parsed.present_at_end) ? parsed.present_at_end : []) {
      const name = compact((row as any)?.name, 100)
      const evidence = compact((row as any)?.evidence, 240)
      const key = normalizeEntityName(name)
      const canonical = allowed.get(key)
      if (!canonical || seen.has(key) || !hasExactEvidence(evidence, params.prose)) continue
      seen.add(key)
      present.push({ name: canonical, evidence })
      if (present.length >= 12) break
    }
    return {
      available: true,
      playerViewpointAtEnd: parsed.player_viewpoint_at_end,
      sceneTransition: parsed.scene_transition,
      // A cutaway is never the player's current cast, even if it contains
      // valid names and evidence.
      present: parsed.player_viewpoint_at_end ? present : [],
    }
  } catch {
    return fallback
  }
}

