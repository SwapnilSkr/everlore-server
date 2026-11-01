import type { GroupMember, GroupOrigin } from './types'

const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const tagged = (text: string, name: string) => new RegExp(`(?<![\\p{L}\\p{N}_])@${escape(name)}(?![\\p{L}\\p{N}_])`, 'iu').test(text)
const named = (text: string, name: string) => new RegExp(`(?<![@\\p{L}\\p{N}_])${escape(name)}(?![\\p{L}\\p{N}_])`, 'iu').test(text)

export function rollSpeakers(members: GroupMember[], silentFor: Record<string, number>, origin: GroupOrigin,
  text = '', rng: () => number = Math.random) {
  const playerText = origin === 'player' ? text : ''
  const tags = members.filter(member => tagged(playerText, member.name)).map(member => member.id)
  const chances = Object.fromEntries(members.map(member => [member.id,
    Math.min(1, member.group.talkativeness * 0.6 + 0.12 * (silentFor[member.id] ?? 0)) +
      (named(playerText, member.name) ? 0.5 : 0),
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
