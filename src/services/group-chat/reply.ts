import { emptyLineCounts, filterLines, parseLines } from './lines'
import { rollBystanders } from './roll'
import type { GroupMember, GroupOrigin, NamedLine } from './types'

export interface GroupWritingRequest {
  writer: 'adult' | 'normal'
  purpose: 'reply' | 'addressed' | 'addressed_retry' | 'addressed_fallback' | 'bystander' | 'tag_repair' | 'tag_backup'
  index: number
  history: NamedLine[]
  excludedVoice: string[]
}

/** One reply's caps and duplicate checks span every attempt, including tag repair. */
export async function writeGroupReply(input: {
  members: GroupMember[]; speakers: string[]; tags: string[]; player: string; origin: GroupOrigin
  previous: NamedLine[]; openings: NamedLine[]; blocked: (text: string) => boolean
  adult?: { addressed: string; rng: () => number }
  onChecks?: (counts: ReturnType<typeof emptyLineCounts>, calls: number) => void
  write: (speakers: string[], fallback: boolean, request: GroupWritingRequest) => Promise<{
    content: string; model: string; writer?: 'adult' | 'normal'; nextIndex?: number; finishReason?: string | null
  }>
}) {
  const counts = emptyLineCounts()
  let calls = 0
  let model = '', adultModel = ''
  let lines: NamedLine[] = []
  const addressed = input.adult?.addressed
  const speakers = [...new Set([...input.speakers, ...(addressed ? [addressed] : [])])]
  const options = { ...input, speakers, addressed }
  const copiedVoice = new Set<string>()
  let sameIndex = 0
  const attempt = async (picked: string[], purpose: GroupWritingRequest['purpose'] = 'reply', index = 0, writer: GroupWritingRequest['writer'] = 'normal') => {
    calls++
    sameIndex = index
    try {
      const response = await input.write(picked, index > 0, { writer, purpose, index, history: [...lines], excludedVoice: [...copiedVoice] })
      sameIndex = (response.nextIndex ?? index + 1) - 1
      model = response.model
      if (response.writer === 'adult') adultModel = response.model
      const checked = filterLines(parseLines(response.content, input.members, input.player, counts), {
        ...options, repeatedOpener: response.writer === 'adult' && addressed !== undefined && picked.includes(addressed), onCopiedExample: example => copiedVoice.add(example), finishReason: response.finishReason, speakers: picked, previous: [...input.previous, ...lines], oneMessage: purpose === 'bystander' || (!!addressed && !picked.includes(addressed)),
      }, counts)
      lines = filterLines([...lines, ...checked], options, counts)
      return response.nextIndex ?? index + 1
    } catch {
      // A failed optional speaker must not discard another person's fresh reply.
      return index + 1
    }
  }
  const missingTags = () => input.tags.filter(id => !lines.some(line => input.members.find(member => member.name === line.name)?.id === id))
  try {
    if (input.adult) {
      let next = await attempt([input.adult.addressed], 'addressed', 0, 'adult')
      if (!lines.length) next = await attempt([input.adult.addressed], 'addressed_retry', sameIndex, 'adult')
      if (!lines.length) await attempt([input.adult.addressed], 'addressed_retry', next, 'adult')
      if (!lines.length) await attempt([input.adult.addressed], 'addressed_fallback')
      if (!lines.length && input.origin === 'player') await attempt([input.adult.addressed], 'addressed_fallback', 1)
      const others = rollBystanders(input.speakers, input.tags, input.adult.addressed, input.adult.rng)
      if (others.length) await attempt(others, 'bystander')
    } else {
      await attempt(input.speakers)
      if (!lines.length && !missingTags().length && input.origin === 'player') await attempt(input.speakers)
      if (!lines.length && !missingTags().length && input.origin === 'player') await attempt(input.speakers, 'reply', 1)
    }
    if (missingTags().length) await attempt(missingTags(), 'tag_repair')
    if (missingTags().length) await attempt(missingTags(), 'tag_backup', 1)
    if (!lines.length || missingTags().length) throw new Error('The chat could not finish that reply. Please try again.')
    return { lines, counts, calls, model: adultModel || model, picked_but_silent: input.speakers.filter(id => !lines.some(line => input.members.find(member => member.name === line.name)?.id === id)).length }
  } finally { input.onChecks?.(counts, calls) }
}
