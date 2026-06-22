/**
 * Kinship ontology — the CLOSED structural relation kinds the engine reasons over,
 * plus the OPEN→closed mapping from any world-native surface term onto one kind.
 *
 * See everlore-docs/memory/KINSHIP_GRAPH.md. The whole point: a closed human enum
 * (brother/sister/mother…) breaks on hive-queens, AI forks, clone-lines, packs and
 * liege-houses. So code only ever reasons over ~10 STRUCTURAL kinds (each with a
 * known inverse + symmetry rule), while the world-native word survives as a free
 * `label`. The closed set never grows for a new genre.
 */

export type RelationKind =
  | 'parent_of'
  | 'child_of'
  | 'sibling_of'
  | 'partner_of'
  | 'progenitor_of'
  | 'descendant_of'
  | 'superior_of'
  | 'subordinate_of'
  | 'kin_of'
  | 'bonded_of'

export const RELATION_KINDS: RelationKind[] = [
  'parent_of', 'child_of', 'sibling_of', 'partner_of', 'progenitor_of',
  'descendant_of', 'superior_of', 'subordinate_of', 'kin_of', 'bonded_of',
]

const KIND_SET = new Set<string>(RELATION_KINDS)
export function isRelationKind(s: unknown): s is RelationKind {
  return typeof s === 'string' && KIND_SET.has(s)
}

/** Inverse of each kind — the kind written on the auto-closed REVERSE edge. */
export const INVERSE_KIND: Record<RelationKind, RelationKind> = {
  parent_of: 'child_of',
  child_of: 'parent_of',
  sibling_of: 'sibling_of',
  partner_of: 'partner_of',
  progenitor_of: 'descendant_of',
  descendant_of: 'progenitor_of',
  superior_of: 'subordinate_of',
  subordinate_of: 'superior_of',
  kin_of: 'kin_of',
  bonded_of: 'bonded_of',
}

/** A kind whose inverse is ITSELF is symmetric (both directions same kind). */
export function isSymmetric(kind: RelationKind): boolean {
  return INVERSE_KIND[kind] === kind
}

/**
 * MODIFIER axis — orthogonal to the structural kind. A step-father and a father
 * share the kind `parent_of` but are NOT the same tie: only `biological` (and, for
 * most reasoning, `adoptive`) satisfies inferences like "spouse of a parent is a
 * co-parent". Closed + small + genre-spanning, exactly like the kind enum, so the
 * engine can REASON over step/half/in-law instead of leaving them as label text.
 */
export type RelationModifier =
  | 'biological' // default; a "by-blood" or unmarked tie
  | 'step'
  | 'half'
  | 'adoptive'
  | 'foster'
  | 'in_law'

export const RELATION_MODIFIERS: RelationModifier[] = [
  'biological', 'step', 'half', 'adoptive', 'foster', 'in_law',
]
const MODIFIER_SET = new Set<string>(RELATION_MODIFIERS)
export function isRelationModifier(s: unknown): s is RelationModifier {
  return typeof s === 'string' && MODIFIER_SET.has(s)
}

/** Modifiers a co-parent / structural inference may treat as a "full" tie. A step
 *  or in-law tie must NOT satisfy biological inference; adoptive/foster legally do. */
export function isStructuralModifier(m: RelationModifier | undefined): boolean {
  return !m || m === 'biological' || m === 'adoptive' || m === 'foster'
}

/**
 * LIFECYCLE STATE axis — how an EXISTING tie stands right now. Death/disownment/
 * divorce do NOT delete a tie; they evolve its state (history is preserved so the
 * narrator can still say "your late father"). `revealed_false` is the retraction a
 * twist produces ("he was never your father") — recorded, not silently dropped.
 */
export type LifecycleState =
  | 'active' // default
  | 'deceased' // the related person died → "late <rel>"
  | 'estranged' // disowned / cast out → "ex-<rel>" socially, tie intact by blood
  | 'dissolved' // divorce / annulment (partner ties)
  | 'revealed_false' // a twist retracted the tie — it was never real

export const LIFECYCLE_STATES: LifecycleState[] = [
  'active', 'deceased', 'estranged', 'dissolved', 'revealed_false',
]
const STATE_SET = new Set<string>(LIFECYCLE_STATES)
export function isLifecycleState(s: unknown): s is LifecycleState {
  return typeof s === 'string' && STATE_SET.has(s)
}

/** A state that ENDS the tie's validity (closes the edge) rather than just
 *  re-colouring an intact one. Death/estrangement keep the tie live (and woke-able);
 *  a divorce or a retraction closes it. */
export function isTerminalState(s: LifecycleState | undefined): boolean {
  return s === 'dissolved' || s === 'revealed_false'
}

/** Prefix a surface label with its modifier/state so reads NEVER store a drifted
 *  string ("late step-father" is COMPUTED from kind+modifier+state+label, not saved).
 *  `label` is the world-native word (already kind-appropriate, e.g. "father"). */
export function composeSurface(
  label: string,
  modifier?: RelationModifier,
  state?: LifecycleState,
): string {
  let base = (label || '').trim()
  if (modifier && modifier !== 'biological') {
    const word = modifier === 'in_law' ? '-in-law' : `${modifier}`
    base = modifier === 'in_law' ? `${base}${word}` : `${word}${base}`
  }
  if (state === 'deceased') base = `late ${base}`
  else if (state === 'estranged') base = `estranged ${base}`
  else if (state === 'dissolved') base = `former ${base}`
  else if (state === 'revealed_false') base = `supposed ${base}`
  return base
}

export type GenderHint = 'm' | 'f' | 'n'

/** Surface term → { kind, gender? }. Genre-spanning on purpose: human kin, plus
 *  clone/fork/hive/pack/liege vocab. A term not here is mapped by the extractor
 *  LLM directly to a kind (it's told the closed set); this table is the
 *  deterministic backstop + the choice-guard's surface→kind resolver. */
const SURFACE_TERMS: Record<string, { kind: RelationKind; gender?: GenderHint; modifier?: RelationModifier }> = {
  // parents
  mother: { kind: 'parent_of', gender: 'f' }, mom: { kind: 'parent_of', gender: 'f' },
  mommy: { kind: 'parent_of', gender: 'f' }, mum: { kind: 'parent_of', gender: 'f' },
  mama: { kind: 'parent_of', gender: 'f' }, momma: { kind: 'parent_of', gender: 'f' },
  father: { kind: 'parent_of', gender: 'm' }, dad: { kind: 'parent_of', gender: 'm' },
  daddy: { kind: 'parent_of', gender: 'm' }, papa: { kind: 'parent_of', gender: 'm' },
  pop: { kind: 'parent_of', gender: 'm' }, pops: { kind: 'parent_of', gender: 'm' },
  parent: { kind: 'parent_of' },
  stepmother: { kind: 'parent_of', gender: 'f', modifier: 'step' }, stepmom: { kind: 'parent_of', gender: 'f', modifier: 'step' },
  stepfather: { kind: 'parent_of', gender: 'm', modifier: 'step' }, stepdad: { kind: 'parent_of', gender: 'm', modifier: 'step' },
  adoptedmother: { kind: 'parent_of', gender: 'f', modifier: 'adoptive' }, adoptedfather: { kind: 'parent_of', gender: 'm', modifier: 'adoptive' },
  fostermother: { kind: 'parent_of', gender: 'f', modifier: 'foster' }, fosterfather: { kind: 'parent_of', gender: 'm', modifier: 'foster' },
  motherinlaw: { kind: 'parent_of', gender: 'f', modifier: 'in_law' }, fatherinlaw: { kind: 'parent_of', gender: 'm', modifier: 'in_law' },
  // children
  son: { kind: 'child_of', gender: 'm' }, daughter: { kind: 'child_of', gender: 'f' },
  child: { kind: 'child_of' }, kid: { kind: 'child_of' },
  heir: { kind: 'child_of' }, scion: { kind: 'child_of' },
  stepson: { kind: 'child_of', gender: 'm', modifier: 'step' }, stepdaughter: { kind: 'child_of', gender: 'f', modifier: 'step' },
  soninlaw: { kind: 'child_of', gender: 'm', modifier: 'in_law' }, daughterinlaw: { kind: 'child_of', gender: 'f', modifier: 'in_law' },
  // siblings
  brother: { kind: 'sibling_of', gender: 'm' }, bro: { kind: 'sibling_of', gender: 'm' },
  sister: { kind: 'sibling_of', gender: 'f' }, sis: { kind: 'sibling_of', gender: 'f' },
  sibling: { kind: 'sibling_of' }, twin: { kind: 'sibling_of' },
  stepbrother: { kind: 'sibling_of', gender: 'm', modifier: 'step' }, stepsister: { kind: 'sibling_of', gender: 'f', modifier: 'step' },
  halfbrother: { kind: 'sibling_of', gender: 'm', modifier: 'half' }, halfsister: { kind: 'sibling_of', gender: 'f', modifier: 'half' },
  brotherinlaw: { kind: 'sibling_of', gender: 'm', modifier: 'in_law' }, sisterinlaw: { kind: 'sibling_of', gender: 'f', modifier: 'in_law' },
  broodmate: { kind: 'sibling_of' },
  // partners
  husband: { kind: 'partner_of', gender: 'm' }, wife: { kind: 'partner_of', gender: 'f' },
  spouse: { kind: 'partner_of' }, mate: { kind: 'partner_of' }, bondmate: { kind: 'partner_of' },
  betrothed: { kind: 'partner_of' }, fiance: { kind: 'partner_of', gender: 'm' },
  fiancee: { kind: 'partner_of', gender: 'f' }, consort: { kind: 'partner_of' },
  // progenitor / descendant (creators, clones, hives, forks)
  maker: { kind: 'progenitor_of' }, creator: { kind: 'progenitor_of' }, sire: { kind: 'progenitor_of', gender: 'm' },
  clone: { kind: 'descendant_of' }, fork: { kind: 'descendant_of' }, drone: { kind: 'descendant_of' },
  creation: { kind: 'descendant_of' },
  // superior / subordinate (liege/master/ward)
  liege: { kind: 'superior_of' }, master: { kind: 'superior_of' }, mistress: { kind: 'superior_of', gender: 'f' },
  commander: { kind: 'superior_of' }, lord: { kind: 'superior_of', gender: 'm' }, lady: { kind: 'superior_of', gender: 'f' },
  vassal: { kind: 'subordinate_of' }, servant: { kind: 'subordinate_of' }, ward: { kind: 'subordinate_of' },
  apprentice: { kind: 'subordinate_of' }, familiar: { kind: 'subordinate_of' }, squire: { kind: 'subordinate_of' },
  // generic catch-alls
  family: { kind: 'kin_of' }, relative: { kind: 'kin_of' }, kin: { kind: 'kin_of' },
  // wider human family → generic kin (we don't model uncle/cousin structurally;
  // they're real relatives but not the nuclear slots the choice guard reasons over)
  uncle: { kind: 'kin_of', gender: 'm' }, aunt: { kind: 'kin_of', gender: 'f' },
  cousin: { kind: 'kin_of' }, nephew: { kind: 'kin_of', gender: 'm' }, niece: { kind: 'kin_of', gender: 'f' },
  grandmother: { kind: 'kin_of', gender: 'f' }, grandfather: { kind: 'kin_of', gender: 'm' },
  grandma: { kind: 'kin_of', gender: 'f' }, grandpa: { kind: 'kin_of', gender: 'm' },
  granny: { kind: 'kin_of', gender: 'f' }, nana: { kind: 'kin_of', gender: 'f' },
  grandson: { kind: 'kin_of', gender: 'm' }, granddaughter: { kind: 'kin_of', gender: 'f' },
}

/** Surface kin words used by the CHOICE GUARD to decide whether a choice names a
 *  relation. Single-token, lowercase; multiword forms collapse to a base token. */
export const SURFACE_KIN_TERMS: string[] = Object.keys(SURFACE_TERMS)

/** Map a surface term to its structural kind (+ gender + modifier hint), or null.
 *  Strips ALL separators so "step-father", "step father", "father-in-law" collapse
 *  to the single-token keys ("stepfather", "fatherinlaw"). */
export function surfaceToKind(
  term: string,
): { kind: RelationKind; gender?: GenderHint; modifier?: RelationModifier } | null {
  const t = String(term || '').toLowerCase().trim().replace(/[^a-zà-ÿ]/gi, '')
  return SURFACE_TERMS[t] || null
}

/** Figurative/simile patterns that are NOT a literal relation ("like a brother",
 *  "as a father to me", "brotherly", "practically family"). Stage-1 metaphor strip. */
const METAPHOR_PATTERNS: RegExp[] = [
  /\b(?:like|as)\s+(?:a|an|my|his|her|their)?\s*\w*\s*(?:mother|father|brother|sister|son|daughter|family|parent|kin)\b/i,
  /\b(?:brotherly|sisterly|motherly|fatherly|paternal|maternal|filial)\b/i,
  /\bpractically\s+(?:family|a\s+\w+)\b/i,
  /\balmost\s+(?:a|an)\s+(?:brother|sister|mother|father|son|daughter)\b/i,
  /\b(?:figure|like)\s+a\s+(?:father|mother|brother|sister)\s+figure\b/i,
  /\b(?:father|mother|brother|sister)\s+figure\b/i,
]

/** True when `text` frames a kin word figuratively rather than as a literal tie. */
export function isFigurativeKinship(text: string): boolean {
  const t = String(text || '')
  return METAPHOR_PATTERNS.some((re) => re.test(t))
}
