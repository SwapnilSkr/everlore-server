import type { SpokenLine } from '../../models/media.model'

export const compactWhitespace = (text: string): string => text.replace(/\s/gu, '')

/** Punctuation-only scanner. Offsets deliberately use JS's UTF-16 indexing. */
export function detectSpokenLines(prose: string, playerSpoken = ''): SpokenLine[] {
  const double = /["“”]/u.test(prose)
  const openers: Record<string, string> = double ? { '"': '"', '“': '”' } : { "'": "'", '‘': '’' }
  const closers = new Set(Object.values(openers))
  const spans: Array<{ start: number; end: number }> = []
  let stack: string[] = []
  let start = -1
  let unmatched = false
  const letter = (c: string | undefined) => !!c && /\p{L}/u.test(c)
  for (let i = 0; i < prose.length; i++) {
    if (/^\r?\n[\t ]*\r?\n/u.test(prose.slice(i))) {
      if (stack.length) unmatched = true
      stack = []
      start = -1
    }
    const c = prose[i]
    if (!double && letter(prose[i - 1]) && letter(prose[i + 1])) continue
    if (stack.length && c === stack[stack.length - 1]) {
      stack.pop()
      if (!stack.length) spans.push({ start, end: i + 1 })
    } else if (openers[c]) {
      if (!stack.length) start = i
      stack.push(openers[c])
    } else if (closers.has(c)) {
      unmatched = true
    }
  }
  if (!double && (unmatched || stack.length)) return []
  const echo = compactWhitespace(playerSpoken)
  return spans.filter(({ start, end }) => {
    const text = prose.slice(start + 1, end - 1)
    const words = text.split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word))
    return words.length >= 2 && text.length <= 400 && !/\r?\n[\t ]*\r?\n/u.test(text)
      && !(echo && echo.includes(compactWhitespace(text)))
  }).map((span, i) => ({ line_id: `l${i}`, ...span }))
}

/**
 * Lasting-look evidence rule, punctuation-structure only: `evidence` counts
 * only when it is a verbatim span of the turn's prose (whitespace-normalised)
 * that covers at least one whole sentence. "A quoted sentence from the turn"
 * means a sentence copied verbatim from the turn's prose — narration or
 * dialogue — not text wrapped in dialogue quotes: "Her hair had gone white
 * overnight." in narration counts. Sentence boundaries are punctuation
 * structure (`.`, `!`, `?`, `…`, with closing quotes allowed before the
 * boundary), never a word list. A lasting change without evidence is ignored.
 */
export function isTurnEvidence(prose: string, evidence: string | undefined): boolean {
  if (!prose || !evidence || !evidence.trim()) return false
  const norm = (s: string): string => s.replace(/\s+/gu, ' ').trim()
  const flat = norm(prose)
  const needle = norm(evidence)
  if (!needle) return false
  const at = flat.indexOf(needle)
  if (at < 0) return false
  const end = at + needle.length
  // Whole-sentence spans of the prose: a sentence ends at sentence punctuation
  // (closing quotes may intervene) followed by whitespace or the end.
  const closers = new Set(['"', "'", '“', '”', '‘', '’'])
  const spans: Array<[number, number]> = []
  let start = 0
  for (let i = 0; i < flat.length; i++) {
    const c = flat[i]
    if (c !== '.' && c !== '!' && c !== '?' && c !== '…') continue
    let j = i + 1
    while (j < flat.length && closers.has(flat[j])) j++
    if (j < flat.length && !/\s/u.test(flat[j])) continue
    spans.push([start, j])
    let k = j
    while (k < flat.length && /\s/u.test(flat[k])) k++
    start = k
    i = k - 1
  }
  return spans.some(([s, e]) => at <= s && e <= end)
}
