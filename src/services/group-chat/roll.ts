import type { GroupMember, GroupOrigin } from './types'

const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const taggedAt = (text: string, name: string) => text.search(new RegExp(`(?<![\\p{L}\\p{N}_])@${escape(name)}(?![\\p{L}\\p{N}_])`, 'iu'))
const namedAt = (text: string, name: string) => text.search(new RegExp(`(?<![@\\p{L}\\p{N}_])${escape(name)}(?![\\p{L}\\p{N}_])`, 'iu'))

export const mentionsMember = (text: string, name: string) => taggedAt(text, name) >= 0 || namedAt(text, name) >= 0

export function rollSpeakers(members: GroupMember[], silentFor: Record<string, number>, origin: GroupOrigin,
  text = '', rng: () => number = Math.random) {
  const playerText = origin === 'player' ? text : ''
  const tags = members.filter(member => taggedAt(playerText, member.name) >= 0).map(member => member.id)
  const chances = Object.fromEntries(members.map(member => [member.id,
    Math.min(1, member.group.talkativeness * 0.6 + 0.12 * (silentFor[member.id] ?? 0)) +
      (namedAt(playerText, member.name) >= 0 ? 0.5 : 0),
  ]))
  const picked = members.filter(member => tags.includes(member.id) || rng() < chances[member.id]).map(member => member.id)
  const minimum = origin === 'player' ? 1 : 2
  const rest = members.filter(member => !picked.includes(member.id)).sort((a, b) => chances[b.id] - chances[a.id])
  while (picked.length < minimum && rest.length) picked.push(rest.shift()!.id)
  return { picked: members.filter(member => picked.includes(member.id)).map(member => member.id), tags, chances }
}

export function advanceSilence(members: GroupMember[], silentFor: Record<string, number>, spoken: string[]) {
  return Object.fromEntries(members.map(member => [member.id, spoken.includes(member.id) ? 0 : (silentFor[member.id] ?? 0) + 1]))
}

/** Match positions, rather than cast order, decide who the player addressed. */
export function pickAddressed(members: GroupMember[], text: string, picked: string[]): string {
  const first = (tag: boolean) => members.map(member => ({ member, at: (tag ? taggedAt : namedAt)(text, member.name) }))
    .filter(hit => hit.at >= 0).sort((a, b) => a.at - b.at)[0]?.member.id
  return first(true) ?? first(false) ?? picked[0]
}

export function rollBystanders(picked: string[], tags: string[], addressed: string, rng: () => number): string[] {
  const others = tags.filter(id => id !== addressed)
  if (others.length) return others
  if (rng() < 0.5) return []
  const next = picked.find(id => id !== addressed)
  return next ? [next] : []
}
