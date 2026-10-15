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
