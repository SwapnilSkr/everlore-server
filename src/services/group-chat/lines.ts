import type { GroupLine, GroupMember, GroupOrigin, NamedLine } from './types'

export type LineCounts = Record<'player' | 'unknown' | 'off_list' | 'over_cap' | 'duplicate' | 'unsafe' | 'empty', number>
export const emptyLineCounts = (): LineCounts => ({ player: 0, unknown: 0, off_list: 0, over_cap: 0, duplicate: 0, unsafe: 0, empty: 0 })
const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()

export function parseLines(raw: string, members: GroupMember[], player: string, counts: LineCounts): NamedLine[] {
  const names = new Map(members.map(member => [member.name.toLowerCase(), member.name]))
  const lines: NamedLine[] = []
  let current: NamedLine | undefined
  for (const source of raw.split(/\r?\n/)) {
    const text = source.trim()
    if (!text) continue
    const prefix = text.match(/^\*{0,2}([^:*\n]+?)\*{0,2}\s*:\s*\*{0,2}\s*(.*)$/u)
    if (prefix) {
      const key = prefix[1].trim().toLowerCase()
      const name = names.get(key)
      // Do not attach a rejected speaker's continuation to an earlier member.
      current = undefined
      if (key === player.toLowerCase()) counts.player++
      else if (!name) counts.unknown++
      else { current = { name, text: prefix[2].trim() }; lines.push(current) }
    } else if (current) current.text = `${current.text} ${text}`.trim()
    else counts.unknown++
  }
  return lines
}

export function filterLines(input: NamedLine[], options: {
  members: GroupMember[]; speakers: string[]; origin: GroupOrigin
  previous: NamedLine[]; openings: NamedLine[]
  blocked: (text: string) => boolean
}, counts: LineCounts): NamedLine[] {
  const kept: NamedLine[] = []
  const used = new Map<string, number>()
  for (const line of input) {
    const member = options.members.find(member => member.name === line.name)
    if (!member || !options.speakers.includes(member.id)) { counts.off_list++; continue }
    if (!line.text.trim()) { counts.empty++; continue }
    if (options.blocked(line.text)) { counts.unsafe++; continue }
    const previous = options.previous.filter(other => other.name === line.name).slice(-5)
    const duplicates = [...previous, ...options.openings.filter(other => other.name === line.name), ...kept.filter(other => other.name === line.name)]
    if (duplicates.some(other => normalized(other.text) === normalized(line.text))) { counts.duplicate++; continue }
    if ((used.get(line.name) ?? 0) >= 2 || (options.origin === 'catchup' && kept.length >= 4)) { counts.over_cap++; continue }
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
