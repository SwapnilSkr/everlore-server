import { callLLM, AI_MODELS } from '../../src/ai'
import { isEphemeralPersonDescriptor, isNonPersonRole, type CharacterCodexDelta } from '../../src/services/character-codex.service'
import type { CharacterIdentityKind } from '../../src/models/character-profile.model'
import { classifyPresenceCodexGaps, isActionableMention } from './presence-gap-detector'
import { isAbstractNonPersonTerm } from '../../src/utils/person-identity'
import {
  relationshipEvidenceBindsToCharacter,
  relationshipInitializationFromEvidence,
  relationshipStateFromEvidence,
} from '../../src/utils/relationship-baseline'

type ExistingCharacter = {
  canonical_name: string
  identity_kind?: CharacterIdentityKind
  aliases?: string[]
  role?: string
  appearance?: string
  persona?: string
  disposition_to_player?: string
  /** Server-owned cumulative relationship state. It informs the extractor's
   * proposed small delta; the extractor never sets an absolute meter value. */
  relationship?: {
    trust: number
    affection: number
    fear: number
    rivalry: number
  }
  relationship_moments?: Array<{
    meter: 'trust' | 'affection' | 'fear' | 'rivalry'
    delta: number
    sequence: number
  }>
  relationship_state?: { summary: string; evidence: string; tags?: string[] }
  relationship_facts?: Array<{ statement: string; evidence: string; tags?: string[]; sequence: number; status: 'active' | 'retired' }>
  /** Current status snapshot the extractor must reconcile (supersede stale items). */
  mutable_state?: string[]
  /** Permanent history; provided for context so new facts aren't duplicated. */
  immutable_facts?: string[]
}

/** Lowercase, strip punctuation to spaces, collapse runs — for grounding checks. */
function normForMatch(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** True when `name` (a proper name/epithet) literally appears in the turn text.
 *  Phrase match on the normalized strings, so "mysterious man" (coined from mood)
 *  fails even though the bare word "man" is present. */
function nameAppearsInText(name: string, normText: string): boolean {
  const n = normForMatch(name)
  if (!n || n.length < 2) return false
  return normText.includes(` ${n} `) || normText.startsWith(`${n} `) || normText.endsWith(` ${n}`) || normText === n
}

/**
 * A quoted self-introduction is unusually strong evidence that a named person
 * has physically entered this beat. It is deliberately narrower than a simple
 * name mention: off-screen relatives, remembered people, locations, and mood
 * labels cannot satisfy it. This is the safe escape hatch when the metadata
 * pass has not yet placed a just-introduced character in `presentCast`.
 */
export function isDirectSelfIntroduction(
  name: string,
  prose: string,
  playerInput = '',
): boolean {
  const candidate = String(name || '').trim()
  if (!candidate || candidate.length < 3) return false
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const explicit = new RegExp(
    `(?:^|["“][^"”]{0,220}|[.!?]\\s*)(?:I\\s+am|I['’]m|my\\s+name\\s+is|you\\s+may\\s+call\\s+me)\\s+${escaped}(?=\\b|[,.;!?”])`,
    'i',
  ).test(String(prose || ''))
  if (explicit) return true
  // A compact dialogue tag can be a genuine self-identification even when the
  // narrator uses the conventional “\"Enzo,\" he says” rather than “I am Enzo.”
  // Accept it only as the direct answer to the player's identity question; without
  // that turn-level context it could merely be someone calling another person.
  const asksIdentity = /\b(?:who\s+(?:are|might)\s+you|what(?:'s|\s+is)\s+your\s+name|what\s+should\s+i\s+call\s+you|may\s+i\s+ask\s+your\s+name)\b/i
    .test(String(playerInput || ''))
  if (!asksIdentity) return false
  return new RegExp(
    `["“]\\s*${escaped}\\s*[,!.]?["”]?\\s*,?\\s*(?:\\*[^*]{0,180}\\*\\s*)?(?:he|she|they)\\s+(?:said|says|replied|replies|answered|answers)\\b`,
    'i',
  ).test(String(prose || ''))
}

const RELATIVE_WORDS = [
  'sister', 'brother', 'mother', 'father', 'mom', 'dad', 'parent', 'daughter',
  'son', 'wife', 'husband', 'spouse', 'partner', 'twin', 'cousin', 'aunt',
  'uncle', 'grandmother', 'grandfather', 'grandma', 'grandpa',
]

const RELATIONAL_EPITHET_KEYS = new Set(RELATIVE_WORDS.map(normForMatch))

function isRelationalEpithet(name: string | null | undefined): boolean {
  const normalized = normForMatch(String(name || '')).replace(/^(?:the|my|his|her|their)\s+/, '')
  return RELATIONAL_EPITHET_KEYS.has(normalized)
}

/** A literal name used in direct address ("Mara, …") or an explicit naming
 * phrase is strong enough to make the name canonical over a role label. This
 * deliberately does not promote any capitalized word: the codex extractor must
 * already have connected it as an alias of a relative/role in its structured
 * output. */
function isDirectlyNamedInProse(name: string, prose: string): boolean {
  const candidate = String(name || '').trim()
  if (!candidate || candidate.length < 2) return false
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return new RegExp(
    `(?:["“]|\\b(?:named|called)\\s+)${escaped}(?=\\s*[,!?."”]|\\b)`,
    'i',
  ).test(String(prose || ''))
}

/**
 * The extraction model is allowed to say that `Sister` and `Mara` are the same
 * person, but a player-facing card should use Mara as its canonical identity.
 * Convert that high-confidence role→proper-name association into the stable
 * correction shape understood by the event-sourced codex fold.
 */
export function promoteProperNameOverRole(
  delta: CharacterCodexDelta,
  knownByName: Map<string, string>,
  prose: string,
): CharacterCodexDelta {
  const roleLabel = delta.name
  if (!isRelationalEpithet(roleLabel)) return delta
  const properAlias = (delta.aliases || []).find(
    (alias) => !isRelationalEpithet(alias) && isDirectlyNamedInProse(alias, prose),
  )
  if (!properAlias) return delta

  const existingRoleCard = knownByName.get(normForMatch(delta.resolved_name || roleLabel))
  return {
    ...delta,
    name: properAlias.trim(),
    aliases: [roleLabel, ...(delta.aliases || [])],
    // When the role card already exists, this is a rename rather than a new
    // person. If it does not exist yet, create the named person directly.
    resolved_name: existingRoleCard || undefined,
  }
}

export function isPlayerMentionedRelative(
  delta: CharacterCodexDelta,
  playerInput: string,
  aiResponse: string,
): boolean {
  const input = normForMatch(playerInput)
  // The relative's NAME may be supplied by the narration answering the player —
  // e.g. player asks "what's my sister's name again?" and the AI says "Mira".
  // Match the name across the whole turn, but require the RELATION ("my sister")
  // to come from the player's own framing so we only block the player's relatives.
  const turn = normForMatch(`${playerInput || ''} ${aiResponse || ''}`)
  const names = [delta.name, delta.resolved_name || '', ...(delta.aliases || [])]
    .map(normForMatch)
    .filter(Boolean)
  if (!input || names.length === 0) return false
  const role = normForMatch(delta.role || '')
  const relationInRole = RELATIVE_WORDS.some((r) => role.includes(r))
  const possessiveRelation = RELATIVE_WORDS.some((r) =>
    input.includes(` my ${r} `) ||
    input.endsWith(` my ${r}`) ||
    input.includes(` player s ${r} `) ||
    input.includes(` player ${r} `),
  )
  if (!relationInRole && !possessiveRelation) return false
  return names.some((n) => turn.includes(` ${n} `) || turn.endsWith(` ${n}`) || turn.startsWith(`${n} `))
}

/** Bare common-noun person labels — a role or descriptor with no proper name
 *  ("the merchant", "a guard", "the stranger", "an old man"). These are the
 *  character analog of vague location labels: a one-off passer-by named only by
 *  function is NOT a Bonds card. If they matter later they'll be named or already
 *  on the roster (resolvesToKnown lets those through). Matched as the WHOLE
 *  article-stripped label, so a PROPER name ("Merchant Voss") or a qualified
 *  descriptor stays specific and is NOT blocked. */
const GENERIC_PERSON_DESCRIPTORS = new Set<string>([
  'man', 'woman', 'boy', 'girl', 'child', 'kid', 'person', 'figure', 'stranger',
  'old man', 'old woman', 'young man', 'young woman', 'lady', 'gentleman', 'guy',
  'merchant', 'trader', 'vendor', 'shopkeeper', 'shopkeep', 'clerk', 'seller',
  'guard', 'soldier', 'sentry', 'watchman', 'guardsman', 'knight', 'officer',
  'innkeeper', 'barkeep', 'bartender', 'waiter', 'waitress', 'servant', 'maid',
  'driver', 'pilot', 'sailor', 'beggar', 'priest', 'monk', 'nun', 'farmer',
  'hunter', 'fisherman', 'worker', 'passerby', 'passer by', 'bystander',
  'crowd', 'people', 'men', 'women', 'guards', 'soldiers', 'villagers', 'citizens',
])

/** True when a card name is just a bare role/descriptor common noun (article
 *  stripped), so it should not mint a standalone card. */
export function isBareDescriptorName(name: string | null | undefined): boolean {
  const n = normForMatch(String(name || '')).replace(/^(?:the|a|an|some)\s+/, '')
  return GENERIC_PERSON_DESCRIPTORS.has(n)
}

/** A named figure repeatedly established by the story can earn a codex card
 * before appearing on-screen. This replaces the old all-or-nothing presence
 * requirement without allowing a one-off mention to mint a character. */
export function isEligibleOffscreenPromotion(
  candidateNames: string[],
  promotableNames: string[],
): boolean {
  const allowed = new Set(promotableNames.map(normForMatch).filter(Boolean))
  return candidateNames.map(normForMatch).some((name) => name && allowed.has(name))
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw)
  } catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return {}
    try {
      return JSON.parse(m[0])
    } catch {
      return {}
    }
  }
}

const METER_KEYS = ['trust', 'affection', 'fear', 'rivalry'] as const

function toRelationshipDeltas(raw: any): CharacterCodexDelta['relationship_deltas'] {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, number> = {}
  for (const key of METER_KEYS) {
    const v = Number((raw as Record<string, unknown>)[key])
    if (!Number.isFinite(v) || v === 0) continue
    out[key] = Math.max(-10, Math.min(10, Math.round(v)))
  }
  return Object.keys(out).length ? out : undefined
}

function toRelationshipEvidence(
  raw: any,
  deltas: CharacterCodexDelta['relationship_deltas'],
  sourceText: string,
): CharacterCodexDelta['relationship_evidence'] {
  if (!raw || typeof raw !== 'object' || !deltas) return undefined
  const source = normForMatch(sourceText)
  const out: Record<string, string> = {}
  for (const key of METER_KEYS) {
    if (typeof deltas[key] !== 'number') continue
    const evidence = typeof raw[key] === 'string' ? raw[key].trim().slice(0, 180) : ''
    const normalized = normForMatch(evidence)
    // Evidence must be a substantial literal excerpt from this turn. This
    // rejects model-supplied rationales that were never actually narrated.
    if (normalized.length >= 8 && source.includes(normalized)) out[key] = evidence
  }
  return Object.keys(out).length ? out : undefined
}

function toInteractionHints(raw: any): CharacterCodexDelta['interaction_hints'] {
  if (!Array.isArray(raw)) return undefined
  const out: NonNullable<CharacterCodexDelta['interaction_hints']> = []
  for (const hint of raw) {
    const labelTemplate = typeof hint?.label_template === 'string'
      ? hint.label_template.trim().slice(0, 140)
      : ''
    const question = typeof hint?.question === 'string'
      ? hint.question.trim().slice(0, 240)
      : ''
    const sourceState = typeof hint?.source_state === 'string'
      ? hint.source_state.trim().slice(0, 160)
      : ''
    if (!labelTemplate || !question || !sourceState) continue
    out.push({
      label_template: labelTemplate,
      question,
      source_state: sourceState,
    })
    if (out.length >= 3) break
  }
  return out
}

const RELATION_KIND_SET = new Set([
  'parent_of', 'child_of', 'sibling_of', 'partner_of', 'progenitor_of',
  'descendant_of', 'superior_of', 'subordinate_of', 'kin_of', 'bonded_of',
])

/** Parse the turn-level relation_assertions array (typed kinship ties). Keeps only
 *  well-formed entries with two endpoints and a recognized structural kind. */
function toRelationAssertions(raw: any): CharacterCodexDelta['relation_assertions'] {
  if (!Array.isArray(raw)) return undefined
  const out: NonNullable<CharacterCodexDelta['relation_assertions']> = []
  for (const r of raw) {
    const from = typeof r?.from === 'string' ? r.from.trim() : ''
    const to = typeof r?.to === 'string' ? r.to.trim() : ''
    const kind = typeof r?.kind === 'string' ? r.kind.trim().toLowerCase() : ''
    if (!from || !to || !RELATION_KIND_SET.has(kind)) continue
    if (from.toLowerCase() === to.toLowerCase()) continue // no self-relations
    out.push({
      from,
      to,
      kind,
      label: typeof r?.label === 'string' ? r.label.trim().slice(0, 60) : undefined,
      gender: ['m', 'f', 'n'].includes(String(r?.gender)) ? String(r.gender) : undefined,
      polarity: r?.polarity === 'sever' ? 'sever' : 'assert',
      source: r?.source === 'character_claim' ? 'character_claim' : 'narrator',
    })
    if (out.length >= 8) break
  }
  return out.length ? out : undefined
}

function toRelationshipFactAdditions(
  raw: unknown,
  sourceText: string,
  name: string,
  aliases: string[],
): NonNullable<CharacterCodexDelta['relationship_fact_additions']> | undefined {
  const list = Array.isArray((raw as any)?.add) ? (raw as any).add : []
  const out: NonNullable<CharacterCodexDelta['relationship_fact_additions']> = []
  for (const entry of list) {
    const state = relationshipStateFromEvidence({
      summary: (entry as any)?.statement,
      evidence: (entry as any)?.evidence,
      tags: (entry as any)?.tags,
    }, sourceText)
    if (!state || !relationshipEvidenceBindsToCharacter({ name, aliases, evidence: state.evidence, sourceText })) continue
    out.push({ statement: state.summary, evidence: state.evidence, tags: state.tags })
    if (out.length >= 3) break
  }
  return out.length ? out : undefined
}

/** A narrow second opinion for relationship mutations only. It never rewrites
 * prose and runs after it has streamed. Existing proposed changes are rejected
 * only on an explicit verdict; a supported omitted direct interaction may be
 * returned as a small supplement and then passes the same server validators. */
async function adjudicateRelationshipProposals(params: {
  sourceText: string
  existing: ExistingCharacter[]
  proposed: unknown[]
}): Promise<{ rejected: Set<number>; supplements: unknown[] }> {
  const candidates = params.proposed
    .map((item, index) => ({
      index,
      name: (item as any)?.name,
      relationship_initialization: (item as any)?.relationship_initialization,
      relationship_deltas: (item as any)?.relationship_deltas,
      relationship_evidence: (item as any)?.relationship_evidence,
      relationship_facts: (item as any)?.relationship_facts,
    }))
    .filter((item) => item.relationship_initialization || item.relationship_deltas || item.relationship_facts)
  let raw = ''
  try {
    raw = await callLLM({
      model: AI_MODELS.metadata,
      temperature: 0,
      maxTokens: 700,
      responseFormat: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are a conservative relationship-event adjudicator. Review only direct player↔character bond changes. Reject a proposal only if its quoted evidence does not support that named character or the claimed change. You may add a supplement only for a clearly missed direct interaction, with exact evidence. Never infer motives, indirect atmosphere, or changes without proof. Return ONLY JSON: {"reject":[candidate index],"supplements":[{"name":"existing or present character name","relationship_deltas":{"trust":integer},"relationship_evidence":{"trust":"exact quote"},"relationship_facts":{"add":[{"statement":"concise bond fact","evidence":"exact quote","tags":["tag"]}],"retire":[]} }]}.' ,
        },
        {
          role: 'user',
          content: `EXISTING CHARACTERS:\n${JSON.stringify(params.existing.slice(0, 16).map((c) => ({ name: c.canonical_name, aliases: c.aliases || [], bond: c.relationship_state?.summary || null })))}\n\nPROPOSED:\n${JSON.stringify(candidates)}\n\nSOURCE:\n${params.sourceText.slice(0, 7000)}`,
        },
      ],
    })
  } catch {
    return { rejected: new Set(), supplements: [] }
  }
  const parsed = parseJsonObject(raw) as any
  const indexes = new Set<number>((Array.isArray(parsed.reject) ? parsed.reject : [])
    .filter((index: unknown) => Number.isInteger(index) && candidates.some((candidate) => candidate.index === index)))
  return { rejected: indexes, supplements: Array.isArray(parsed.supplements) ? parsed.supplements.slice(0, 2) : [] }
}

function toDelta(raw: any, sourceText: string): CharacterCodexDelta | null {
  const name = typeof raw?.name === 'string' ? raw.name.trim() : ''
  if (!name) return null
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.map(String) : []
  const relationshipDeltas = toRelationshipDeltas(raw.relationship_deltas)
  const relationshipEvidence = toRelationshipEvidence(
    raw.relationship_evidence,
    relationshipDeltas,
    sourceText,
  )
  const evidenceBackedDeltas = relationshipDeltas
    ? Object.fromEntries(
        Object.entries(relationshipDeltas).filter(([key]) =>
          !!relationshipEvidence?.[key as keyof NonNullable<typeof relationshipDeltas>],
        ),
      ) as CharacterCodexDelta['relationship_deltas']
    : undefined
  const proposedInitialization = relationshipInitializationFromEvidence(
    raw.relationship_initialization,
    sourceText,
  )
  const relationshipInitialization = proposedInitialization && relationshipEvidenceBindsToCharacter({
    name,
    aliases,
    evidence: proposedInitialization.evidence,
    sourceText,
  }) ? proposedInitialization : undefined
  const proposedState = relationshipStateFromEvidence(raw.relationship_state, sourceText)
  const relationshipState = proposedState && relationshipEvidenceBindsToCharacter({
    name,
    aliases,
    evidence: proposedState.evidence,
    sourceText,
  }) ? proposedState : undefined
  const relationshipFactAdditions = toRelationshipFactAdditions(raw.relationship_facts, sourceText, name, aliases)
  const relationshipFactRetire = Array.isArray(raw.relationship_facts?.retire)
    ? raw.relationship_facts.retire.map(String).map((value: string) => value.trim().slice(0, 320)).filter((value: string) => value.length >= 12).slice(0, 3)
    : undefined
  const relationshipUpdateAllowed = !!relationshipInitialization || Object.keys(evidenceBackedDeltas || {}).length > 0
  return {
    name,
    identity_kind:
      raw.identity_kind === 'proper_name' || raw.identity_kind === 'epithet' || raw.identity_kind === 'role_label' || raw.identity_kind === 'kinship_label'
        ? raw.identity_kind
        : undefined,
    aliases,
    resolved_name: typeof raw.resolved_name === 'string' ? raw.resolved_name.trim() : undefined,
    role: typeof raw.role === 'string' ? raw.role.trim() : undefined,
    appearance: typeof raw.appearance === 'string' ? raw.appearance.trim() : undefined,
    persona: typeof raw.persona === 'string' ? raw.persona.trim() : undefined,
    immutable_facts: Array.isArray(raw.immutable_facts)
      ? raw.immutable_facts.map(String).slice(0, 6)
      : [],
    mutable_state: Array.isArray(raw.mutable_state)
      ? raw.mutable_state.map(String).slice(0, 6)
      : [],
    interaction_hints: toInteractionHints(raw.interaction_hints),
    retire_state: Array.isArray(raw.retire_state)
      ? raw.retire_state.map(String).slice(0, 6)
      : [],
    disposition_to_player:
      typeof raw.disposition_to_player === 'string' ? raw.disposition_to_player.trim() : undefined,
    hidden_thought: typeof raw.hidden_thought === 'string' ? raw.hidden_thought.trim() : undefined,
    relationship_deltas: evidenceBackedDeltas && Object.keys(evidenceBackedDeltas).length
      ? evidenceBackedDeltas
      : undefined,
    relationship_evidence: relationshipEvidence,
    relationship_initialization: relationshipInitialization,
    relationship_state: relationshipState && relationshipUpdateAllowed
      ? relationshipState
      : undefined,
    relationship_fact_additions: relationshipFactAdditions && relationshipUpdateAllowed
      ? relationshipFactAdditions
      : undefined,
    relationship_fact_retire: relationshipFactRetire && relationshipUpdateAllowed
      ? relationshipFactRetire
      : undefined,
    is_protagonist: raw.is_protagonist === true,
  }
}

/**
 * Force a correction delta into the ONE canonical shape the ledger replay expects:
 * `resolved_name` = the EXISTING canonical name being corrected, `name` = the NEW
 * corrected proper name. The extractor's LLM is inconsistent across turns — it may
 * emit a rename (e.g. Mara→Mira) with the two names swapped, or stash the old name
 * in `aliases`. If replay sees these inconsistent shapes it can't converge on which
 * name is canonical. We resolve that deterministically HERE, on ingest, before the
 * atom is written to the ledger, using the known roster to decide which side is the
 * pre-existing canonical and which is the new name.
 *
 * Returns the (possibly rewritten) delta, or null when the shape is a genuine
 * correction that can't be coerced (ambiguous: neither or both sides match a known
 * card) — the caller logs a warn and skips it so a malformed correction never
 * corrupts the ledger. Non-correction deltas (no `resolved_name`, or `resolved_name`
 * equals `name`) are returned unchanged.
 */
function canonicalizeCorrectionShape(
  delta: CharacterCodexDelta,
  knownByName: Map<string, string>,
): CharacterCodexDelta | null {
  const resolved = (delta.resolved_name || '').trim()
  const name = (delta.name || '').trim()
  // Not a correction: no resolved_name, or it points at the same identity as name.
  if (!resolved || !name) return delta
  if (normForMatch(resolved) === normForMatch(name)) return delta

  // Which side names a card that ALREADY exists? The canonical shape demands the
  // existing side live in resolved_name and the new side in name.
  const resolvedCanon = knownByName.get(normForMatch(resolved))
  const nameCanon = knownByName.get(normForMatch(name))

  // resolved_name is the existing canonical (or an alias of it) and name is new —
  // already canonical. Pin resolved_name to the registry's canonical spelling so
  // foldDelta's rename branch matches target.canonical_name exactly.
  if (resolvedCanon && !nameCanon) {
    return resolvedCanon === resolved ? delta : { ...delta, resolved_name: resolvedCanon }
  }

  // SWAPPED: name is the existing card and resolved_name is the new corrected name.
  // Flip them into the canonical shape. The old canonical (now in resolved_name's
  // slot's value `nameCanon`) goes to resolved_name; the new name to name.
  if (nameCanon && !resolvedCanon) {
    return { ...delta, name: resolved, resolved_name: nameCanon }
  }

  // Both surfaces can already map to the SAME card when a previous turn stored
  // the proper name as an alias of a role-first card (Sister ↔ Mara). That is an
  // unambiguous promotion, not a conflicting correction: preserve the existing
  // canonical target in resolved_name so the fold can rename it safely.
  if (resolvedCanon && nameCanon) {
    return resolvedCanon === nameCanon
      ? { ...delta, resolved_name: resolvedCanon }
      : null
  }
  // Neither matches: not a correction into an existing card — leave untouched.
  return delta
}

/**
 * Extract emergent NPC codex updates from a turn's player input + narration.
 * Returns compact deltas that can be merged into canonical character cards.
 */
export async function extractCharacterCodexDeltas(params: {
  playerInput: string
  aiResponse: string
  existing: ExistingCharacter[]
  /** Seed prompt of a sentient world — describes the main persona the player
   *  talks TO. Lets the extractor tag that card as the protagonist instead of
   *  treating it like a random NPC. Omit/empty for Game Master worlds. */
  seedPrompt?: string
  isSentient?: boolean
  /** Name of the locked protagonist. For GM worlds this is the PLAYER's own
   *  character — the extractor must track their evolving state and tag them. */
  protagonistName?: string
  /** Player persona name (sentient worlds): the human in the conversation.
   *  They must NEVER become a codex card — the codex tracks the world's cast. */
  playerPersonaName?: string
  /** Canonical names of the characters physically present in the scene THIS turn.
   *  Lets the extractor resolve a bare descriptor ("the man", "the woman") to the
   *  person it can only be — the anchor that stops invented duplicate cards. */
  presentCast?: string[]
  /** Known locations are excluded from person corroboration even when prose
   * personifies them ("Milan greeted him"). */
  knownLocations?: { name: string; aliases?: string[] }[]
  /** Named character entities with repeated provenance but no codex card. */
  promotableOffscreenPeople?: string[]
  /** Test-only raw-response observer; never changes production extraction. */
  onRaw?: (raw: string) => void
}): Promise<CharacterCodexDelta[]> {
  const { playerInput, aiResponse, existing, seedPrompt, isSentient, protagonistName, playerPersonaName, presentCast, knownLocations, promotableOffscreenPeople } = params

  const existingText = existing.length
    ? existing
      .map((c) => {
        const aliases = (c.aliases || []).join(', ')
        const state = (c.mutable_state || []).filter(Boolean)
        const stateLine = state.length ? `\n    current state: ${state.join('; ')}` : ''
        const bond = c.relationship
        const bondLine = bond
          ? `\n    bond state toward player: trust ${bond.trust}/100, affection ${bond.affection}/100, fear ${bond.fear}/100, rivalry ${bond.rivalry}/100`
          : ''
        const bondContextLine = c.relationship_state?.summary
          ? `\n    bond context: ${c.relationship_state.summary}`
          : ''
        const bondFactsLine = (c.relationship_facts || [])
          .filter((fact) => fact.status === 'active')
          .slice(-6)
          .map((fact) => fact.statement)
        const bondJournalLine = bondFactsLine.length
          ? `\n    active bond facts (retire only by exact statement): ${bondFactsLine.join(' | ')}`
          : ''
        const recentShifts = (c.relationship_moments || [])
          .slice(-4)
          .map((moment) => `${moment.meter} ${moment.delta >= 0 ? '+' : ''}${moment.delta} at turn ${moment.sequence}`)
        const bondHistoryLine = recentShifts.length
          ? `\n    recent evidence-backed bond shifts: ${recentShifts.join('; ')}`
          : ''
        return `- ${c.canonical_name}${c.identity_kind ? ` (identity kind: ${c.identity_kind})` : ''}${aliases ? ` (aliases: ${aliases})` : ''}${c.role ? ` role: ${c.role}` : ''}${stateLine}${bondLine}${bondContextLine}${bondJournalLine}${bondHistoryLine}`
      })
      .join('\n')
    : '(none yet)'

  const presentList = (presentCast || []).map((n) => (n || '').trim()).filter(Boolean)
  const presentBlock = presentList.length
    ? `\nPRESENT THIS TURN (these exact people are in the scene now): ${presentList.join(', ')}.\nA bare descriptor in the narration ("the man", "the woman", "the figure", "the stranger", "the boy") almost always refers to one of these present people — resolve it to them, never to a new card.\n`
    : ''
  const promotableOffscreenBlock = (promotableOffscreenPeople || []).length
    ? `\nREPEATED OFF-SCREEN FIGURES (already established by several grounded story mentions; create/update their card when named this turn even if they are not physically present): ${(promotableOffscreenPeople || []).join(', ')}.\n`
    : ''

  const protagonistBlock =
    isSentient && seedPrompt && seedPrompt.trim().length > 0
      ? `
MAIN CHARACTER (PROTAGONIST):
This is a sentient world. The player is in conversation WITH a single main character, described by the world's seed prompt below. When you extract THAT character, set "is_protagonist": true and resolve all of their aliases/titles to the same card (never split them). Track their evolving state (relationships, powers, status) accurately. Every other character is a side character with "is_protagonist": false.
THE PLAYER IS NOT A CHARACTER: the human player${playerPersonaName && playerPersonaName.trim() ? ` (who may be called "${playerPersonaName.trim()}")` : ''} is the person the main character talks to. NEVER create a card for the player, under any name, role, or title — "disposition_to_player" and "relationship_deltas" already capture how characters relate to them.
--- SEED PROMPT ---
${seedPrompt.trim().slice(0, 800)}
--- END SEED PROMPT ---
`
      : protagonistName && protagonistName.trim()
        ? `
PROTAGONIST (THE PLAYER): The player's own character is named "${protagonistName.trim()}". Treat them as a tracked character: set "is_protagonist": true for them, and update their evolving state from the turn — relationships formed/ended, powers gained, status changes (e.g. married, wounded, exiled). Everyone else is a side character with "is_protagonist": false.
ONE PERSON, ONE CARD — CRITICAL: the narration addresses the player in second person. "You"/"your" IS "${protagonistName.trim()}". So is any role title, epithet, or description the premise or narration uses for the player's role (e.g. "the heir", "the neglected son", "the stranger"). When the narration refers to the player by ANY such referent, resolve it to the "${protagonistName.trim()}" card via "resolved_name" — NEVER create a separate card for the player, their role, or "you". A new card is only ever for a DIFFERENT person the player can meet.${seedPrompt && seedPrompt.trim() ? `
--- WORLD PREMISE (defines the player's role — referents of this role are the player) ---
${seedPrompt.trim().slice(0, 800)}
--- END WORLD PREMISE ---` : ''}
`
        : ''

  const system = `You maintain an RPG character codex. Extract character updates from the turn.

Rules:
- Include non-player characters and entities (and the protagonist described below).
- ALWAYS create or update a card for any NAMED character who appears, speaks, or is referenced this turn — even with sparse detail. Do not skip newly introduced characters; capturing them promptly keeps the story consistent.
- Prefer resolving to existing characters when aliases/titles/pronouns refer to the same person; never split one character into two cards. Before creating a NEW card, check whether the name is actually a title, epithet, or description of someone already listed (or of the player) — if so, use "resolved_name" instead of a new card.
- identity_kind: classify the literal identity used for this card: proper_name (Mara, Captain Rhea), epithet (The Mysterious Man), role_label (Butler, Guard), or kinship_label (Mother, Sister). This is durable metadata; do not infer it from capitalization alone. A literal proper name always outranks a kinship/role label for the SAME person. If prose says Sister and later directly addresses her as "Mara, ...", output name: "Mara", identity_kind: "proper_name", aliases: ["Sister"], role: "sibling". If an existing card is named "Sister", use resolved_name: "Sister" with name: "Mara" so it is promoted instead of duplicated. Keep a role label canonical only while no literal proper name has appeared.
- Generic RELATIONAL or ROLE epithets — "the sister", "his sister", "Sister", "the twin", "Mother", "the father", "the guard", "the innkeeper" — are NOT a new person when the existing roster already has a character in that role. A shorter or vaguer label ("Sister") and a more specific one ("Twin Sister") for the same family role are the SAME person. Resolve the epithet to that existing card with "resolved_name"; never create a second card alongside it. Worked example: the roster already lists "Twin Sister"; this turn the narration says "his sister scoffed" → return that character with "resolved_name": "Twin Sister" (do NOT mint a separate "Sister" card).
- A named relative mentioned only by the player as off-screen background ("my sister is Mara", "my brother keeps the locket") is NOT a codex card yet. Store that as a memory, not a Bonds card. Create/update the relative only if they physically appear, speak, act, or are already in the existing roster.
- NEVER INVENT A NAME — NON-NEGOTIABLE. A character's "name" must be a proper name or fixed epithet that LITERALLY appears in this turn's text (player input or narration). NEVER coin a label from the scene's mood, tone, or an action — do NOT produce names like "Mysterious Man", "The Stranger", "Hooded Figure", "The Visitor", "Shadowy Man" unless those exact words appear in the text. A character being secretive, unnamed, or vague is STILL one of the existing roster / present cast — describe their secrecy in their fields, do not give them a new identity.
- A BARE DESCRIPTOR IS NEVER A NEW PERSON when a matching character is already present/listed. "the man", "the woman", "the figure", "the stranger", "the boy/girl", "the older man" → resolve to the present-cast or roster member it can only be (e.g. the only adult male in the room), via "resolved_name". This is the #1 source of accidental duplicates and is FORBIDDEN. Worked example: PRESENT THIS TURN includes "Father"; the narration says *the man tilted the screen away, shielding it from view* while being cagey about his work → that "man" IS the father → return him with "resolved_name": "Father" and capture his secrecy in his state — NEVER mint a "Mysterious Man" (or any new) card for him.
- Return 0-6 characters (most important / most active first).
- Keep hidden_thought private/internal (never spoken aloud), short and specific to the player.
- immutable_facts: PERMANENT history/identity that never stops being true once it happens (e.g. "was engaged to Lord X", "gained pyromancy", "married Mira"). Append-only — only NEW permanent facts from this turn.
- mutable_state: the character's CURRENT status that may change later (e.g. "unattached", "wields fire magic", "wounded"). Only NEW or newly-changed current-status items from this turn.
- interaction_hints: 0-3 OPTIONAL conversation starters for the player, grounded ONLY in this character's post-turn current state. Each source_state must exactly equal one current-status item (new or already listed). Use this format: { "label_template": "Ask why {name} is irritated", "question": "You seem irritated. What's wrong?", "source_state": "irritated" }. The label_template MUST contain the exact {name} placeholder, no quotes or markup. question is the spoken question only: no quotes, no asterisks, no player actions. Use a natural, specific question; omit hints when no current state invites a conversation. Never invent a state just to create a hint.
- retire_state: CRITICAL for continuity. Copy here, VERBATIM, any item from the character's existing "current state" (shown below) that THIS TURN made false or obsolete. Example: if existing state says "engaged to Lord X" and this turn the engagement is broken, put "engaged to Lord X" in retire_state. Leave [] if nothing became false. NEVER let an outdated status linger.
- disposition_to_player: concise sentiment toward the player right now.
- relationship_initialization: ONLY when this character has no established meter state and the world seed, current player turn, or narration explicitly establishes their starting bond. Allowed kinds: best_friend, close_friend, friend, acquaintance, trusted_ally, reluctant_ally, mentor_bond, protector, dependent, romantic_partner, unrequited_attraction, ex_partner, family_warm, family_protective, family_strained, estranged, sibling_close, sibling_resentful, enemy, sworn_enemy, fearful, rival, indebted, betrayed, authority_trust. Return { "kind": one allowed kind, "evidence": "an exact short excerpt from that supplied source" }. Omit it for a stranger, uncertain relationship, or an existing meter state. Never infer it from a role alone.
- relationship_facts: ONLY alongside relationship_initialization or an evidence-backed relationship_deltas update. Return { "add": [{ "statement": "one concise, nuanced emotional truth about this bond", "evidence": "exact short excerpt from this turn or seed", "tags": ["1-4 short descriptive tags"] }], "retire": ["an EXACT existing bond-context statement this direct interaction made false"] }. These are an append/retire journal, not a replacement summary: preserve unresolved hurt, guilt, promises, or mixed feelings unless this turn directly changes them. Add 0-3 facts; omit the field when none apply. Never invent a motive or retire a fact without direct relationship evidence.
- relationship_deltas: how THIS TURN shifted the character's stance toward the player, as integer changes to four meters: trust, affection, fear, rivalry. Existing bond state and recent shifts in the roster are SERVER-OWNED continuity: use them to keep the new disposition and proposed delta proportionate. Include ONLY meters that genuinely moved after a DIRECT interaction with the player, ONLY for characters present this turn. Tension, atmosphere, a glance, or a generic smile alone NEVER changes a meter. Scale: ±1-3 for small moments (kind words, minor friction), ±4-7 for significant ones (a gift, a confession, a public insult), ±8-10 ONLY for dramatic turning points (betrayal, a life saved, a vow broken). Omit the field entirely when nothing shifted. NEVER include it for the player's own protagonist card in a Game Master world (a character has no meters toward themself).
- relationship_evidence: for EVERY nonzero relationship_deltas meter, provide a short EXACT verbatim excerpt from this turn that proves the direct interaction and change. If no exact evidence exists, omit that meter. This field is mandatory for any relationship movement.
- is_protagonist: true ONLY for the world's main character (see below); otherwise false.
- relation_assertions (a TOP-LEVEL array, sibling to "characters" — NOT inside a character): typed family/relationship ties this turn ESTABLISHES or REVEALS between two specific people (or the player). Each: { from, to, kind, label, gender, source }. "from"/"to" are names from the cast; use "player" for the human player's own character. "kind" MUST be exactly one of: parent_of, child_of, sibling_of, partner_of, progenitor_of, descendant_of, superior_of, subordinate_of, kin_of, bonded_of — read as "from is to's <kind>". Worked example: "Mara is the player's sister" → { "from": "Mara", "to": "player", "kind": "sibling_of", "label": "sister", "gender": "f" }. Map ANY world-native term (clone-sister, sire, liege, bondmate, broodmother) to the CLOSEST kind and keep the native word in "label". gender: m|f|n implied by the label. source: "narrator" when the narration states the tie, "character_claim" when a character merely CLAIMS it (may be a lie). polarity: "sever" when a tie ENDS this turn (divorce, death, disownment), else omit. ONLY include a tie the text actually establishes or reveals THIS turn — do NOT re-list every relationship that already exists, and NEVER a figurative one ("like a brother to me"). Empty array [] when no tie is asserted.
${protagonistBlock}${presentBlock}
${promotableOffscreenBlock}
Existing characters (with their current state and server-owned bond state — reconcile against this):
${existingText}

Respond ONLY JSON:
{
  "characters": [
    {
      "name": "string",
      "identity_kind": "proper_name|epithet|role_label|kinship_label",
      "resolved_name": "string optional; use canonical existing name when this is an alias/title",
      "aliases": ["string"],
      "role": "string",
      "appearance": "string",
      "persona": "string",
      "immutable_facts": ["string"],
      "mutable_state": ["string"],
      "interaction_hints": [{ "label_template": "Ask why {name} is irritated", "question": "You seem irritated. What's wrong?", "source_state": "irritated" }],
      "retire_state": ["existing current-state items that are now false/obsolete"],
      "disposition_to_player": "string",
      "hidden_thought": "string",
      "relationship_deltas": { "trust": 0, "affection": 0, "fear": 0, "rivalry": 0 },
      "relationship_evidence": { "trust": "exact words from the turn" },
      "relationship_initialization": { "kind": "close_friend", "evidence": "my close friend" },
      "relationship_facts": { "add": [{ "statement": "A close friend who is protective but worried about the player.", "evidence": "my close friend", "tags": ["protective", "worried"] }], "retire": [] },
      "is_protagonist": false
    }
  ],
  "relation_assertions": [
    { "from": "Mara", "to": "player", "kind": "sibling_of", "label": "sister", "gender": "f", "source": "narrator" }
  ]
}`

  let raw: string
  try {
    raw = await callLLM({
      model: AI_MODELS.codexExtraction,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `Player input:\n${playerInput || '(none)'}\n\nNarration:\n${aiResponse}`,
        },
      ],
      temperature: 0.2,
      maxTokens: 900,
      responseFormat: { type: 'json_object' },
    })
  } catch {
    return []
  }
  params.onRaw?.(raw)

  const parsed = parseJsonObject(raw)
  const rawList: unknown[] = Array.isArray((parsed as any).characters) ? (parsed as any).characters : []
  const sourceText = `${seedPrompt || ''}\n${playerInput || ''}\n${aiResponse || ''}`
  const adjudication = await adjudicateRelationshipProposals({
    sourceText,
    existing,
    proposed: rawList,
  })
  const list = [
    ...rawList.filter((_, index) => !adjudication.rejected.has(index)),
    ...adjudication.supplements,
  ]

  // Deterministic anti-duplication backstop (defends the prompt rules above):
  // a brand-new card is only allowed when its name (or an alias) actually appears
  // in this turn's text. A name the model COINED from the scene's mood
  // ("Mysterious Man") — not grounded in the prose — is never a real new person
  // when a roster already exists; it is a duplicate of someone already carded.
  // Drop the phantom mint; the genuine character is re-emitted on adjacent turns.
  const normText = normForMatch(`${playerInput || ''} ${aiResponse || ''}`)
  const knownNames = new Set<string>()
  // Map every known name/alias (normalized) → its CANONICAL spelling, so a
  // correction's two names can each be resolved to a single canonical identity
  // before the atom is written. Keyed identically to the codex registry.
  const knownByName = new Map<string, string>()
  for (const c of existing) {
    const canon = c.canonical_name
    knownNames.add(normForMatch(canon))
    if (canon) knownByName.set(normForMatch(canon), canon)
    for (const a of c.aliases || []) {
      knownNames.add(normForMatch(a))
      if (canon && a) knownByName.set(normForMatch(a), canon)
    }
  }
  for (const n of presentCast || []) knownNames.add(normForMatch(n))
  const existingNames = new Set(knownByName.keys())
  const knownPlaceNames = (knownLocations || []).flatMap((place) => [
    place.name,
    ...(place.aliases || []),
  ]).map(normForMatch).filter(Boolean)
  // A fresh card needs independent PERSON evidence, not just a metadata-model
  // assertion that a capitalized word was present. This is the promotion seam:
  // new people remain automatically discovered, but only after speech/action/
  // person-possessive/title evidence corroborates the name in the prose.
  const personEvidenceKeys = new Set(
    classifyPresenceCodexGaps(aiResponse, {
      codex: existing.flatMap((c) => [c.canonical_name, ...(c.aliases || [])]),
      exclude: knownPlaceNames,
    })
      .filter(isActionableMention)
      .map((candidate) => normForMatch(candidate.key)),
  )
  const resolvesToKnown = (d: CharacterCodexDelta): boolean => {
    const cands = [d.resolved_name || '', d.name, ...(d.aliases || [])].map(normForMatch)
    return cands.some((c) => c && knownNames.has(c))
  }
  const resolvesToExisting = (d: CharacterCodexDelta): boolean => {
    const cands = [d.resolved_name || '', d.name, ...(d.aliases || [])].map(normForMatch)
    return cands.some((c) => c && existingNames.has(c))
  }

  const out: CharacterCodexDelta[] = []
  for (const item of list) {
    let delta = toDelta(item, sourceText)
    if (!delta) continue
    delta = promoteProperNameOverRole(delta, knownByName, aiResponse)
    // Enforce the ONE canonical correction shape (resolved_name = existing
    // canonical, name = new corrected name) before the atom reaches the ledger,
    // so rebuildCodexFromLedger always converges. A correction that can't be
    // coerced (both names already canonical) is skipped with a warn.
    const canonical = canonicalizeCorrectionShape(delta, knownByName)
    if (!canonical) {
      console.warn(
        `[codex-extractor] skipped ambiguous correction (both "${delta.name}" and "${delta.resolved_name}" are known cards — cannot determine canonical target)`,
      )
      continue
    }
    delta = canonical
    if (isNonPersonRole(delta.role)) {
      console.warn(`[codex-extractor] blocked non-person card "${delta.name}" (role: ${delta.role})`)
      continue
    }
    if (
      delta.resolved_name != null &&
      normForMatch(delta.name) !== normForMatch(delta.resolved_name) &&
      isEphemeralPersonDescriptor(delta.name)
    ) {
      console.warn(
        `[codex-extractor] held descriptor identity guess "${delta.name}" → "${delta.resolved_name}"; explicit reveal evidence is required`,
      )
      continue
    }
    const isNewCard = delta.is_protagonist !== true && !resolvesToExisting(delta)
    if (
      isNewCard &&
      isAbstractNonPersonTerm(delta.name) &&
      !isDirectSelfIntroduction(delta.name, aiResponse, playerInput)
    ) {
      console.warn(`[codex-extractor] blocked personified abstract noun "${delta.name}"`)
      continue
    }
    if (delta.is_protagonist !== true && !resolvesToKnown(delta)) {
      // A bare role/descriptor with no proper name ("the merchant", "a guard") is
      // a passer-by, not a tracked character — never mint a card for it (it would
      // resolve to a known roster member above if it were one we follow).
      if (
        isBareDescriptorName(delta.name) &&
        isBareDescriptorName(delta.resolved_name || delta.name)
      ) {
        console.warn(
          `[codex-extractor] blocked bare-descriptor card "${delta.name}" (passer-by, not a tracked character)`,
        )
        continue
      }
      const presentNames = new Set((presentCast || []).map(normForMatch))
      const appearsPresent = [delta.name, delta.resolved_name || '', ...(delta.aliases || [])]
        .map(normForMatch)
        .some((n) => n && presentNames.has(n))
      if (!appearsPresent && isPlayerMentionedRelative(delta, playerInput, aiResponse)) {
        console.warn(
          `[codex-extractor] blocked absent player-relative card "${delta.name}" (memory fact, not present cast)`,
        )
        continue
      }
    }
    if (isNewCard) {
      const candidateKeys = [delta.name, delta.resolved_name || '', ...(delta.aliases || [])]
        .map(normForMatch)
        .filter(Boolean)
      const presentNames = new Set((presentCast || []).map(normForMatch))
      const physicallyPresent = candidateKeys.some((name) => presentNames.has(name))
      const corroboratedPerson = candidateKeys.some((name) => personEvidenceKeys.has(name))
      const directSelfIntroduction = [delta.name, delta.resolved_name || '', ...(delta.aliases || [])]
        .some((name) => isDirectSelfIntroduction(name, aiResponse, playerInput))
      const offscreenPromotion = isEligibleOffscreenPromotion(candidateKeys, promotableOffscreenPeople || [])
      // A literal in-scene self-introduction is both presence and person
      // evidence. It is the only exception to the usual two-source gate, so a
      // named walk-on is not lost just because the independent metadata pass
      // missed them on their entrance.
      if ((!physicallyPresent || !corroboratedPerson) && !directSelfIntroduction && !offscreenPromotion) {
        console.warn(
          `[codex-extractor] held uncorroborated new card "${delta.name}" (present=${physicallyPresent}, personEvidence=${corroboratedPerson}, directIntro=${directSelfIntroduction})`,
        )
        continue
      }
    }
    // A NEW card (resolves to no known/present character) MUST be grounded in the
    // text. Protagonist-tagged deltas are exempt (handled by the one-protagonist
    // invariant downstream). When the roster is empty there is nothing to dup, so
    // the guard only engages once a cast exists.
    if (knownNames.size > 0 && delta.is_protagonist !== true && !resolvesToKnown(delta)) {
      const grounded =
        nameAppearsInText(delta.name, normText) ||
        (delta.aliases || []).some((a) => nameAppearsInText(a, normText)) ||
        (delta.resolved_name ? nameAppearsInText(delta.resolved_name, normText) : false)
      if (!grounded) {
        console.warn(
          `[codex-extractor] blocked ungrounded new card "${delta.name}" (not in turn text; likely a duplicate of an existing/present character)`,
        )
        continue
      }
    }
    out.push(delta)
    if (out.length >= 6) break
  }
  // Turn-level kinship ties ride on the first delta (the kinship graph collects
  // them via flatMap; they persist on the codex_deltas ledger for free, so a
  // rewind replays the relationship graph too). Consumed by kinship-graph.service,
  // never by the codex fold itself.
  const relationAssertions = toRelationAssertions((parsed as any).relation_assertions)
  if (relationAssertions && out.length > 0) {
    out[0].relation_assertions = relationAssertions
  }
  return out
}
