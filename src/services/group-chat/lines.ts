import type { GroupLine, GroupMember, GroupOrigin, NamedLine } from './types'

export type LineCounts = Record<'player' | 'unknown' | 'off_list' | 'over_cap' | 'duplicate' | 'repeated_opener' | 'unsafe' | 'empty' | 'stage_directions' | 'copied_example' | 'trimmed', number>
export const emptyLineCounts = (): LineCounts => ({ player: 0, unknown: 0, off_list: 0, over_cap: 0, duplicate: 0, repeated_opener: 0, unsafe: 0, empty: 0, stage_directions: 0, copied_example: 0, trimmed: 0 })
const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()

const opener = (text: string): string | undefined => {
  const words = stripStageDirections(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
  return words.length >= 2 ? words.slice(0, 2).join(' ') : undefined
}

export function parseLines(raw: string, members: GroupMember[], player: string, counts: LineCounts): NamedLine[] {
  const names = new Map(members.map(member => [member.name.toLowerCase(), member.name]))
  const lines: NamedLine[] = []
  let current: NamedLine | undefined
  for (const source of raw.split(/\r?\n/)) {
    const text = source.trim()
    if (!text) continue
    const prefix = text.match(/^\*{0,2}([^:*\n]+?)\*{0,2}\s*:\s*(.*)$/u)
    if (prefix) {
      const key = prefix[1].trim().toLowerCase()
      const name = names.get(key)
      // Do not attach a rejected speaker's continuation to an earlier member.
      current = undefined
      if (key === player.toLowerCase()) counts.player++
      else if (!name) counts.unknown++
      else { current = { name, text: (text.startsWith('**') ? prefix[2].replace(/^\*\*/, '') : prefix[2]).trim() }; lines.push(current) }
    } else if (current) current.text = `${current.text} ${text}`.trim()
    else counts.unknown++
  }
  return lines
}

export function stripStageDirections(text: string): string {
  return text.replace(/\*[^*]*\*/g, '').replace(/^\*[^*]*$|[^*]*\*$/g, '').replace(/\*[^*]*$/g, '').replace(/\s+/g, ' ').trim()
}

// Emoji sequences are kept together, including skin tones, flags and joined glyphs.
const emoji = String.raw`(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}[\uFE0E\uFE0F]?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}[\uFE0E\uFE0F]?\p{Emoji_Modifier}?)*)`
const sentenceEnd = new RegExp(String.raw`(?:[.!?…]|${emoji})(?=\s|$)(?:\s*${emoji}(?=\s|$))*`, 'gu')

export function trimReply(text: string, tokenLimited: boolean, adult: boolean): string {
  const ends = [...text.matchAll(sentenceEnd)].map(match => match.index! + match[0].length)
  let clean = tokenLimited ? text.slice(0, ends.at(-1) ?? 0).trimEnd() : text
  if (adult && Array.from(clean).length > 280) {
    const end = ends.filter(end => Array.from(text.slice(0, end)).length <= 280).at(-1)
    if (end !== undefined) return text.slice(0, end).trimEnd()
    let prefix = ''
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(clean)) {
      if (Array.from(prefix + segment).length > 280) break
      prefix += segment
    }
    // No spaces (one long token) still obeys the hard limit without splitting a glyph.
    const boundary = prefix.search(/\s+\S*$/u)
    clean = boundary >= 0 ? prefix.slice(0, boundary) : prefix
  }
  return clean
}

export function filterLines(input: NamedLine[], options: {
  members: GroupMember[]; speakers: string[]; origin: GroupOrigin
  previous: NamedLine[]; openings: NamedLine[]
  blocked: (text: string) => boolean
  player?: string; onCopiedExample?: (example: string) => void
  addressed?: string; repeatedOpener?: boolean; oneMessage?: boolean; finishReason?: string | null
}, counts: LineCounts): NamedLine[] {
  const kept: NamedLine[] = []
  const used = new Map<string, number>()
  for (const source of input) {
    const line = { ...source }
    const member = options.members.find(member => member.name === line.name)
    if (!member || !options.speakers.includes(member.id)) { counts.off_list++; continue }
    const clean = stripStageDirections(line.text)
    if (line.text.includes('*') && clean !== line.text.trim()) counts.stage_directions++
    const withoutTag = options.player ? clean.replace(new RegExp(`^@${options.player.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])[,\\s]*`, 'iu'), '') : clean
    line.text = trimReply(withoutTag, options.finishReason === 'length' && source === input.at(-1), !!options.addressed)
    if (line.text !== withoutTag) counts.trimmed++
    if (!line.text.trim()) { counts.empty++; continue }
    if (options.blocked(line.text)) { counts.unsafe++; continue }
    if (member.group.voice?.some(example => {
      const copied = normalized(stripStageDirections(example)) === normalized(line.text)
      if (copied) options.onCopiedExample?.(example)
      return copied
    })) { counts.copied_example++; continue }
    const previous = options.previous.filter(other => other.name === line.name).slice(-5)
    const duplicates = [...previous, ...options.openings.filter(other => other.name === line.name), ...kept.filter(other => other.name === line.name)]
    if (duplicates.some(other => normalized(other.text) === normalized(line.text))) { counts.duplicate++; continue }
    const firstWords = opener(line.text)
    if (options.repeatedOpener && member.id === options.addressed && firstWords !== undefined
      && [...previous, ...kept.filter(other => other.name === line.name)].slice(-3).some(other => opener(other.text) === firstWords)) { counts.repeated_opener++; continue }
    if ((used.get(line.name) ?? 0) >= (options.oneMessage ? 1 : member.id === options.addressed ? 3 : 2) || (options.origin === 'catchup' && kept.length >= 4)) { counts.over_cap++; continue }
    used.set(line.name, (used.get(line.name) ?? 0) + 1)
    kept.push(line)
  }
  return kept
}

export function timeLines(lines: NamedLine[], members: GroupMember[], now: Date, gapStart?: Date,
  rng: () => number = Math.random): GroupLine[] {
  let at = now.getTime()
  return lines.map((line, index) => {
    if (gapStart && gapStart < now) at = gapStart.getTime() + (now.getTime() - gapStart.getTime()) * (index + 1) / (lines.length + 1)
    else if (index) at += 1500 + Math.floor(rng() * 2501)
    return { character_id: members.find(member => member.name === line.name)!.id, text: line.text, shown_at: new Date(at) }
  })
}
