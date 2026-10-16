/** Positional dialogue evidence, shared by presence and card promotion. */
export interface SpeechAttribution {
  quote: string
  subject: string
  pronoun: boolean
  /** The adjacent narration, including the predicate's punctuation. */
  tag: string
  quoteStart: number
  quoteEnd: number
}

const PROPER_NAME = "[A-Z][a-z]+(?:['’-][A-Za-z]+)*(?:[ \\t]+[A-Z][a-z]+(?:['’-][A-Za-z]+)*){0,2}"
const SUBJECT = `(?:[Hh]e|[Ss]he|[Tt]hey|${PROPER_NAME})`
const PRONOUN = /^(?:he|she|they)$/i
// These are grammatical subjects/determiners, not a vocabulary of actions.
const NON_PREDICATE = /^(?:he|she|they|it|we|you|i|his|her|their|its|our|your|my|the|a|an|who|whom|whose|which|that)\b/i

function plain(text: string): string {
  return text.replace(/[*_]/g, '')
}

function leadingSubject(clause: string): { subject: string; tag: string } | null {
  const tag = plain(clause).trim()
  const match = tag.match(new RegExp(`^(${SUBJECT})[ \\t]+([a-z][a-z'’_-]*)\\b`))
  if (!match || NON_PREDICATE.test(match[2])) return null
  return { subject: match[1], tag }
}

/** A tag must touch a quotation boundary. Names inside speech are never tags. */
export function speechAttributions(prose: string): SpeechAttribution[] {
  const text = String(prose || '')
  const out: SpeechAttribution[] = []
  for (const match of text.matchAll(/[“"]([^”"\n]{1,600})[”"]/g)) {
    const quoteStart = match.index!
    const quoteEnd = quoteStart + match[0].length
    const after = text.slice(quoteEnd).match(/^[ \t]*,?[ \t]*([^\n“"]{1,240})/)
    const following = after && /[,;:.!?…]\s*$/.test(match[1])
      ? leadingSubject(after[1])
      : null
    if (following) {
      out.push({ quote: match[1], ...following, pronoun: PRONOUN.test(following.subject), quoteStart, quoteEnd })
      continue
    }
    // Before a quote, the clause must end in the comma/colon introducing it.
    const before = plain(text.slice(0, quoteStart)).match(/(?:^|[.!?…;\n])\s*([^.!?…;\n]{1,240}[,:])\s*$/)
    const preceding = before ? leadingSubject(before[1]) : null
    if (preceding) out.push({ quote: match[1], ...preceding, pronoun: PRONOUN.test(preceding.subject), quoteStart, quoteEnd })
  }
  return out
}

/** A compact pronoun-tagged naming answer, never a vocative to a known card. */
export function hasAttributedSelfName(name: string, prose: string, knownCards: readonly string[] = []): boolean {
  const key = name.trim().toLowerCase()
  if (!new RegExp(`^${PROPER_NAME}$`).test(name.trim())) return false
  if (knownCards.some((known) => known.trim().toLowerCase() === key)) return false
  return speechAttributions(prose).some((speech) => {
    if (!speech.pronoun) return false
    const content = speech.quote.trim()
    const named = content.replace(/[,.;!?…]+$/, '').trim()
    if (named.toLowerCase() !== key) return false
    // A shouted name followed by an uninterrupted tag complement is address:
    // “Mara!” he calls toward the ridge. A compact naming tag ends its
    // predicate at punctuation, before any description of the speaker's voice.
    return /^(?:he|she|they)\s+[a-z][a-z'’-]*(?=\s*[,.;:!?…]|\s*$)/i.test(speech.tag)
  })
}

/** Subject position is evidence even for predicates no vocabulary has seen. */
export function hasNameLedPredicate(name: string, prose: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const narration = plain(prose).replace(/[“"]([^”"]{0,600})[”"]/g, ' ')
  const re = new RegExp(`(?:^|[.!?…;:\\n]|,)[ \\t]*(?:[A-Z][a-z]+[ \\t]+)?${escaped}[ \\t]+([a-z][a-z'’-]*)\\b`, 'g')
  return [...narration.matchAll(re)].some((match) => {
    if (NON_PREDICATE.test(match[1])) return false
    const predicate = narration.slice(match.index! + match[0].length - match[1].length)
    return !/^(?:(?:is|was|are|were|has|had|have|not|still)\s+)*(?:out|down|over|back|up|in|off|across)\s+there\b/i.test(predicate)
  })
}

/** Pronoun tags can refer back to the immediately preceding named subject.
 * A quoted remembered/addressed name cannot become that subject. */
export function hasAttributedSpeech(name: string, prose: string): boolean {
  const key = name.trim().toLowerCase()
  return speechAttributions(prose).some((speech) => {
    if (!speech.pronoun) return speech.subject.toLowerCase() === key
    if (hasAttributedSelfName(name, prose)) return true
    const prefix = prose.slice(0, speech.quoteStart)
    const beat = prefix.split(/[.!?\n]/).filter((span) => span.trim()).at(-1) || ''
    return hasNameLedPredicate(name, beat)
  })
}
