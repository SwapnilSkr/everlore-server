import { callLLM, AI_MODELS } from '../../src/ai'
import { normalizeEntityName } from '../../src/services/entity-graph.service'
import { classifyPresenceCodexGaps, isActionableMention, type MentionCandidate } from './presence-gap-detector'

export type EntityVerdict = 'person' | 'not_person' | 'uncertain'

export type EntityAdjudication = {
  key: string
  display: string
  verdict: EntityVerdict
  confidence: number
  evidenceType: string
}

export type EntityAdjudicationResult = {
  /** False only when the judge failed. Callers then retain their existing deterministic path. */
  available: boolean
  decisions: EntityAdjudication[]
}

function compact(value: string, max: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function snippetsFor(candidate: string, prose: string): string[] {
  const sentences = String(prose || '')
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => compact(sentence, 360))
    .filter(Boolean)
  const re = new RegExp(`\\b${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
  return sentences.filter((sentence) => re.test(sentence)).slice(0, 2)
}

/**
 * Candidate detection is deliberately non-canonical. Only terms that already
 * have a strong deterministic person signal are sent to the semantic judge;
 * all other prose remains exactly on the existing fallback path.
 */
export function entityAdjudicationCandidates(params: {
  prose: string
  knownNames: string[]
  exclude?: string[]
  limit?: number
}): MentionCandidate[] {
  return classifyPresenceCodexGaps(params.prose, {
    codex: params.knownNames,
    exclude: params.exclude || [],
  })
    .filter(isActionableMention)
    .slice(0, params.limit ?? 4)
}

/**
 * Semantic backstop for unfamiliar, person-like prose terms. It is never asked
 * to invent an identity, only to classify the supplied candidate/evidence.
 */
export async function adjudicateEntityCandidates(params: {
  prose: string
  candidates: MentionCandidate[]
  knownCast: string[]
  knownPlaces: string[]
  worldContext?: string
}): Promise<EntityAdjudicationResult> {
  if (params.candidates.length === 0) return { available: true, decisions: [] }

  const payload = params.candidates.map((candidate) => ({
    key: candidate.key,
    display: candidate.display,
    deterministic_evidence: candidate.evidence,
    snippets: snippetsFor(candidate.display, params.prose),
  }))
  const prompt = `Classify unfamiliar story terms. You are an identity safety judge, not a creative writer.

A literal PERSON is a distinct individual physically participating in this beat. NOT_PERSON includes atmosphere, abstract ideas, personification, objects, places, metaphors, crowds, and unnamed descriptions. If evidence is insufficient, return UNCERTAIN. Never infer a person merely because a capitalized word has a human verb: “Silence answers”, “Valour waits”, and “Fear speaks” are literary personification unless the text explicitly establishes an individual.

Return only JSON:
{"decisions":[{"key":"candidate key","verdict":"person|not_person|uncertain","confidence":0.0,"evidence_type":"short exact category"}]}

KNOWN CAST: ${params.knownCast.slice(0, 16).join(', ') || '(none)'}
KNOWN PLACES: ${params.knownPlaces.slice(0, 30).join(', ') || '(none)'}
WORLD CONTEXT: ${compact(params.worldContext || '', 900) || '(none)'}
CANDIDATES: ${JSON.stringify(payload)}`

  try {
    const raw = await callLLM({
      model: AI_MODELS.metadata,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      maxTokens: 300,
      responseFormat: { type: 'json_object' },
    })
    const parsed = JSON.parse(raw) as { decisions?: unknown }
    const allowed = new Map(params.candidates.map((candidate) => [normalizeEntityName(candidate.key), candidate]))
    const decisions: EntityAdjudication[] = []
    for (const item of Array.isArray(parsed.decisions) ? parsed.decisions : []) {
      const key = normalizeEntityName(String((item as any)?.key || ''))
      const candidate = allowed.get(key)
      const verdict = (item as any)?.verdict
      if (!candidate || !['person', 'not_person', 'uncertain'].includes(verdict)) continue
      decisions.push({
        key,
        display: candidate.display,
        verdict,
        confidence: Math.max(0, Math.min(1, Number((item as any)?.confidence) || 0)),
        evidenceType: compact(String((item as any)?.evidence_type || ''), 80),
      })
    }
    // A partial/malformed judge response must not silently suppress a genuine
    // introduction. Treat it as unavailable and retain the existing deterministic
    // path for this turn; explicit negative verdicts are the only new blocker.
    if (decisions.length !== allowed.size) return { available: false, decisions: [] }
    return { available: true, decisions }
  } catch {
    // Availability must never make a valid story turn disappear. Callers retain
    // their prior deterministic decision when this optional judge is unavailable.
    return { available: false, decisions: [] }
  }
}

/** The promotion gate shared by live and replay projection paths. */
export function adjudicatedPersonKeys(
  candidates: MentionCandidate[],
  result: EntityAdjudicationResult,
): Set<string> {
  if (!result.available) return new Set(candidates.map((candidate) => normalizeEntityName(candidate.key)))
  const verdicts = new Map(result.decisions.map((decision) => [decision.key, decision.verdict]))
  return new Set(
    candidates
      .filter((candidate) => verdicts.get(normalizeEntityName(candidate.key)) === 'person')
      .map((candidate) => normalizeEntityName(candidate.key)),
  )
}

/** Remove only candidates the semantic judge explicitly rejected; unknown names
 * outside the candidate set retain the existing metadata behavior. */
export function filterAdjudicatedPresence(
  names: string[],
  candidates: MentionCandidate[],
  result: EntityAdjudicationResult,
): string[] {
  if (!result.available) return names
  const verdicts = new Map(result.decisions.map((decision) => [decision.key, decision.verdict]))
  const candidateKeys = new Set(candidates.map((candidate) => normalizeEntityName(candidate.key)))
  return names.filter((name) => {
    const key = normalizeEntityName(name)
    return !candidateKeys.has(key) || verdicts.get(key) === 'person'
  })
}
