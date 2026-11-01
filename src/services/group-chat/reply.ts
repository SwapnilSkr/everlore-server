import { emptyLineCounts, filterLines, parseLines } from './lines'
import type { GroupMember, GroupOrigin, NamedLine } from './types'

/** One reply's caps and duplicate checks span every attempt, including tag repair. */
export async function writeGroupReply(input: {
  members: GroupMember[]; speakers: string[]; tags: string[]; player: string; origin: GroupOrigin
  previous: NamedLine[]; openings: NamedLine[]; blocked: (text: string) => boolean
  onChecks?: (counts: ReturnType<typeof emptyLineCounts>, calls: number) => void
  write: (speakers: string[], fallback: boolean) => Promise<{ content: string; model: string }>
}) {
  const counts = emptyLineCounts()
  let calls = 0
  let model = ''
  const attempt = async (speakers: string[], fallback = false) => {
    calls++
    const response = await input.write(speakers, fallback)
    model = response.model
    return filterLines(parseLines(response.content, input.members, input.player, counts), { ...input, speakers }, counts)
  }
  try {
    let lines = await attempt(input.speakers)
    const missingTags = () => input.tags.filter(id => !lines.some(line => input.members.find(member => member.name === line.name)?.id === id))
    let tagRetried = false
    if (missingTags().length) {
      tagRetried = true
      lines = [...lines, ...await attempt(missingTags())]
    } else if (!lines.length && input.origin === 'player') lines = await attempt(input.speakers)
    if (!lines.length && input.origin === 'player') lines = await attempt(input.speakers, true)
    if (!tagRetried && missingTags().length) lines = [...lines, ...await attempt(missingTags())]
    // The initial lists were checked individually; merged replies must obey the
    // same limits and cannot repeat a line returned by a repair call.
    lines = filterLines(lines, input, counts)
    if (!lines.length || missingTags().length) throw new Error('The chat could not finish that reply. Please try again.')
    return { lines, counts, calls, model, picked_but_silent: input.speakers.filter(id => !lines.some(line => input.members.find(member => member.name === line.name)?.id === id)).length }
  } finally { input.onChecks?.(counts, calls) }
}
