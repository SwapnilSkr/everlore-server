/**
 * Stage 1 — deterministic kinship-graph hygiene (NO LLM). The character analog of
 * prose-hygiene's rule-based detector. Operates on already-resolved assertions
 * (endpoints = entity ids) and returns the cleaned, inverse-closed, confidence-
 * ranked set of edges to write. Pure: no DB, no network → zero TTFT (runs on the
 * post-stream tail). See KINSHIP_GRAPH.md.
 */
import {
  type RelationKind, type GenderHint, type RelationModifier, INVERSE_KIND, isSymmetric,
  surfaceToKind, isFigurativeKinship, isRelationKind,
} from '../../src/utils/kinship-ontology'

/** Provenance an edge can carry. Extends the original narrator/character/inference/
 *  seed set with the PLAYER-authored sources (a player can correct/narrate/claim a
 *  tie) so a player_correction can outrank narration. Mirrors WorldFactSource but
 *  kept as its own narrow union to stay a pure, dependency-light module. */
export type KinshipEdgeSource =
  | 'player_correction'
  | 'player_narration'
  | 'narrator'
  | 'seed'
  | 'player_claim'
  | 'character_claim'
  | 'inferred'

export interface ResolvedAssertion {
  fromId: string
  toId: string
  kind: RelationKind
  label?: string
  gender?: GenderHint
  modifier?: RelationModifier
  polarity: 'assert' | 'sever'
  source: KinshipEdgeSource
}

export interface KinshipEdgeWrite {
  fromId: string
  toId: string
  kind: RelationKind
  inverseKind: RelationKind
  label: string | null
  gender: GenderHint | null
  modifier: RelationModifier | null
  source: KinshipEdgeSource
  confidence: number
  polarity: 'assert' | 'sever'
}

const BASE_CONFIDENCE: Record<KinshipEdgeSource, number> = {
  player_correction: 1.0,
  player_narration: 0.9,
  narrator: 0.9,
  seed: 0.8,
  player_claim: 0.65,
  character_claim: 0.5,
  inferred: 0.4,
}

/** Genders known per entity (from the codex cards), so a "sister" label on a
 *  male-gendered card can be flagged. Optional — absent genders skip the check. */
export type GenderByEntity = Map<string, GenderHint>

export interface HygieneResult {
  edges: KinshipEdgeWrite[]
  /** Human-readable notes on what was dropped/repaired — for logs + audit. */
  notes: string[]
}

/**
 * Clean + close a turn's resolved assertions into the edge set to persist.
 * Deterministic, idempotent.
 */
export function hygieneStage1(
  assertions: ResolvedAssertion[],
  genders?: GenderByEntity,
): HygieneResult {
  const notes: string[] = []
  const cleaned: ResolvedAssertion[] = []

  for (const a of assertions) {
    // self-loop
    if (!a.fromId || !a.toId || a.fromId === a.toId) {
      notes.push(`drop self/empty (${a.kind})`)
      continue
    }
    // figurative label leaked through ("like a brother", "father figure")
    if (a.label && isFigurativeKinship(a.label)) {
      notes.push(`drop figurative label "${a.label}"`)
      continue
    }
    let kind = a.kind
    let gender = a.gender
    let modifier = a.modifier
    // kind↔label consistency: when the world-native label is a KNOWN surface term,
    // trust its structural reading over a mismatched model-assigned kind, and fill a
    // missing gender/modifier from the label ("stepfather" → step, "father" → none).
    if (a.label) {
      const mapped = surfaceToKind(a.label)
      if (mapped) {
        if (mapped.kind !== kind && isRelationKind(mapped.kind)) {
          notes.push(`repair kind ${kind}→${mapped.kind} from label "${a.label}"`)
          kind = mapped.kind
        }
        if (!gender && mapped.gender) gender = mapped.gender
        if (!modifier && mapped.modifier) modifier = mapped.modifier
      }
    }
    // gender↔card consistency: a "sister"(f) label on a male-gendered card is a
    // mis-tag — keep the structural kind but drop the contradicted gender hint.
    if (gender && genders) {
      const cardG = genders.get(a.toId)
      if (cardG && cardG !== 'n' && gender !== 'n' && cardG !== gender) {
        notes.push(`gender mismatch on ${a.toId} (label ${gender} vs card ${cardG}) — clearing hint`)
        gender = undefined
      }
    }
    cleaned.push({ ...a, kind, gender, modifier })
  }

  // Bounded 1-hop inference WITHIN this batch only (no DB read): siblings share
  // parents. A `sibling_of` + a `child_of` on one of the pair → the other is a
  // child of the same parent. Tagged inferred / low confidence; capped at 1 hop
  // because half/step/adoptive families make deeper inference unsafe.
  const inferred: ResolvedAssertion[] = []
  // Assertions can state the same fact in either direction: `Mother is the
  // player's parent` (parent_of) or `the player is Mother's child` (child_of).
  // Normalize both forms for this local sibling closure, otherwise a premise
  // with Mother → player and Sister ↔ player never gives Mother → Sister a
  // graph edge even though it is the exact relationship dialogue needs.
  const childOf = [
    ...cleaned.filter((a) => a.kind === 'child_of' && a.polarity === 'assert'),
    ...cleaned
      .filter((a) => a.kind === 'parent_of' && a.polarity === 'assert')
      .map((a) => ({
        ...a,
        fromId: a.toId,
        toId: a.fromId,
        kind: 'child_of' as const,
        label: undefined,
        gender: undefined,
      })),
  ]
  const siblingOf = cleaned.filter((a) => a.kind === 'sibling_of' && a.polarity === 'assert')
  for (const sib of siblingOf) {
    for (const co of childOf) {
      if (co.fromId === sib.fromId && co.toId !== sib.toId) {
        inferred.push({ fromId: sib.toId, toId: co.toId, kind: 'child_of', polarity: 'assert', source: 'inferred' })
      }
      if (co.fromId === sib.toId && co.toId !== sib.fromId) {
        inferred.push({ fromId: sib.fromId, toId: co.toId, kind: 'child_of', polarity: 'assert', source: 'inferred' })
      }
    }
  }
  if (inferred.length) notes.push(`inferred ${inferred.length} child_of via sibling closure`)

  // Inverse closure + dedup. Every assertion writes BOTH directions so the graph
  // is symmetric-consistent even when the narrator states only one side.
  const byKey = new Map<string, KinshipEdgeWrite>()
  const emit = (e: KinshipEdgeWrite) => {
    const key = `${e.fromId}|${e.toId}|${e.kind}`
    const prev = byKey.get(key)
    // On dup, keep the higher-confidence / assert-over-sever variant.
    if (!prev || e.confidence > prev.confidence || (e.polarity === 'sever' && prev.polarity !== 'sever')) {
      byKey.set(key, e)
    }
  }
  for (const a of [...cleaned, ...inferred]) {
    const inv = INVERSE_KIND[a.kind]
    const confidence = BASE_CONFIDENCE[a.source]
    emit({
      fromId: a.fromId, toId: a.toId, kind: a.kind, inverseKind: inv,
      label: a.label ?? null, gender: a.gender ?? null, modifier: a.modifier ?? null,
      source: a.source, confidence, polarity: a.polarity,
    })
    // The reverse edge carries no surface label (it's the other person's view);
    // a symmetric kind keeps the same label since the relation reads the same. The
    // modifier IS symmetric (a step-tie is step from both sides), so it carries over.
    emit({
      fromId: a.toId, toId: a.fromId, kind: inv, inverseKind: a.kind,
      label: isSymmetric(a.kind) ? (a.label ?? null) : null,
      gender: null, modifier: a.modifier ?? null, source: a.source, confidence, polarity: a.polarity,
    })
  }

  return { edges: [...byKey.values()], notes }
}
