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
    `Messages are short, as texts are, and people respond naturally to each other and to ${input.player}.`,
    NARRATIVE_BOUNDARIES.trim(),
  ]
  const style = buildStyleBlock(input.narrative_style || '')
  if (style) parts.push(style)
  parts.push(`GLOBAL LORE:\n${input.global_lore}`, `MEMBERS:\n${members}`)
  return parts.join('\n\n')
}

export function buildGroupDynamic(input: {
  memories: string[]; summaries: string[]; history: NamedLine[]
  now: Date; offsetMinutes?: number; historyLimit?: number; messageRule?: string; speakers: string[]; situation: string
}): string {
  const parts: string[] = []
  if (input.memories.length) parts.push(`Memories:\n${input.memories.join('\n')}`)
  if (input.summaries.length) parts.push(`Summary so far:\n${input.summaries.join('\n')}`)
  parts.push(`Recent messages:\n${input.history.slice(-(input.historyLimit ?? 30)).map(line => `${line.name}: ${line.text}`).join('\n') || '(the chat opens below)'}`)
  const local = new Date(input.now.getTime() + (input.offsetMinutes || 0) * 60_000)
  const clock = new Intl.DateTimeFormat('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(local)
  parts.push(`Now:\nIt's ${clock}.\nOnly these people write in this reply: ${input.speakers.join(', ')}.\n${input.messageRule ?? "Each writes one or two short messages, and it's fine if someone only reacts in a few words."}\n${input.situation}`)
  return parts.join('\n\n')
}

export function buildAddressedStatic(input: Parameters<typeof buildGroupStatic>[0], member: GroupMember): string {
  return [buildGroupStatic({ ...input, members: [member] }),
    `You are writing only ${member.name}'s messages in this reply: one to three of them, as long as ${member.name} would really send.`,
    `How ${member.name} is about flirting and sex: ${member.group.intimacy}`,
    [`How ${member.name} really texts:`, `${input.player}'s gender isn't stated, so don't assume it.`, ...(member.group.voice || [])].join('\n'),
    `Everyone here is a consenting adult. If it's sexual, ${member.name} answers what was actually said, as explicitly and crudely as ${member.name} really would, or turns it down the way ${member.name} really would. Say something new each time, moving things on from the last message. Don't repeat or lightly reword an earlier message.`,
  ].join('\n\n')
}
