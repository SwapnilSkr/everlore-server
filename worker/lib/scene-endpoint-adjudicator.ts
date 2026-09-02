import { callLLM, AI_MODELS } from '../../src/ai'
import { normalizeEntityName } from '../../src/services/entity-graph.service'
import { hasSceneParticipationGrammar, PERSON_POSSESSION_TOKENS } from './presence-gap-detector'
import type { CitationCheck, ExtractorCitationVerdict } from '../../src/models/extractor-raw.model'

/**
 * A deliberately independent, post-stream check of the player-facing endpoint
 * of a narration. The normal scene witness extracts broad state (choices,
 * movement, departures, etc.). This judge has one narrow job: distinguish who
 * is physically with the PLAYER at the END from people who appeared earlier,
 * in a cutaway, or only in dialogue/memory. It cannot create prose, a graph
 * location, or a character; callers may only use evidence-backed candidates.
 */
export type EndpointPresence = { name: string; evidence: string }
/** Where the PLAYER physically is at the final moment, with its citation. */
export type EndpointLocation = { name: string; evidence: string }

export type CitationVerdict = ExtractorCitationVerdict

export type SceneEndpointAdjudication = {
  available: boolean
  /** The final narrated camera is with the player, not an NPC cutaway. */
  playerViewpointAtEnd: boolean
  /** A physical transition or time-cut moved the player's scene. */
  sceneTransition: boolean
  present: EndpointPresence[]
  /**
   * The judge's own reading of WHERE the player ends up — an independent second
   * namer for the location cursor. The scene witness anchors: told to return the
   * prior location unless the viewpoint moved, it kept reporting a bar while the
   * prose had the player standing on a canal bridge, and the cursor cannot follow
   * a place nobody names. Raw and unverified here; the caller runs the same
   * (a)(b)(c) citation stack over it.
   */
  location: EndpointLocation | null
  /** Advisory (b)/(c) plus enforcing (a), per cited candidate. Never gates. */
  citationVerdicts: CitationVerdict[]
}

function compact(value: unknown, max: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Keep the check literal: evidence must be a real contiguous excerpt, after
 * harmless markdown/whitespace/quote normalization, rather than paraphrase.
 * Regex here only *normalizes* — it does not decide who was in the room. */
export function comparable(value: string): string {
  return String(value || '')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\\*_`~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .trim()
    .toLocaleLowerCase()
}

export function hasExactEvidence(evidence: string, prose: string): boolean {
  const hay = comparable(prose)
  const raw = comparable(evidence)
  if (raw.length < 3 || raw.length > 240) return false
  if (hay.includes(raw)) return true
  // One extra wrap of quotes the model included around an otherwise verbatim span.
  const unwrapped = raw.replace(/^['"]+|['"]+$/g, '').trim()
  if (unwrapped.length >= 3 && unwrapped !== raw && hay.includes(unwrapped)) return true
  // The judge often ends a 3–24 word span with a period while the prose
  // continues with a comma. That is punctuation, not fabrication.
  const withoutEndPunct = raw.replace(/[.,;:!?]+$/g, '').trim()
  return withoutEndPunct.length >= 3 && withoutEndPunct !== raw && hay.includes(withoutEndPunct)
}

export const DETERMINER = new Set(['a', 'an', 'the', 'my', 'his', 'her', 'their', 'our', 'its'])

export function excerptNamesPerson(name: string, evidence: string): boolean {
  const hay = comparable(evidence)
  if (!hay) return false
  const n = comparable(name)
  if (n.length >= 2 && new RegExp(`\\b${escapeRe(n)}\\b`).test(hay)) return true
  const parts = n.split(/\s+/).filter((p) => p.length >= 3 && !DETERMINER.has(p))
  return parts.some((p) => new RegExp(`\\b${escapeRe(p)}\\b`).test(hay))
}

/**
 * Closed-class English function words that may sit between a subject NP and
 * its predicate head. Skipping them is *normalization of clause shape*, not a
 * decision about which actions count as presence.
 */
const CLAUSE_SKIP = new Set([
  'has', 'had', 'have', "hasn't", "hadn't", "haven't",
  'is', "isn't", 'was', "wasn't", 'are', "aren't", 'were', "weren't",
  'does', "doesn't", 'did', "didn't", 'do', "don't",
  'will', "won't", 'would', "wouldn't", 'can', 'cannot', "can't", 'could', "couldn't",
  'may', 'might', 'must', 'shall', 'should',
  'not', 'never', 'already', 'also', 'only', 'even', 'just', 'still', 'then',
  'finally', 'almost', 'barely', 'slowly', 'quietly', 'always', 'now',
  'here', 'there',
])

const LOCATIVE_COPULA = new Set([
  'inside', 'outside', 'here', 'there', 'back', 'away', 'gone', 'out',
  'behind', 'beside', 'near', 'nearby', 'ahead', 'around',
  'upstairs', 'downstairs', 'below', 'above', 'under', 'over',
])

/**
 * Citation-scoped (c): the excerpt starts with the claimed name (optional
 * one-token title) and then a predicate head. This verifies the *shape* of
 * the model's evidence. It does not consult ACTION_VERBS.
 *
 * Rejects the phantom-presence paths: `, who` relatives, `, my/the` appositives,
 * and `'s` possessives that are not locative copulas (`Soren's inside`).
 */
export function excerptShowsSubjectPredicate(name: string, evidence: string): boolean {
  const ev = comparable(evidence)
  const n = comparable(name)
  if (!ev || !n) return false
  const nameRe = escapeRe(n)
  const start = ev.match(new RegExp(`^(?:[a-z]+\\s+)?${nameRe}\\b`))
  if (!start) return false
  let rest = ev.slice(start[0].length).trim()

  const poss = rest.match(/^'s\b(.*)$/)
  if (poss) {
    const words = poss[1]
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/^[^a-z']+|[^a-z']+$/g, ''))
      .filter(Boolean)
    const first = words[0] || ''
    const second = words[1] || ''
    if (LOCATIVE_COPULA.has(first)) return true
    if (PERSON_POSSESSION_TOKENS.has(first)) return true
    // One modifier: "Tomas's weary gaze". Not "Bram's down there" (down is
    // not a body-part; distal locatives are not presence at the endpoint).
    return PERSON_POSSESSION_TOKENS.has(second)
  }

  if (/^,?\s*who\b/.test(rest) || /^,?\s*(?:my|his|her|their|our|its|the|a|an)\b/.test(rest)) {
    return false
  }

  rest = rest.replace(/^,+/, '').trim()
  const tokens = rest.split(/\s+/).filter(Boolean)
  while (tokens.length) {
    const raw = tokens[0].replace(/^[^a-z']+|[^a-z']+$/g, '')
    if (!raw || CLAUSE_SKIP.has(raw)) {
      tokens.shift()
      continue
    }
    break
  }
  if (!tokens.length) return false
  const head = tokens[0].replace(/^[^a-z']+|[^a-z']+$/g, '')
  if (!head) return false
  if (CLAUSE_SKIP.has(head) || DETERMINER.has(head)) return false
  if (head === 'who' || head === 'whom' || head === 'whose' || head === 'which') return false
  return true
}

/**
 * Does ANY sentence of a passage show this person as its subject with a
 * predicate? The citation-scoped (c) test, applied per sentence.
 *
 * This is what whole-passage corroboration should have been asking. The verb
 * list it replaces scans the entire passage for `name` adjacent to a listed
 * verb, which admits the phantom-presence sentences the identity patterns were
 * built from — "The letter mentioned Captain Rhea, who had died at sea" is
 * corroboration under the list and refused here, because Rhea is not the
 * subject of anything. It is also blind to adverbs, auxiliaries and participles
 * the list cannot reach ("Tomas hasn't moved", "Mara almost nodded").
 */
export function showsParticipationInPassage(name: string, prose: string): boolean {
  const text = String(prose || '')
  if (!text.trim() || !String(name || '').trim()) return false
  // Sentence and clause boundaries only — punctuation, never vocabulary.
  for (const sentence of text.split(/(?<=[.!?…])\s+|\n+|["“”]/)) {
    const trimmed = sentence.trim()
    if (!trimmed) continue
    if (excerptShowsSubjectPredicate(name, trimmed)) return true
  }
  return false
}

/**
 * Citation stack for an endpoint presence claim.
 *   (a) excerpt appears verbatim in the prose — fabrication check, still the gate
 *   (b) excerpt contains a surface of the claimed name — about this person
 *   (c) excerpt is a name-first subject-predicate span, or the existing action
 *       grammar (body-part possessive / adjacent verb) — acting, not referenced
 *
 * (a)(b)(c) all gate `present[]`. Carry-forward of people already in the room
 * does not use this array; new admits do. Identity patterns stay out of (c).
 */
export function citationAdmitsToPresent(verdict: CitationVerdict): boolean {
  return verdict.a && verdict.b && verdict.c
}

/**
 * Scene-break: endpoint cast (or witness fallback) plus party.
 * Continuation: prior cast (quiet people stay) plus endpoint-verified arrivals
 * plus party. Witness `present_characters` is not a new-admit path when the
 * judge ran — that is Phase 1. Outage falls back to the old witness merge.
 */
export function mergePresenceCandidates(params: {
  sceneBroke: boolean
  endpointAvailable: boolean
  endpointPresent: string[]
  priorPresent: string[]
  witnessPresent: string[]
  partyNames: string[]
}): string[] {
  const party = params.partyNames
  if (params.sceneBroke) {
    return [...(params.endpointAvailable ? params.endpointPresent : params.witnessPresent), ...party]
  }
  if (params.endpointAvailable) {
    return [...params.priorPresent, ...params.endpointPresent, ...party]
  }
  return [...params.priorPresent, ...params.witnessPresent, ...party]
}

export function evaluatePresenceCitation(params: {
  name: string
  evidence: string
  prose: string
}): CitationVerdict {
  const a = hasExactEvidence(params.evidence, params.prose)
  const b = excerptNamesPerson(params.name, params.evidence)
  const structural = b && excerptShowsSubjectPredicate(params.name, params.evidence)
  const listedAction = b && hasSceneParticipationGrammar(params.name, params.evidence, { evidence: 'action' })
  const c = structural || listedAction
  const rejected: CitationCheck[] = []
  if (!a) rejected.push('a')
  if (!b) rejected.push('b')
  if (!c) rejected.push('c')
  return {
    name: params.name,
    evidence: params.evidence,
    a,
    b,
    c,
    rejected,
  }
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
  /** Model override for the corpus tier experiment. Production omits it. */
  model?: string
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
    location: null,
    citationVerdicts: [],
  }
  if (!String(params.prose || '').trim()) return fallback

  const prompt = `You are a strict end-of-scene continuity verifier for an RPG. Inspect the completed prose and decide ONLY what is true at its FINAL MOMENT from the PLAYER'S viewpoint.

Return only JSON exactly in this shape:
{"player_viewpoint_at_end":true,"scene_transition":false,"location_at_end":{"name":"place name","evidence":"exact 3-24 word excerpt from prose"},"present_at_end":[{"name":"exact supplied candidate","evidence":"exact 3-24 word excerpt from prose"}]}

Rules:
- player_viewpoint_at_end is false if the prose ENDS in an NPC-only cutaway or you cannot tell where the player's camera ends.
- scene_transition is true whenever the player physically moved, arrived somewhere, or the player-facing scene clearly time-cut. Walking from one room to another, climbing stairs into a different space, entering or leaving a building all count, even when the player ends up somewhere they have been before. It is false only when the player stayed put — an NPC moving, or a mere plan to go somewhere, is not a transition.
- present_at_end contains ONLY people physically co-located with the PLAYER at that final moment. Never include the player themself.
- A person shown earlier, left behind, mentioned, remembered, speaking in a letter, or appearing in a cutaway is NOT present at the endpoint.
- Every item needs a SHORT VERBATIM excerpt from the completed prose proving that this person is there at the endpoint. If no such excerpt exists, omit them. Never paraphrase evidence.
- The excerpt MUST contain that person's name as a word and SHOULD start with it (a single title word before it is allowed: "Queen Isolde barely glances"). Quote a main clause.
- A pronoun sentence ("he said", "He stays perfectly still") does not prove anyone. Do not attach it to a different candidate. Omit them rather than guess.
- Do not quote a relative ("Cedric, who stood") or a memory of someone elsewhere ("Bram's numbers").
- You may use ONLY the supplied candidates. If no candidate is proven, return []. Never cite "I"/"he"/"she" as a name.
- location_at_end is the PHYSICAL PLACE the player is standing in at that final moment, named as the prose names it ("the canal bridge", "root cellars", "Marrow Ford"). Read it from THIS passage ONLY. You are not told where the scene started, and you must not infer it: name the place whose own words appear in the prose around the player at the end. Its evidence must be a VERBATIM excerpt that contains the place's own name and shows the player being AT it — a locative statement ("we stop on the canal bridge", "back in the root cellars, the air is cold", "The hall is quiet"). Do not cite a place that is only mentioned, remembered or planned ("the low road to Marrow Ford"), and do not cite where somebody ELSE is ("Bram's down in the cellars"). It must be a SPACE the player is inside or standing in and could walk out of — a room, a building, a street, an outdoor area, a settlement, the inside of a vehicle. It is NEVER a piece of furniture, an object, a body part, or a feature within the room: a bench, a hearth, a table, a window, a door, a bed are things in a place, not the place. If the passage does not physically establish where the player is, return null.

PLAYER ACTION (context only; do not treat it as proof that an NPC is present):
${compact(params.playerInput || '', 1400) || '(none)'}

SUPPLIED CANDIDATES:
${JSON.stringify(candidates)}

COMPLETED PROSE:
${compact(params.prose, 18000)}`

  try {
    const raw = await callLLM({
      model: params.model || AI_MODELS.metadata,
      purpose: 'scene_endpoint',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      maxTokens: 280,
      responseFormat: { type: 'json_object' },
    })
    params.onRaw?.(raw)
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed.player_viewpoint_at_end !== 'boolean' || typeof parsed.scene_transition !== 'boolean') return fallback

    const locationRow = parsed.location_at_end as Record<string, unknown> | null | undefined
    const locationName = compact(locationRow?.name, 72)
    const locationEvidence = compact(locationRow?.evidence, 240)
    const location: EndpointLocation | null =
      locationName && locationEvidence ? { name: locationName, evidence: locationEvidence } : null

    const allowed = new Map(candidates.map((name) => [normalizeEntityName(name), name]))
    const present: EndpointPresence[] = []
    const citationVerdicts: CitationVerdict[] = []
    const seen = new Set<string>()
    for (const row of Array.isArray(parsed.present_at_end) ? parsed.present_at_end : []) {
      const name = compact((row as any)?.name, 100)
      const evidence = compact((row as any)?.evidence, 240)
      const key = normalizeEntityName(name)
      const canonical = allowed.get(key)
      if (!canonical || seen.has(key)) continue
      const verdict = evaluatePresenceCitation({ name: canonical, evidence, prose: params.prose })
      citationVerdicts.push(verdict)
      // Phase 1: admit only a verified, name-first, acting citation.
      // Carry-forward of the prior cast does not go through this array.
      if (!citationAdmitsToPresent(verdict)) continue
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
      // A cutaway does not say where the PLAYER is either.
      location: parsed.player_viewpoint_at_end ? location : null,
      citationVerdicts,
    }
  } catch {
    return fallback
  }
}

