import type { RelationshipMeters } from '../models/character-profile.model'

export type RelationshipInitializationKind =
  | 'best_friend'
  | 'close_friend'
  | 'friend'
  | 'acquaintance'
  | 'trusted_ally'
  | 'reluctant_ally'
  | 'mentor_bond'
  | 'protector'
  | 'dependent'
  | 'romantic_partner'
  | 'unrequited_attraction'
  | 'ex_partner'
  | 'family_warm'
  | 'family_protective'
  | 'family_strained'
  | 'estranged'
  | 'sibling_close'
  | 'sibling_resentful'
  | 'enemy'
  | 'sworn_enemy'
  | 'fearful'
  | 'rival'
  | 'indebted'
  | 'betrayed'
  | 'authority_trust'

export type RelationshipInitialization = {
  kind: RelationshipInitializationKind
  /** Exact source wording that established the starting relationship. */
  evidence: string
}

/** Open-ended codex context for the bond. Unlike the numeric initialization
 * kind, this is the human meaning of the relationship and may be nuanced. */
export type RelationshipState = {
  summary: string
  evidence: string
  tags?: string[]
}

const BASELINES: Record<RelationshipInitializationKind, RelationshipMeters> = {
  best_friend: { trust: 85, affection: 70, fear: 0, rivalry: 5 },
  close_friend: { trust: 75, affection: 60, fear: 0, rivalry: 5 },
  friend: { trust: 65, affection: 35, fear: 0, rivalry: 5 },
  acquaintance: { trust: 55, affection: 10, fear: 0, rivalry: 0 },
  trusted_ally: { trust: 75, affection: 25, fear: 0, rivalry: 15 },
  reluctant_ally: { trust: 45, affection: 10, fear: 10, rivalry: 30 },
  mentor_bond: { trust: 70, affection: 20, fear: 5, rivalry: 5 },
  protector: { trust: 70, affection: 25, fear: 10, rivalry: 5 },
  dependent: { trust: 45, affection: 25, fear: 15, rivalry: 5 },
  romantic_partner: { trust: 80, affection: 80, fear: 0, rivalry: 5 },
  unrequited_attraction: { trust: 60, affection: 65, fear: 5, rivalry: 10 },
  ex_partner: { trust: 35, affection: 35, fear: 5, rivalry: 20 },
  family_warm: { trust: 75, affection: 55, fear: 0, rivalry: 5 },
  family_protective: { trust: 70, affection: 45, fear: 5, rivalry: 5 },
  family_strained: { trust: 35, affection: 20, fear: 10, rivalry: 20 },
  estranged: { trust: 25, affection: 10, fear: 10, rivalry: 25 },
  sibling_close: { trust: 70, affection: 50, fear: 0, rivalry: 15 },
  sibling_resentful: { trust: 35, affection: 15, fear: 5, rivalry: 45 },
  enemy: { trust: 10, affection: 0, fear: 20, rivalry: 75 },
  sworn_enemy: { trust: 5, affection: 0, fear: 25, rivalry: 90 },
  fearful: { trust: 20, affection: 0, fear: 65, rivalry: 20 },
  rival: { trust: 35, affection: 10, fear: 5, rivalry: 65 },
  indebted: { trust: 55, affection: 20, fear: 0, rivalry: 5 },
  betrayed: { trust: 15, affection: 5, fear: 15, rivalry: 40 },
  authority_trust: { trust: 60, affection: 15, fear: 10, rivalry: 5 },
}

const CUES: Array<[RelationshipInitializationKind, RegExp]> = [
  ['best_friend', /\b(?:best|lifelong|oldest)\s+friend\b/i],
  ['close_friend', /\b(?:best|close|childhood)\s+friend\b/i],
  ['trusted_ally', /\b(?:trusted\s+ally|staunch\s+ally|my\s+ally)\b/i],
  ['reluctant_ally', /\b(?:reluctant\s+ally|uneasy\s+all(?:y|ies)|allies\s+of\s+necessity)\b/i],
  ['mentor_bond', /\b(?:trusted\s+mentor|my\s+mentor|teacher|tutor)\b/i],
  ['protector', /\b(?:protector|bodyguard|sworn\s+to\s+protect)\b/i],
  ['dependent', /\b(?:depends?\s+on\s+(?:you|the\s+player)|reli(?:es|ant)\s+on\s+(?:you|the\s+player))\b/i],
  ['romantic_partner', /\b(?:wife|husband|spouse|partner|lover|girlfriend|boyfriend|fianc(?:e|é)|dating)\b/i],
  ['unrequited_attraction', /\b(?:secretly\s+in\s+love|unrequited|pines?\s+for)\b/i],
  ['ex_partner', /\b(?:ex[-\s]?(?:partner|wife|husband|lover|girlfriend|boyfriend))\b/i],
  ['estranged', /\b(?:estranged|disowned|no\s+contact)\b/i],
  ['family_protective', /\b(?:protective\s+(?:father|mother|parent|sibling|brother|sister)|overprotective)\b/i],
  ['family_strained', /\b(?:detached|distant|strained|cold|abusive|neglect(?:s|ed|ful)?|unseen|ignores?|dismiss(?:es|ed)|treats?\s+(?:you|the\s+player)\s+like\s+a\s+stranger)\b/i],
  ['sibling_close', /\b(?:close\s+(?:brother|sister|sibling)|inseparable\s+(?:brother|sister|siblings))\b/i],
  ['sibling_resentful', /\b(?:resentful\s+(?:brother|sister|sibling)|jealous\s+(?:brother|sister|sibling))\b/i],
  ['sworn_enemy', /\b(?:sworn\s+(?:enemy|foe)|nemesis)\b/i],
  ['enemy', /\benemy\b/i],
  ['fearful', /\b(?:terrified|afraid|fearful|scared\s+of)\b/i],
  ['rival', /\b(?:rival|competitor)\b/i],
  ['indebted', /\b(?:owes?\s+(?:you|the\s+player)|in\s+(?:your|the\s+player(?:'s)?)\s+debt)\b/i],
  ['betrayed', /\b(?:betrayed\s+(?:you|the\s+player)|your\s+betrayer)\b/i],
  ['authority_trust', /\b(?:trusted\s+(?:mentor|guardian|protector)|mentor|guardian|protector)\b/i],
  ['family_warm', /\b(?:loving|supportive|caring|ador(?:e|ed|ing))\b/i],
  ['friend', /\bfriend\b/i],
  ['acquaintance', /\b(?:acquaintance|someone\s+you\s+know)\b/i],
]

export function relationshipBaseline(kind: RelationshipInitializationKind): RelationshipMeters {
  return { ...BASELINES[kind] }
}

function compact(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function relationshipInitializationFromEvidence(
  raw: unknown,
  sourceText: string,
): RelationshipInitialization | undefined {
  const kind = typeof (raw as any)?.kind === 'string' ? (raw as any).kind as RelationshipInitializationKind : null
  const evidence = compact(typeof (raw as any)?.evidence === 'string' ? (raw as any).evidence : '')
  if (!kind || !(kind in BASELINES) || evidence.length < 4) return undefined
  if (!compact(sourceText).toLowerCase().includes(evidence.toLowerCase())) return undefined
  const cue = CUES.find(([candidate]) => candidate === kind)?.[1]
  if (!cue || !cue.test(evidence)) return undefined
  return { kind, evidence: evidence.slice(0, 180) }
}

export function relationshipStateFromEvidence(raw: unknown, sourceText: string): RelationshipState | undefined {
  const summary = compact(typeof (raw as any)?.summary === 'string' ? (raw as any).summary : '')
  const evidence = compact(typeof (raw as any)?.evidence === 'string' ? (raw as any).evidence : '')
  if (summary.length < 12 || summary.length > 320 || evidence.length < 4) return undefined
  if (!compact(sourceText).toLowerCase().includes(evidence.toLowerCase())) return undefined
  const tags: string[] = []
  const rawTags: unknown[] = Array.isArray((raw as any)?.tags) ? (raw as any).tags : []
  for (const rawTag of rawTags) {
    if (typeof rawTag !== 'string') continue
    const tag = compact(rawTag).toLowerCase().slice(0, 40)
    if (!/^[a-z][a-z -]{1,39}$/.test(tag) || tags.includes(tag)) continue
    tags.push(tag)
    if (tags.length >= 5) break
  }
  return { summary, evidence: evidence.slice(0, 180), ...(tags.length ? { tags } : {}) }
}

/** Conservative backfill detector: only explicit canon wording earns a profile. */
export function detectRelationshipInitialization(sourceText: string): RelationshipInitialization | undefined {
  const text = compact(sourceText)
  for (const [kind, cue] of CUES) {
    const match = text.match(cue)
    if (match) return { kind, evidence: match[0] }
  }
  return undefined
}
