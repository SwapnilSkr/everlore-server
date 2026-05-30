export interface ParsedPlayerInput {
  raw: string
  spoken: string
  narrationFacts: string[]
}

function uniq(values: string[], max: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of values) {
    const t = v.trim()
    if (!t) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
    if (out.length >= max) break
  }
  return out
}

/**
 * Deterministically split player input into:
 * - narration/action facts authored inside *...* or **...**
 * - spoken text outside those markers
 */
export function parsePlayerInput(rawInput: string): ParsedPlayerInput {
  const raw = String(rawInput || '')
  const narrationFacts: string[] = []
  const spokenParts: string[] = []

  // Accept both *...* and **...** markers, non-greedy, multiline-safe.
  const markerRe = /\*\*([\s\S]+?)\*\*|\*([\s\S]+?)\*/g
  let cursor = 0
  let m: RegExpExecArray | null

  while ((m = markerRe.exec(raw)) !== null) {
    spokenParts.push(raw.slice(cursor, m.index))
    const fact = (m[1] ?? m[2] ?? '').trim()
    if (fact) narrationFacts.push(fact)
    cursor = m.index + m[0].length
  }

  spokenParts.push(raw.slice(cursor))

  const spoken = spokenParts
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return {
    raw,
    spoken,
    narrationFacts: uniq(narrationFacts, 24),
  }
}

