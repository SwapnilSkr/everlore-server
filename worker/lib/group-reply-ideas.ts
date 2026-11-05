import { AI_MODELS, callLLMWithFallback } from '../../src/ai'
import { runWithLLMTrace, snapshotLLMTrace } from '../../src/ai/usage'
import { mongoColl } from '../../src/config/mongo'
import { getRedisClient } from '../../src/config/redis'
import type { WorldEventDoc } from '../../src/models/world-event.model'
import type { WorldTemplateDoc } from '../../src/models/world-template.model'
import { GROUP_IDEA_MAX_CHARS, GROUP_IDEAS_MAX } from '../../src/services/group-chat/ideas'
import { SPEAKER_PREFIX } from '../../src/services/group-chat/lines'
import type { GroupMember } from '../../src/services/group-chat/types'
import { flushLLMTracesLater } from '../../src/services/llm-trace.service'
import { idString } from '../../src/utils/mongo-id'
import { log } from '../../src/utils/logger'
import { classifyChoiceGrounding, computeGroundingContext } from './choice-grounding'

/** A separate call after the lines are saved, so it never holds the reply. */
export const GROUP_IDEAS_TIMEOUT_MS = 8000
export const GROUP_IDEAS_MAX_TOKENS = 200
/** How many of the turn's own lines the writer is shown. */
const GROUP_IDEAS_HISTORY = 8
const GROUP_IDEA_MESSAGE_CHARS = 500

export const GROUP_IDEAS_PROMPT = `You write what the player sends next in an online group chat. Write up to three different short messages the player could send next, in the player's own voice, as themselves, the way they really text. One to ${GROUP_IDEA_MAX_CHARS} characters each. Never write a character's message, and never start a message with a name and a colon. No numbering and no quotation marks. Say something new: never repeat a message already in the chat. Return only JSON: {"ideas":["...","..."]}`

/** The player's own next words may be explicit only in a scene that already is. */
export const GROUP_IDEAS_ADULT_RULE = `Everyone here is a consenting adult and the conversation is sexual, so the player's next message can be explicit.`

export const GROUP_IDEAS_SCHEMA: object = {
  type: 'object', additionalProperties: false, required: ['ideas'],
  properties: { ideas: { type: 'array', maxItems: GROUP_IDEAS_MAX,
    items: { type: 'string', minLength: 1, maxLength: GROUP_IDEA_MAX_CHARS } } },
}

/** Names and words only: the writer is given and returns no id. */
export function groupIdeaMessages(event: WorldEventDoc, members: Pick<GroupMember, 'id' | 'name'>[], player: string) {
  const names = new Map(members.map(member => [member.id, member.name]))
  const lines = (event.data.lines || []).flatMap(line => {
    const name = names.get(line.character_id)
    return name && line.text?.trim() ? [{ from: name, text: line.text.slice(0, GROUP_IDEA_MESSAGE_CHARS) }] : []
  }).slice(-GROUP_IDEAS_HISTORY)
  const previous = event.data.player_input?.trim()
  return previous ? [{ from: player, text: previous.slice(0, GROUP_IDEA_MESSAGE_CHARS) }, ...lines] : lines
}

/** Strict: anything malformed, spoken as a character, invented or repeated is dropped. */
export function groupIdeaTexts(raw: string, input: {
  members: Pick<GroupMember, 'name'>[]; player: string; playerLines: string[]; worldText?: string
}): string[] {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const list = (parsed as { ideas?: unknown }).ideas
  if (!Array.isArray(list)) return []
  // The same structural guards normal chat applies to a player's words: a kin
  // reference the cast cannot support, or one they would not say about themselves.
  const grounding = computeGroundingContext(input.members.map(member => member.name), input.playerLines.join('\n'),
    undefined, input.worldText, { isSentient: false })
  const kept: string[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const text = entry.replace(/\s+/gu, ' ').trim()
    const length = Array.from(text).length
    if (length < 1 || length > GROUP_IDEA_MAX_CHARS) continue
    // The line parser's rule: `Name: words` is a character speaking, not the player.
    if (SPEAKER_PREFIX.test(text)) continue
    if (classifyChoiceGrounding(text, grounding).length) continue
    const key = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    kept.push(text)
    if (kept.length >= GROUP_IDEAS_MAX) break
  }
  return kept
}

/** Started after the selfies and independent of them; a failure changes nothing. */
export async function startGroupReplyIdeas(event: WorldEventDoc, input: {
  members: GroupMember[]; player: string; template: WorldTemplateDoc; adult: boolean
}): Promise<void> {
  const playerId = idString(event.player_id), instanceId = idString(event.instance_id), eventId = idString(event._id)
  try {
    const messages = groupIdeaMessages(event, input.members, input.player)
    if (!messages.length) return
    const model = input.adult
      ? input.template.model_preferences?.narration_nsfw || AI_MODELS.groupNsfw
      : input.template.model_preferences?.narration_sfw || AI_MODELS.narrationSfw
    let content = ''
    let failure: unknown
    // Its own background trace: the turn's trace is already flushed by now, and an
    // unprompted turn's ideas have to count toward the same daily caps.
    const traces = await runWithLLMTrace({ instance_id: instanceId, player_id: playerId, sequence: event.sequence, background: true }, async () => {
      try {
        content = (await callLLMWithFallback({
          model, purpose: 'group_reply_ideas',
          messages: [{ role: 'system', content: [GROUP_IDEAS_PROMPT, ...(input.adult ? [GROUP_IDEAS_ADULT_RULE] : [])].join('\n') },
            { role: 'user', content: JSON.stringify({ player: input.player, messages }) }],
          maxTokens: GROUP_IDEAS_MAX_TOKENS, timeoutMs: GROUP_IDEAS_TIMEOUT_MS,
          responseSchema: GROUP_IDEAS_SCHEMA, responseFormat: { type: 'json_schema', json_schema: { name: 'group_reply_ideas', strict: true } },
        }, [])).content
      } catch (error) { failure = error }
      return snapshotLLMTrace()
    })
    if (event.data.origin === 'unprompted') for (const trace of traces) trace.call.group_origin = 'unprompted'
    flushLLMTracesLater(traces, event.sequence)
    if (failure !== undefined) { log.warn('group.ideas_call_failed', { instanceId, eventId, error: String(failure) }); return }
    const ideas = groupIdeaTexts(content, { members: input.members, player: input.player,
      playerLines: event.data.player_input ? [event.data.player_input] : [],
      worldText: [input.template.seed_prompt, input.template.global_lore].filter(Boolean).join('\n') })
    if (!ideas.length) return
    // Fenced to the event: a rewound or deleted turn is never recreated.
    const saved = await mongoColl.events().updateOne({ _id: event._id, instance_id: event.instance_id, player_id: event.player_id },
      { $set: { 'data.reply_ideas': ideas } })
    if (!saved.matchedCount) return
    const directWith = event.data.dm_with
    await getRedisClient().publish(`user:${playerId}:events`, JSON.stringify({ type: 'group_ideas', instanceId,
      ...(directWith === undefined ? {} : { directWith }), eventId, ideas }))
  } catch (error) {
    log.warn('group.ideas_failed', { instanceId, eventId, error: String(error) })
  }
}
