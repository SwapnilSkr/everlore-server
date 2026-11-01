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
  now: Date; offsetMinutes?: number; speakers: string[]; situation: string
}): string {
  const parts: string[] = []
  if (input.memories.length) parts.push(`Memories:\n${input.memories.join('\n')}`)
  if (input.summaries.length) parts.push(`Summary so far:\n${input.summaries.join('\n')}`)
  parts.push(`Recent messages:\n${input.history.slice(-30).map(line => `${line.name}: ${line.text}`).join('\n') || '(the chat opens below)'}`)
  const local = new Date(input.now.getTime() + (input.offsetMinutes || 0) * 60_000)
  const clock = new Intl.DateTimeFormat('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(local)
  parts.push(`Now:\nIt's ${clock}.\nOnly these people write in this reply: ${input.speakers.join(', ')}.\nEach writes one or two short messages, and it's fine if someone only reacts in a few words.\n${input.situation}`)
  return parts.join('\n\n')
}
