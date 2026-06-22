/**
 * Deterministic kinship TRANSITION extractor (NO LLM) — the second write channel.
 *
 * Where the pattern/LLM extractors ASSERT that a tie exists (kind + modifier,
 * authority-gated), this reads how an EXISTING tie EVOLVES: a death, a disownment,
 * a divorce, or a twist that retracts it. Transitions are NOT authority-gated by
 * `system_seed` — a premise that seeds "your father" must still allow the story to
 * later bury him ("your late father") or reveal he was never your father. They
 * change the edge's lifecycle STATE, not its existence.
 *
 * Conservative, like the pattern extractor: a transition is only emitted when both
 * the OWNER (a name or the player/protagonist) and a kin word are anchored in the
 * same clause as the cue. Pure + cheap → runs on the post-stream tail, off TTFT.
 * See KINSHIP_GRAPH.md.
 */
import type { WorldFactSource } from '../../src/utils/world-authority'
import { type LifecycleState, SURFACE_KIN_TERMS, isFigurativeKinship } from '../../src/utils/kinship-ontology'

const NAME = "[A-Z][a-zà-ÿ'’\\-]+"
const REL = [...SURFACE_KIN_TERMS].sort((a, b) => b.length - a.length).join('|')
const ADJ = `(?:[a-zà-ÿ'’\\-]+\\s+){0,2}`
// "my" / "<Name>'s" / "your" anchor to a concrete endpoint; "your" addresses the
// protagonist the narration speaks to. his/her/their are left unanchored (skipped).
const OWNER = `(my|mine|your|${NAME}['’]s)`
const PLAYER = '__player__'
const PROTAGONIST = '__protagonist__'

/** Cue phrases per state. Word-boundary alternations; multiword allowed. */
const CUES: { state: LifecycleState; cue: string }[] = [
  { state: 'deceased', cue: 'died|dead|passed away|passed on|buried|slain|killed|perished|deceased|murdered|fell in battle|no longer living|lost to (?:us|me)' },
  { state: 'estranged', cue: 'disowned|disinherited|cast out|cast me out|cast you out|exiled|banished|estranged|cut off|renounced|abandoned|turned (?:his|her|their|my|your) back on' },
  { state: 'dissolved', cue: 'divorced|annulled|separated from|split (?:up )?(?:from|with)|left (?:him|her)|broke (?:it )?off' },
]

function resolveOwner(raw: string): string | null {
  const t = raw.trim().toLowerCase()
  if (t === 'my' || t === 'mine') return PLAYER
  if (t === 'your') return PROTAGONIST
  const poss = raw.trim().match(/^(.+)['’]s$/)
  if (poss && /^[A-ZÀ-Þ]/.test(poss[1].trim())) return poss[1].trim()
  return null
}

export interface LifecycleTransition {
  /** Whose <rel> — PLAYER, PROTAGONIST, or a name (the owner endpoint). */
  owner: string
  /** Surface kin word naming which tie of the owner transitions ("father"). */
  rel: string
  state: LifecycleState
  source: WorldFactSource
}

/** Pull lifecycle transitions out of one text fragment. */
function extractFromText(text: string, source: WorldFactSource): LifecycleTransition[] {
  const out: LifecycleTransition[] = []
  if (!text || isFigurativeKinship(text)) return out

  // STATE TRANSITIONS: an owner+rel and a cue within the same ~40-char window,
  // in either order ("my father died" / "they buried my father").
  for (const { state, cue } of CUES) {
    const relThenCue = new RegExp(`\\b${OWNER}\\s+${ADJ}(${REL})\\b[^.!?]{0,40}?\\b(?:${cue})\\b`, 'gi')
    const cueThenRel = new RegExp(`\\b(?:${cue})\\b[^.!?]{0,40}?\\b${OWNER}\\s+${ADJ}(${REL})\\b`, 'gi')
    let m: RegExpExecArray | null
    while ((m = relThenCue.exec(text))) {
      const owner = resolveOwner(m[1])
      if (owner) out.push({ owner, rel: m[2], state, source })
    }
    while ((m = cueThenRel.exec(text))) {
      const owner = resolveOwner(m[1])
      if (owner) out.push({ owner, rel: m[2], state, source })
    }
  }

  // REVEALED_FALSE: a twist retracting the tie ("not really my father", "never your
  // real mother"). The retraction must be explicit — real/true/biological qualifier
  // or "lied about" — so a plain "not my father, my uncle" correction isn't a twist.
  const reveal1 = new RegExp(`\\bnot\\s+(?:really|actually|truly)\\s+${OWNER}\\s+(?:real|true|biological|blood)?\\s*${ADJ}(${REL})\\b`, 'gi')
  const reveal2 = new RegExp(`\\bnever\\s+(?:really\\s+)?${OWNER}\\s+(?:real|true|biological|blood)\\s+${ADJ}(${REL})\\b`, 'gi')
  const reveal3 = new RegExp(`\\blied about\\s+being\\s+${OWNER}\\s+${ADJ}(${REL})\\b`, 'gi')
  for (const re of [reveal1, reveal2, reveal3]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const owner = resolveOwner(m[1])
      if (owner) out.push({ owner, rel: m[2], state: 'revealed_false', source })
    }
  }
  return out
}

export interface TransitionInput {
  corrections?: string[]
  narrationFacts?: string[]
  claims?: string[]
  prose?: string
}

/**
 * Extract lifecycle transitions from a turn's inputs, tagged by authority. A player
 * correction can retroactively re-state a tie's fate; the narrator's prose evolves
 * it as the story plays out.
 */
export function extractLifecycleTransitions(input: TransitionInput): LifecycleTransition[] {
  const out: LifecycleTransition[] = []
  const push = (texts: string[] | undefined, source: WorldFactSource) => {
    for (const t of texts || []) out.push(...extractFromText(t, source))
  }
  push(input.corrections, 'player_correction')
  push(input.narrationFacts, 'player_narration')
  push(input.claims, 'player_claim')
  push(input.prose ? [input.prose] : undefined, 'narrator')
  return out
}

export { PLAYER as TRANSITION_PLAYER, PROTAGONIST as TRANSITION_PROTAGONIST }
