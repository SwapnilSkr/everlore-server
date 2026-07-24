import { isFigurativeKinship, surfaceToKind } from '../../src/utils/kinship-ontology'

export type DetectedRelationCandidate = {
  characterName: string
  relation: string
  relationKind: NonNullable<ReturnType<typeof surfaceToKind>>['kind']
  evidence: string
}

// Concrete terms only: generic labels are useful internally but never make a
// player-facing proposal. Quoted dialogue is also stripped — an NPC claim is
// not narrator-established canon.
const TERMS = [
  'grandmother', 'grandfather', 'mother', 'father', 'sister', 'brother',
  'daughter', 'son', 'aunt', 'uncle', 'niece', 'nephew', 'cousin',
  'wife', 'husband', 'fiance', 'fiancee', 'partner',
]
const REL = TERMS.join('|')
const NAME = "[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]+(?:\\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]+){0,2}"

function narrationOnly(text: string): string {
  return String(text || '')
    .replace(/“[^”]*”|"[^"]*"|'[^']*'/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sentenceAround(text: string, index: number): string {
  const start = Math.max(0, text.lastIndexOf('.', index) + 1)
  const endAt = text.indexOf('.', index)
  return text.slice(start, endAt < 0 ? text.length : endAt + 1).trim().slice(0, 240)
}

/** Strict narrator-only evidence for a review candidate; never returns a fact. */
export function detectNarratedRelationCandidates(prose: string): DetectedRelationCandidate[] {
  const text = narrationOnly(prose)
  if (!text) return []
  const patterns = [
    // Deliberately case-sensitive: `i` would also make NAME's [A-Z] accept
    // ordinary prose such as "is there now" as a person's name.
    new RegExp(`\\b(${NAME})\\s+(?:is|was)\\s+your\\s+(${REL})\\b`, 'g'),
    new RegExp(`\\byour\\s+(${REL}),\\s+(${NAME})\\b`, 'g'),
    new RegExp(`\\b(${NAME}),\\s+your\\s+(${REL})\\b`, 'g'),
  ]
  const out: DetectedRelationCandidate[] = []
  const seen = new Set<string>()
  for (const re of patterns) {
    let match: RegExpExecArray | null
    while ((match = re.exec(text))) {
      const firstPattern = re === patterns[0]
      const name = (firstPattern ? match[1] : match[2]).trim()
      const relation = (firstPattern ? match[2] : match[1]).toLowerCase()
      const evidence = sentenceAround(text, match.index)
      if (!name || !evidence || isFigurativeKinship(evidence)) continue
      const mapped = surfaceToKind(relation)
      if (!mapped) continue
      const key = `${name.toLowerCase()}|${relation}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ characterName: name, relation, relationKind: mapped.kind, evidence })
    }
  }
  return out
}
