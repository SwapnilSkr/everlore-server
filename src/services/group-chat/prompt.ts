import { GROUP_ACTION_RULE } from './actions'
import { sceneVoiceLines } from './lines'
import { NARRATIVE_BOUNDARIES } from '../../utils/prompt-builder'
import { buildStyleBlock } from '../../utils/narrative-styles'
import type { GroupMember, NamedLine } from './types'

export function buildGroupStatic(input: {
  seed_prompt: string; global_lore: string; narrative_style?: string
  members: GroupMember[]; player: string
}): string {
  const members = input.members.map(member =>
    `- ${member.name} — ${member.role || ''}, age ${member.group.age}\n  persona: ${member.persona || ''}\n  speech: ${member.group.speech}\n  wants: ${member.group.wants}`).join('\n')
  const parts = [
    input.seed_prompt,
    `You write this group chat's next messages, as its members. You are not a narrator: there is no prose, only the messages people send. Write each message on its own line as \`Name: message\`, using exactly these names: ${input.members.map(member => member.name).join(', ')}. Never write a message from ${input.player}, and never describe what they do or feel.`,
    `${input.player}'s gender isn't stated: use their name, "you" or "they", never he or she. Never comment on this.`,
    `Messages are short, as texts are, and people respond naturally to each other and to ${input.player}.`,
    NARRATIVE_BOUNDARIES.trim(),
  ]
  const style = buildStyleBlock(input.narrative_style || '')
  if (style) parts.push(style)
  parts.push(`GLOBAL LORE:\n${input.global_lore}`, `MEMBERS:\n${members}`)
  return parts.join('\n\n')
}

// Proven live: at trust and affection 90, bare meters lost to a character's written reluctance.
const closeToPlayer = (member: GroupMember) => {
  const bond = member.relationship
  return !!bond && bond.trust >= 70 && bond.affection >= 60 && bond.fear < 70
}

export function buildGroupDynamic(input: {
  memories: string[]; openThreads?: string[]; summaries: string[]; history: NamedLine[]
  groupContext?: NamedLine[]
  now: Date; offsetMinutes?: number; historyLimit?: number; messageRule?: string; speakers: string[]; situation: string
  bonds?: GroupMember[]
  actionPresent?: boolean
  sceneRule?: string; askedRule?: string
  notToldAbout?: string[]
  /** The directly-addressed member's written status for now, so the reply doesn't
   *  contradict the status shown beside their name. */
  status?: { name: string; text: string }
}): string {
  const parts: string[] = []
  if (input.actionPresent || input.history.slice(-(input.historyLimit ?? 30)).some(line => line.player_action) || input.groupContext?.some(line => line.player_action)) parts.push(GROUP_ACTION_RULE)
  if (input.bonds?.length) parts.push(`Bonds toward the player (never mention numbers):\n${input.bonds.filter(member => input.speakers.includes(member.name)).map(member => `${member.name}: ${JSON.stringify(member.relationship)}${(member.relationship?.fear ?? 0) >= 70 ? " — scared of the player and doesn't want anything sexual with them. Never agrees to sex because of fear." : ''}`).join('\n')}`)
  if (input.memories.length) parts.push(`Memories:\n${input.memories.join('\n')}`)
  if (input.openThreads?.length) parts.push(`Open threads:\n${input.openThreads.join('\n')}`)
  if (input.summaries.length) parts.push(`Summary so far:\n${input.summaries.join('\n')}`)
  // Proven live: last in the prompt, this block was answered as if it were the conversation.
  if (input.groupContext) parts.push(`Group chat (read-only; everyone saw these messages):\n${input.groupContext.map(line => `${line.name}: ${line.text}`).join('\n') || '(no group messages)'}`)
  parts.push(`Recent messages:\n${input.history.slice(-(input.historyLimit ?? 30)).map(line => `${line.name}: ${line.text}`).join('\n') || '(the chat opens below)'}`)
  const local = new Date(input.now.getTime() + (input.offsetMinutes || 0) * 60_000)
  const clock = new Intl.DateTimeFormat('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(local)
  const notTold = input.notToldAbout?.length ? `\nNobody has told ${input.speakers.join(' or ')} anything about this: ${input.notToldAbout.join(', ')}. They don't know, so they ask what's meant or say they've no idea, and never supply an answer.` : ''
  const close = (input.bonds || []).filter(member => input.speakers.includes(member.name) && closeToPlayer(member))
    .map(member => `\n${member.name} is close to the player now. If it's sexual, whatever held ${member.name} back no longer does: they want this, say yes and say exactly what they want.`).join('')
  const status = input.status ? `\n${input.status.name}'s status right now says: "${input.status.text}".` : ''
  parts.push(`Now:\nIt's ${clock}.\nOnly these people write in this reply: ${input.speakers.join(', ')}.\n${input.messageRule ?? "Each writes one or two short messages, and it's fine if someone only reacts in a few words."}${notTold}${close}${status}${input.askedRule ? `\n${input.askedRule}` : ''}${input.sceneRule ? `\n${input.sceneRule}` : ''}\n${input.situation}`)
  return parts.join('\n\n')
}

export function buildAddressedStatic(input: Parameters<typeof buildGroupStatic>[0], member: GroupMember, excludedVoice: string[] = []): string {
  return [buildGroupStatic({ ...input, members: [member] }),
    `You are writing only ${member.name}'s messages in this reply: one to three of them, as long as ${member.name} would really send.`,
    `How ${member.name} is about flirting and sex: ${member.group.intimacy?.replaceAll('{player}', () => input.player)}`,
    [`How ${member.name} really texts:`, `In these messages "I" is ${member.name} and "you" is ${input.player}. Keep straight who is doing what to whom.`, ...(member.group.voice || []).filter(example => !excludedVoice.includes(example))].join('\n'),
    `Everyone here is a consenting adult. If it's sexual, ${member.name} answers what was actually said in plain, crude words, as explicitly and crudely as ${member.name} really would: naming what ${member.name} wants done and will do, without putting it off or changing the subject. At least one message says the act itself: what goes where, in plain crude words. Saying yes, teasing, setting a time or asking what ${input.player} would do is never enough alone: ${member.name} says exactly what they want done in the same reply. Low trust and affection mean they start wary or teasing and usually warm up within the scene. A dry, shy or unimpressed manner changes how they say it, never whether they say it: the act still gets named, in that same voice. If ${input.player} has already done something sexual, it's happening: ${member.name} answers from inside it and says what they want done next. A flat no is rare, only when the persona truly fits and the bond is low. Say something new each time, moving things on from the last message. Don't repeat or lightly reword an earlier message.`,
  ].join('\n\n')
}

// Measured blind: rules alone left characters indistinguishable, and "own voice" wording didn't help;
// their own lines next to the turn did. Longest first, because short examples are small talk and get sent whole.
export function sceneExamples(member: GroupMember, seen: number, excluded: string[] = [], lastOwn?: string): string[] {
  const longest = sceneVoiceLines(member.group.voice).filter(example => !excluded.includes(example))
  // Proven live: a numbered reply plus a numbered example made every later reply a list.
  const form = (text: string) => (text.trim().split(/\s+/)[0] || '').toLowerCase().replace(/\d+/, '#')
  const different = longest.filter(example => lastOwn === undefined || form(example) !== form(lastOwn))
  const pool = different.length ? different : longest
  return [...new Set([pool[seen % pool.length], pool[(seen + 1) % pool.length]])].filter(Boolean)
}

export function buildDirectStatic(system: string, member: GroupMember, player: string): string {
  return `${system}\n\nThis is a private conversation between ${player} and ${member.name}. Only these two can see it. Only ${member.name} writes a reply, in one to three messages. Recent messages are this private conversation. The group chat block is read-only context from a separate conversation: nothing in it was said here, and each line there was said by the person named.`
}
