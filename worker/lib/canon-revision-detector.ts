/**
 * Conservative, narrator-only detector for canon-review candidates.
 *
 * This deliberately does not mutate anything. The codex extractor still owns
 * clear, direct alias resolution; these patterns are the safety net when a
 * smaller model misses a reveal or when two previously-created cards make a
 * silent merge unsafe. Every result carries an exact sentence from narration
 * and must resolve to existing cards before it can reach the player.
 */

export type CanonRevisionDetection =
  | {
      kind: 'identity_rename' | 'identity_merge'
      characterName: string
      counterpartCharacterName?: string
      proposedName: string
      evidence: string
    }
  | {
      kind: 'kinship_revision'
      characterName: string
      relation: string
      evidence: string
    }

type RosterCharacter = { canonical_name: string; aliases?: string[] }

const RELATIONS = [
  'grandmother', 'grandfather', 'mother', 'father', 'sister', 'brother',
  'daughter', 'son', 'aunt', 'uncle', 'niece', 'nephew', 'cousin',
  'wife', 'husband', 'fiance', 'fiancee', 'partner',
]

const PROPER_NAME = "[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]+(?:\\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]+){0,2}"

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
}

function narrationOnly(text: string): string {
  return String(text || '')
    .replace(/“[^”]*”|"[^"]*"|'[^']*'/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sentenceAround(text: string, index: number): string {
  const start = Math.max(0, text.lastIndexOf('.', index) + 1)
  const end = text.indexOf('.', index)
  return text.slice(start, end < 0 ? text.length : end + 1).trim().slice(0, 240)
}

/** Candidates only; caller resolves names to cards/entities and persists them. */
export function detectCanonRevisionCandidates(
  prose: string,
  roster: RosterCharacter[],
): CanonRevisionDetection[] {
  const text = narrationOnly(prose)
  if (!text || !roster.length) return []

  const names = new Map<string, string>()
  for (const card of roster) {
    for (const name of [card.canonical_name, ...(card.aliases || [])]) {
      const key = normalized(name)
      if (key && !names.has(key)) names.set(key, card.canonical_name)
    }
  }
  const resolve = (raw: string) => names.get(normalized(raw))
  const out: CanonRevisionDetection[] = []
  const seen = new Set<string>()
  const push = (candidate: CanonRevisionDetection) => {
    const key = candidate.kind === 'kinship_revision'
      ? `${candidate.kind}|${normalized(candidate.characterName)}|${candidate.relation}`
      : `${candidate.kind}|${normalized(candidate.characterName)}|${normalized(candidate.proposedName)}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(candidate)
    }
  }

  // “Father's real name was John” — source must already be a tracked identity.
  for (const card of roster) {
    for (const referent of [card.canonical_name, ...(card.aliases || [])]) {
      if (!referent || referent.length < 3) continue
      const re = new RegExp(
        `\\b${escapeRegex(referent)}(?:'s|’s)\\s+(?:real\\s+)?name\\s+(?:was|is)\\s+(${PROPER_NAME})\\b`,
        'g',
      )
      let match: RegExpExecArray | null
      while ((match = re.exec(text))) {
        const proposedName = match[1].trim()
        const counterpart = resolve(proposedName)
        if (counterpart === card.canonical_name) continue
        push({
          kind: counterpart ? 'identity_merge' : 'identity_rename',
          characterName: card.canonical_name,
          ...(counterpart ? { counterpartCharacterName: counterpart } : {}),
          proposedName,
          evidence: sentenceAround(text, match.index),
        })
      }
    }
  }

  // “John, your father” / “John was your father” when “Father” already has a
  // card. This is a likely identity reveal, not a fresh kinship assertion.
  const rel = RELATIONS.join('|')
  const relationPatterns = [
    new RegExp(`\\b(${PROPER_NAME}),\\s+your\\s+(${rel})\\b`, 'g'),
    new RegExp(`\\b(${PROPER_NAME})\\s+(?:is|was)\\s+your\\s+(${rel})\\b`, 'g'),
  ]
  for (const re of relationPatterns) {
    let match: RegExpExecArray | null
    while ((match = re.exec(text))) {
      const proposedName = match[1].trim()
      const roleCard = resolve(match[2])
      if (!roleCard || resolve(proposedName) === roleCard) continue
      const counterpart = resolve(proposedName)
      push({
        kind: counterpart ? 'identity_merge' : 'identity_rename',
        characterName: roleCard,
        ...(counterpart ? { counterpartCharacterName: counterpart } : {}),
        proposedName,
        evidence: sentenceAround(text, match.index),
      })
    }
  }

  // “John was never really your father.” This must be explicitly phrased and
  // attached to an existing character. It becomes a confirmable retcon, never
  // a silent structural graph mutation.
  for (const card of roster) {
    for (const referent of [card.canonical_name, ...(card.aliases || [])]) {
      if (!referent || referent.length < 3) continue
      const re = new RegExp(
        `\\b${escapeRegex(referent)}\\s+(?:was|is)\\s+(?:(?:never\\s+)?not\\s+(?:really\\s+|actually\\s+|truly\\s+)?your|never\\s+(?:really\\s+|actually\\s+|truly\\s+)?your)\\s+(?:real\\s+|true\\s+|biological\\s+|blood\\s+)?(${rel})\\b`,
        'gi',
      )
      let match: RegExpExecArray | null
      while ((match = re.exec(text))) {
        push({
          kind: 'kinship_revision',
          characterName: card.canonical_name,
          relation: match[1].toLowerCase(),
          evidence: sentenceAround(text, match.index),
        })
      }
    }
  }
  return out.slice(0, 4)
}
