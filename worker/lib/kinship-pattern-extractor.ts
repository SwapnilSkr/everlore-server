/**
 * Deterministic kinship extractor (NO LLM). Reads explicit kinship statements out
 * of PLAYER-authored input and narrator prose using the kinship ontology, so a
 * clearly-stated tie ("Mara is my sister", "my sister Mara", "not my cousin but my
 * sister") is captured with the RIGHT authority even when the LLM codex extractor
 * misses it or can only stamp it 'narrator'. Player corrections become
 * `player_correction` (which can retcon); reported speech / dialogue become
 * `player_claim`; prose becomes `narrator`.
 *
 * Pure + cheap → runs on the post-stream tail, off TTFT. Output is the codex
 * `RelationAssertion` shape so it merges with the LLM assertions before the kinship
 * graph applies them. Conservative by design: it only emits a tie when BOTH
 * endpoints are nameable (a proper name or the player), to avoid minting ties from
 * vague pronoun owners ("his brother" with no antecedent).
 */
import type { RelationAssertion } from '../../src/services/character-codex.service'
import { type WorldFactSource, SOURCE_RANK, isWorldFactSource } from '../../src/utils/world-authority'
import { surfaceToKind, SURFACE_KIN_TERMS, isFigurativeKinship } from '../../src/utils/kinship-ontology'

const NAME = "[A-Z][a-zà-ÿ'’\\-]+"
// Longest-first alternation so "stepbrother" wins over "brother".
const REL = [...SURFACE_KIN_TERMS].sort((a, b) => b.length - a.length).join('|')
// up to two adjectives between owner and the relation word ("my dear older sister")
const ADJ = `(?:[a-zà-ÿ'’\\-]+\\s+){0,2}`

const PLAYER = '__player__'

/** A real proper name starts with an uppercase letter. Needed because the patterns
 *  run case-INSENSITIVE (so relation words / keywords match in any case), which
 *  also lets `[A-Z]` match lowercase — so common words like "not"/"smiled" can slip
 *  into a name slot. This rejects them. */
function isProperName(s: string): boolean {
  return /^[A-ZÀ-Þ]/.test(s.trim())
}

/** Resolve an owner phrase to an endpoint name, or null when unanchored. */
function resolveOwner(raw: string): string | null {
  const t = raw.trim().toLowerCase()
  if (t === 'my' || t === 'mine') return PLAYER
  const poss = raw.trim().match(/^(.+)['’]s$/)
  if (poss && isProperName(poss[1])) return poss[1].trim()
  return null // the/a/his/her/their with no antecedent → unanchored, skip
}

interface RawTie {
  named: string // the named person endpoint
  owner: string // PLAYER or a name
  rel: string // surface relation word
  negated: boolean // came from a "not ..." clause → a sever of this kind
}

/** Pull explicit kinship clauses out of one text fragment. */
function extractTies(text: string): RawTie[] {
  const out: RawTie[] = []
  if (!text || isFigurativeKinship(text)) return out

  // P1: "<Name> is/was [my|<Name>'s] [adj] <rel>"  → Name is owner's <rel>
  const p1 = new RegExp(`\\b(${NAME})\\s+(?:is|was|are|were)\\s+(my|mine|${NAME}['’]s)\\s+${ADJ}(${REL})\\b`, 'gi')
  // P2: "[my|<Name>'s] [adj] <rel>[,]? <Name>"  → "my sister Mara" / "Kael's father Bram"
  const p2 = new RegExp(`\\b(my|mine|${NAME}['’]s)\\s+${ADJ}(${REL}),?\\s+(${NAME})\\b`, 'gi')
  // P3: "<Name>, [my|<Name>'s] [adj] <rel>"  → appositive "Mara, my sister"
  const p3 = new RegExp(`\\b(${NAME}),\\s+(my|mine|${NAME}['’]s)\\s+${ADJ}(${REL})\\b`, 'gi')
  // P-NOT: "not [my|<Name>'s] [adj] <rel>"  → a contradicted/severed kind (correction)
  const pNot = new RegExp(`\\bnot\\s+(my|mine|${NAME}['’]s)\\s+${ADJ}(${REL})\\b`, 'gi')
  // P-LIE: "lied about <Name> being [my|<Name>'s] <rel>" → retract a claimed tie
  const pLie = new RegExp(`lied about\\s+(${NAME})\\s+being\\s+(my|mine|${NAME}['’]s)\\s+${ADJ}(${REL})\\b`, 'gi')

  let m: RegExpExecArray | null
  while ((m = p1.exec(text))) {
    const owner = resolveOwner(m[2])
    if (owner && isProperName(m[1])) out.push({ named: m[1], owner, rel: m[3], negated: false })
  }
  while ((m = p2.exec(text))) {
    const owner = resolveOwner(m[1])
    if (owner && isProperName(m[3]) && owner !== m[3]) out.push({ named: m[3], owner, rel: m[2], negated: false })
  }
  while ((m = p3.exec(text))) {
    const owner = resolveOwner(m[2])
    if (owner && isProperName(m[1]) && owner !== m[1]) out.push({ named: m[1], owner, rel: m[3], negated: false })
  }
  while ((m = pLie.exec(text))) {
    const owner = resolveOwner(m[2])
    if (owner && isProperName(m[1])) out.push({ named: m[1], owner, rel: m[3], negated: true })
  }
  // "not ..." clauses sever the kind for the MOST RECENT named pair in the fragment
  // (e.g. "Mara is my sister, not my cousin" → assert sibling_of, sever kin_of).
  const anchor = out.find((t) => !t.negated)
  if (anchor) {
    while ((m = pNot.exec(text))) {
      const owner = resolveOwner(m[1])
      if (owner) out.push({ named: anchor.named, owner, rel: m[2], negated: true })
    }
  }
  return out
}

function toAssertion(tie: RawTie, source: WorldFactSource): RelationAssertion | null {
  const mapped = surfaceToKind(tie.rel)
  if (!mapped) return null
  return {
    from: tie.named,
    to: tie.owner === PLAYER ? 'player' : tie.owner,
    kind: mapped.kind,
    label: tie.rel.toLowerCase(),
    gender: mapped.gender,
    modifier: mapped.modifier,
    polarity: tie.negated ? 'sever' : 'assert',
    source,
  }
}

export interface KinshipPatternInput {
  /** Player OOC corrections/retcons (highest authority). */
  corrections?: string[]
  /** Player-authored narration of a fact ("My sister Mara grabs my arm"). */
  narrationFacts?: string[]
  /** Player-character claims (spoken / reported speech — may be a lie). */
  claims?: string[]
  /** The narrator's prose for this turn. */
  prose?: string
}

/**
 * Extract deterministic relation assertions from a turn's inputs, each tagged with
 * the authority of where it came from. Order is high→low authority so a later
 * authority-aware merge can prefer the strongest.
 */
export function extractKinshipAssertions(input: KinshipPatternInput): RelationAssertion[] {
  const out: RelationAssertion[] = []
  const push = (texts: string[] | undefined, source: WorldFactSource) => {
    for (const t of texts || []) {
      for (const tie of extractTies(t)) {
        const a = toAssertion(tie, source)
        if (a) out.push(a)
      }
    }
  }
  push(input.corrections, 'player_correction')
  push(input.narrationFacts, 'player_narration')
  push(input.claims, 'player_claim')
  push(input.prose ? [input.prose] : undefined, 'narrator')
  return out
}

const PLAYER_KEYS = new Set(['player', 'me', 'myself', 'i', 'self'])
function endpointKey(name: string): string {
  const t = String(name || '').toLowerCase().trim()
  return PLAYER_KEYS.has(t) ? 'player' : t
}
function rankOf(source: RelationAssertion['source']): number {
  return isWorldFactSource(source) ? SOURCE_RANK[source] : SOURCE_RANK.narrator
}

/**
 * Merge LLM-extracted and deterministic relation assertions, authority-aware.
 * Keyed by (from, to, kind) with the player endpoint normalized, the WINNER of a
 * collision is the higher-authority source (lower SOURCE_RANK) — so a deterministic
 * `player_correction` beats the LLM's `narrator`, while the LLM keeps any tie the
 * patterns didn't catch. The winner's polarity is kept, letting a player_correction
 * `sever` ("not my cousin") override a stale assert. Stable, no model calls.
 */
export function mergeRelationAssertions(
  llm: RelationAssertion[] | undefined,
  deterministic: RelationAssertion[] | undefined,
): RelationAssertion[] {
  const byKey = new Map<string, RelationAssertion>()
  // Deterministic first so it seeds the map; ties broken by rank below regardless.
  for (const a of [...(deterministic || []), ...(llm || [])]) {
    if (!a?.from || !a?.to || !a?.kind) continue
    const key = `${endpointKey(a.from)}|${endpointKey(a.to)}|${a.kind}`
    const prev = byKey.get(key)
    if (!prev || rankOf(a.source) < rankOf(prev.source)) byKey.set(key, a)
  }
  return [...byKey.values()]
}
