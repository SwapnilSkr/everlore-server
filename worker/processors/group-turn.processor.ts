import type { Job } from 'bullmq'
import { ObjectId } from 'mongodb'
import { mongoColl } from '../../src/config/mongo'
import { getRedisClient } from '../../src/config/redis'
import { callLLMWithFallback, AI_MODELS, narrationTemperature, snapshotLLMUsage } from '../../src/ai'
import { isRateLimitError } from '../../src/ai/client'
import { setLLMTraceSequence, snapshotLLMTrace } from '../../src/ai/usage'
import { flushLLMTracesLater } from '../../src/services/llm-trace.service'
import { queryRag, querySummaries } from '../../src/providers/rag.provider'
import { screenPlayerInput } from '../../src/utils/input-guard'
import { EmptyLLMResponseError } from '../../src/utils/llm-response'
import { normalizeEntityName } from '../../src/utils/location-identity'
import { idString, parseObjectId } from '../../src/utils/mongo-id'
import { finishGenerationTurn, generationLockKey, waitForPriorGeneration } from '../../src/utils/generation-lock'
import { liveInstanceExists } from '../../src/utils/live-instance'
import { startIntentRouter, decideIntentRoute } from '../lib/intent-router'
import { judgeGroupReply } from '../lib/group-explicit-check'
import { stagePostProcess, dispatchPostProcessOutbox } from '../../src/services/post-process-outbox.service'
import { groupThreadFilter, groupWriterSummaries, groupMessages, groupWriterMemory, GROUP_MEMORY_CADENCE, GROUP_SUMMARY_CADENCE, groupLineRaisesFact, withoutAdultEvents, groupHiddenWords } from '../../src/services/group-chat/memory'
import { resolveGroupThread } from '../../src/services/group-chat/threads'
import { loadGroupMembers } from '../../src/services/group-chat/instance'
import { buildGroupDynamic, buildAddressedStatic, buildGroupStatic, buildDirectStatic } from '../../src/services/group-chat/prompt'
import { rollSpeakers, advanceSilence, pickAddressed, mentionsMember } from '../../src/services/group-chat/roll'
import { timeLines } from '../../src/services/group-chat/lines'
import { writeGroupReply, GROUP_WRITER_TIMEOUT_MS, groupWriterHostFailed } from '../../src/services/group-chat/reply'
import type { GroupOrigin, NamedLine } from '../../src/services/group-chat/types'
import type { WorldEventDoc } from '../../src/models/world-event.model'
import { log } from '../../src/utils/logger'

export interface GroupTurnJob {
  instanceId: string; playerId: string; userMessage: string
  directWith?: string
  origin?: GroupOrigin; gapStart?: string; priorTurnId?: string
}

export async function groupTurnProcessor(job: Job<GroupTurnJob>, deps: { rng?: () => number; onBackground?: (work: Promise<void>) => void } = {}) {
  const { instanceId, playerId, userMessage, origin = 'player' } = job.data
  if (!['player', 'unprompted', 'catchup'].includes(origin)) throw new Error('Invalid group turn origin')
  const rng = deps.rng ?? Math.random
  const redis = getRedisClient()
  const channel = `user:${playerId}:events`
  const lockKey = generationLockKey(playerId, instanceId)
  await redis.publish(channel, JSON.stringify({ type: 'generation_started', instanceId, jobId: String(job.id) }))
  await waitForPriorGeneration(redis, lockKey, String(job.id), job.data.priorTurnId)
  const iid = parseObjectId(instanceId)
  const pid = parseObjectId(playerId)
  const instance = await mongoColl.worldInstances().findOne({ _id: iid, player_id: pid })
  if (!instance?.group_state || !instance.group_context) throw new Error('That chat could not be found.')
  const template = await mongoColl.worldTemplates().findOne({ _id: instance.template_id })
  if (template?.kind !== 'group') throw new Error('That chat could not be found.')
  const player = await mongoColl.users().findOne({ _id: pid })
  if (!player || player.guest || player.account_status === 'banned') throw new Error('Sign in to continue.')
  const guard = screenPlayerInput(userMessage)
  if (guard.blocked) throw new Error(guard.message)
  const directWith = await resolveGroupThread(instance, job.data.directWith)
  if (directWith && origin !== 'player') throw new Error('Send a message to keep this chat going.')
  const members = await loadGroupMembers(instance)
  const latest = await mongoColl.events().findOne({ instance_id: iid }, { sort: { sequence: -1 } })
  const recent = await mongoColl.events().find({ instance_id: iid, ...groupThreadFilter(directWith) }).sort({ sequence: -1 }).limit(30).toArray()
  recent.reverse()
  const sequence = (latest?.sequence || 0) + 1
  setLLMTraceSequence(sequence)
  const messagesFromEvents = (events: typeof recent): NamedLine[] => groupMessages(events, instance.group_context!.player, members, directWith)
  const playerMessages = (origin === 'player' ? 1 : 0) + await mongoColl.events().countDocuments({
    instance_id: iid, ...groupThreadFilter(directWith), 'data.model_used': { $ne: 'seed' }, 'data.player_input': { $exists: true, $ne: '' },
  }, { limit: 2 })
  const historyEvents = playerMessages >= 2 ? recent.filter(event => event.data.model_used !== 'seed') : recent
  const history = messagesFromEvents(historyEvents)
  const plainHistory = messagesFromEvents(withoutAdultEvents(historyEvents))
  const previousLines: NamedLine[] = (await Promise.all(members.map(async member => {
    const events = await mongoColl.events().find({ instance_id: iid, ...groupThreadFilter(directWith), 'data.lines.character_id': member.id })
      .sort({ sequence: -1 }).limit(30).toArray()
    return events.reverse().flatMap(event => (event.data.lines || [])
      .filter(line => line.character_id === member.id).map(line => ({ name: member.name, text: line.text }))).slice(-30)
  }))).flat()
  const state = instance.group_state
  const config = instance.group_context
  const roll = directWith ? { picked: [directWith], tags: [] as string[] } : rollSpeakers(members, state.silent_for, origin, userMessage, rng)
  const groupEvents = directWith ? (await mongoColl.events().find({ instance_id: iid, ...groupThreadFilter() })
    .sort({ sequence: -1 }).limit(8).toArray()).reverse() : undefined
  const groupContext = groupEvents && groupMessages(groupEvents, config.player, members).slice(-8)
  const plainGroupContext = groupEvents && groupMessages(withoutAdultEvents(groupEvents), config.player, members).slice(-8)
  const topic = config.topics[state.topics_used % config.topics.length]
  const query = [...messagesFromEvents(recent).slice(-3).map(line => `${line.name}: ${line.text}`),
    origin === 'player' ? `${config.player}: ${userMessage}` : `${config.player} is quiet. Topic: ${topic}`].join('\n')
  const namedMembers = members.filter(member => roll.picked.includes(member.id) || (!directWith && mentionsMember(userMessage, member.name)))
  const namedEntities = await mongoColl.entities().find({ instance_id: iid,
    $or: [{ character_id: { $in: namedMembers.map(member => parseObjectId(member.id)) } },
      { name_normalized: { $in: namedMembers.map(member => normalizeEntityName(member.name)) } }, { type: 'player' }],
  }).toArray()
  const enabled = player.preferences?.nsfw_enabled === true
  // No same-turn intent request for autonomy: only recent scene scoring applies.
  const router = startIntentRouter({ capable: origin === 'player' && template.is_nsfw_capable, enabled,
    mode: instance.mode, text: origin === 'player' ? userMessage : '' })
  try {
    const [rag, distant, summary] = await Promise.all([
      queryRag(idString(instance.template_id), instanceId, query, template.max_lore_results || 10,
        template.max_context_memories || 25, namedEntities.map(entity => idString(entity._id)), 'main', null, undefined, { thread: directWith }).catch(() => ({ memoryTexts: [] as string[], openThreads: [] as string[] })),
      querySummaries(instanceId, query, 3).catch(() => []),
      mongoColl.sceneSummaries().findOne({ instance_id: iid, private_to: directWith ?? { $exists: false }, status: { $ne: 'stale' },
        'event_range.end_sequence': { $lt: recent[0]?.sequence || 0 } }, { sort: { 'event_range.end_sequence': -1 } }),
    ])
    const summaryCandidates = [
      ...(summary ? [{ text: summary.summary_text, startSequence: summary.event_range.start_sequence, endSequence: summary.event_range.end_sequence }] : []), ...distant,
    ]
    const summaries = await groupWriterSummaries(iid, summaryCandidates, directWith)
    if (origin === 'player' && template.is_nsfw_capable && enabled) await router.wait(2000)
    // Re-read consent immediately before the first narrator, after retrieval.
    const fresh = await mongoColl.users().findOne({ _id: pid }, { projection: { 'preferences.nsfw_enabled': 1 } })
    const route = decideIntentRoute({ router, capable: template.is_nsfw_capable,
      enabled: fresh?.preferences?.nsfw_enabled === true, mode: instance.mode,
      text: origin === 'player' ? userMessage : '', recentEvents: recent })
    const routerYes = route.routerSettled && route.trace.sexual === true
    const intimate = recent.filter(event => event.type === 'intimate').slice(-2)
    const involved = members.some(member => (directWith === member.id || mentionsMember(userMessage, member.name))
      && intimate.some(event => event.data.lines?.some(line => line.character_id === member.id)))
    const adultDowngrade = route.sceneClassification === 'nsfw' && !routerYes
      ? origin !== 'player' ? 'autonomous' : !involved ? 'no_involved_member' : undefined : undefined
    const carried = route.sceneClassification === 'nsfw' && !adultDowngrade
    const plainLine = carried && origin === 'player' && route.routerSettled && route.trace.sexual === false && userMessage.trim().endsWith('?')
    // Proven live: told facts in its prompt, the adult writer still denied them or turned
    // the answer to sex. Asked about a stored fact, the normal writer answers plainly. So does
    // the next question: proven live, "who else knows about it?" holds no word of the fact,
    // reached the adult writer straight after a plain answer, and it named the wrong person.
    const factQuestion = plainLine && (recent.at(-1)?.type !== 'intimate' || await groupLineRaisesFact({ instanceId: iid, player: config.player, thread: directWith, line: userMessage,
      speakers: members.filter(member => roll.picked.includes(member.id)).map(member => member.name) }))
    const adult = carried && !factQuestion
    const primary = adult ? template.model_preferences?.narration_nsfw || AI_MODELS.groupNsfw
      : template.model_preferences?.narration_sfw || AI_MODELS.narrationSfw
    const fallbacks = adult ? AI_MODELS.groupNsfwFallbacks : AI_MODELS.narrationSfwFallbacks
    const adultChain = [...new Set([primary, ...fallbacks].map(model => model.trim()).filter(Boolean))]
    const normalChain = [...new Set([template.model_preferences?.narration_sfw || AI_MODELS.narrationSfw, ...AI_MODELS.narrationSfwFallbacks])]
    const writing: Array<{ writer: string; model: string; purpose: string }> = []
    const addressed = directWith ?? (adult ? pickAddressed(members, origin === 'player' ? userMessage : '', roll.picked) : undefined)
    const addressedName = members.find(member => member.id === addressed)?.name
    // A reply the check marked tame stays in the chat, but out of this writer's view,
    // so one tame reply can't set the tone for the rest of the scene.
    const addressedMessages = recent.filter(event => event.data.model_used !== 'seed').flatMap(event =>
      messagesFromEvents([event]).filter(line => !(event.data.tame === true && line.name === addressedName)))
    const otherMessages = addressedMessages.filter(line => line.name !== config.player && line.name !== addressedName).slice(-3)
    const addressedHistory = addressedMessages.filter(line => line.name === config.player || line.name === addressedName || otherMessages.includes(line))
    const now = new Date()
    // Proven live: asked a plain question mid-scene, she answered it, then spent the next
    // messages steering back to sex. One message answers it and leaves the lead to the player.
    const plainQuestion = adult && plainLine
    const reply = await writeGroupReply({ members, speakers: roll.picked, tags: roll.tags,
      player: config.player, origin, direct: directWith, oneMessage: plainQuestion, adult: adult && addressed ? { addressed, rng } : undefined, previous: previousLines, openings: directWith ? [] : config.opening_lines,
      blocked: text => screenPlayerInput(text).blocked,
      onChecks: counts => log.info('group.line_checks', { instanceId, sequence, ...counts, writing_calls: writing.length }),
      write: async (speakers, _fallback, request) => {
        const wantsAdult = request.writer === 'adult'
        let chain = wantsAdult ? adultChain : normalChain
        let redirected = !wantsAdult
        for (let index = request.index; index < chain.length; index++) {
          // Each transport attempt is explicit: a fallback must re-read consent too.
          const consent = await mongoColl.users().findOne({ _id: pid }, { projection: { 'preferences.nsfw_enabled': 1 } })
          const freshMembers = await loadGroupMembers(instance)
          const selected = freshMembers.filter(member => speakers.includes(member.id))
          const frightened = selected.some(member => (member.relationship?.fear ?? 0) >= 70)
          // Fear and consent are read together for every transport and content attempt.
          const addressedPrompt = request.writer === 'adult' && adult && template.is_nsfw_capable && consent?.preferences?.nsfw_enabled === true && !frightened
          const stillAdult = addressedPrompt && !redirected
          if (request.writer === 'adult' && !stillAdult && !redirected) { chain = normalChain; index = 0; redirected = true }
          const model = chain[index]
          const split = !!addressed
          const consented = consent?.preferences?.nsfw_enabled === true
          const memory = await groupWriterMemory({ instanceId: iid, player: config.player,
            speakers: selected.map(member => member.name), thread: directWith, enabled: consented,
            memories: rag.memoryTexts, openThreads: rag.openThreads || [], raisedBy: addressedPrompt ? userMessage : undefined, recentEvents: recent.slice(-4).map(event => event._id) })
          const shownHistory = consented ? history : plainHistory
          const shownGroup = consented ? groupContext : plainGroupContext
          const hiddenWords = origin === 'player' && !addressedPrompt ? await groupHiddenWords({ instanceId: iid, thread: directWith, line: userMessage,
            people: [config.player, ...members.map(member => member.name)], known: [...memory.memories, ...memory.openThreads],
            lines: [...shownHistory, ...(shownGroup || [])] }) : []
          const dynamic = buildGroupDynamic({ bonds: selected, notToldAbout: hiddenWords, memories: memory.memories, openThreads: memory.openThreads,
            summaries: addressedPrompt ? [] : consented ? summaries : await groupWriterSummaries(iid, summaryCandidates, directWith, false),
            groupContext: stillAdult ? undefined : shownGroup,
            history: [...(addressedPrompt ? addressedHistory : shownHistory), ...(origin === 'player' && split && !addressedPrompt ? [{ name: config.player, text: userMessage }] : []), ...(split ? request.history : [])],
            historyLimit: split ? addressedPrompt ? 12 : directWith ? 30 : 5 : 30,
            messageRule: split ? plainQuestion && addressedPrompt ? 'Write one message, answering what was asked.' : addressedPrompt || directWith ? 'Write one to three messages.' : 'Each writes one short message.' : undefined,
            now, offsetMinutes: state.tz_offset_minutes, speakers: selected.map(member => member.name),
            situation: origin === 'player' ? split && !addressedPrompt ? '' : `${config.player}: ${userMessage}`
              : origin === 'catchup' ? `Write up to four messages they sent while ${config.player} was away. Topic: ${topic}`
                : `${config.player} is quiet. The group carries on. Topic: ${topic}`,
          })
          const baseSystem = addressedPrompt ? buildAddressedStatic({ ...template, members, player: config.player }, selected[0], request.excludedVoice)
            : directWith ? buildGroupStatic({ ...template, members: selected, player: config.player }) : config.static_prompt
          const system = directWith ? buildDirectStatic(baseSystem, selected[0], config.player) : baseSystem
          writing.push({ writer: stillAdult ? 'adult' : 'normal', model, purpose: request.purpose })
          try {
            const result = await callLLMWithFallback({ model, purpose: 'narration',
              messages: [{ role: 'system', content: system }, { role: 'user', content: dynamic }],
              temperature: narrationTemperature(model), maxTokens: split ? addressedPrompt || directWith ? 300 : 60 * speakers.length : 400,
              sessionId: directWith ? `${instanceId}:direct:${directWith}` : instanceId, timeoutMs: GROUP_WRITER_TIMEOUT_MS }, [])
            return { ...result, writer: stillAdult ? 'adult' as const : 'normal' as const, nextIndex: index + 1, prompt: `${system}\n${dynamic}`, hiddenWords }
          } catch (error) {
            if (error instanceof EmptyLLMResponseError) return { content: '', model, writer: stillAdult ? 'adult' as const : 'normal' as const, nextIndex: index + 1 }
            if (!stillAdult && !isRateLimitError(error) && !groupWriterHostFailed(error)) throw error
            if (index === chain.length - 1) return { content: '', model, writer: stillAdult ? 'adult' as const : 'normal' as const, nextIndex: chain.length }
          }
        }
        return { content: '', model: '', nextIndex: chain.length }
      },
    })
    log.info('group.reply_checked', { instanceId, sequence, origin, ...reply.counts,
      writing_calls: writing.length, writing, picked_but_silent: reply.picked_but_silent, routing: route.trace, adult_downgrade: adultDowngrade })
    const gapStart = origin === 'catchup' && job.data.gapStart ? new Date(job.data.gapStart) : undefined
    const lines = timeLines(reply.lines, members, new Date(), gapStart, rng)
    const usage = snapshotLLMUsage()
    const writingCalls = Math.max(writing.length, usage.filter(call => call.purpose === 'narration').length)
    const nextState = directWith ? { ...state } : { ...state, silent_for: advanceSilence(members, state.silent_for, lines.map(line => line.character_id)),
      topics_used: state.topics_used + (origin === 'player' ? 0 : 1),
      unprompted_since_player: origin === 'player' ? 0 : state.unprompted_since_player + 1,
      writing_calls: (state.writing_calls || 0) + writingCalls }
    const event: WorldEventDoc = {
      _id: new ObjectId(), instance_id: iid, player_id: pid, sequence, type: adult ? 'intimate' : 'narration',
      scene_tag: 'dialogue', is_user_edited: false, edit_history: [], created_at: now,
      data: { ...(directWith === undefined ? {} : { dm_with: directWith }), player_input: origin === 'player' ? userMessage : '',
        ai_response: reply.lines.map(line => `${line.name}: ${line.text}`).join('\n'),
        origin, lines, group_state_after: nextState, state_mutations: {}, flag_mutations: {},
        model_used: reply.model, tokens_in: usage.reduce((sum, call) => sum + call.prompt_tokens, 0),
        tokens_out: usage.reduce((sum, call) => sum + call.completion_tokens, 0) },
    }
    // Deletion wins over an in-flight narrator; the normal cascade owns all fields.
    if (!(await liveInstanceExists(iid))) throw new Error('That chat could not be found.')
    await mongoColl.events().insertOne(event)
    try {
      const updated = await mongoColl.worldInstances().updateOne({ _id: iid, player_id: pid }, {
        $set: { ...Object.fromEntries(Object.entries(nextState).filter(([key]) => !['curated_through_sequence', 'summarized_through_sequence', 'direct_threads'].includes(key)).map(([key, value]) => [`group_state.${key}`, value])), 'meta.total_events': sequence, 'meta.last_active_at': now, updated_at: now },
        $inc: { 'meta.total_tokens_consumed': event.data.tokens_in + event.data.tokens_out },
      })
      if (!updated.matchedCount) {
        await mongoColl.events().deleteOne({ _id: event._id })
        throw new Error('That chat could not be found.')
      }
      const coverage = await mongoColl.worldInstances().findOne({ _id: iid })
      await mongoColl.events().updateOne({ _id: event._id }, { $max: {
        'data.group_state_after.curated_through_sequence': coverage?.group_state?.curated_through_sequence ?? 1,
        'data.group_state_after.summarized_through_sequence': coverage?.group_state?.summarized_through_sequence ?? 1,
      } })
      if (coverage?.group_state?.direct_threads) await mongoColl.events().updateOne({ _id: event._id }, {
        $set: { 'data.group_state_after.direct_threads': coverage.group_state.direct_threads },
      })
      const threadEvents = await mongoColl.events().countDocuments({ instance_id: iid, ...groupThreadFilter(directWith), 'data.model_used': { $ne: 'seed' } })
      if (threadEvents % GROUP_MEMORY_CADENCE === 0) {
        await stagePostProcess({ instanceId, playerId, eventId: idString(event._id), kind: 'memory_curation',
          payload: { instanceId, playerId, eventId: idString(event._id), groupMemory: true, sceneTag: 'dialogue' } })
      }
      if (threadEvents % GROUP_SUMMARY_CADENCE === 0) {
        await stagePostProcess({ instanceId, playerId, eventId: idString(event._id), kind: 'scene_summary',
          payload: { instanceId, playerId, eventId: idString(event._id), groupSummary: true, sceneTag: 'dialogue' } })
      }
      await redis.del(`session:${instanceId}`)
      await redis.publish(channel, JSON.stringify({ type: 'group_lines', instanceId, ...(directWith === undefined ? {} : { directWith }), eventId: idString(event._id),
        lines: lines.map(line => ({ characterId: line.character_id, name: members.find(member => member.id === line.character_id)!.name,
          text: line.text, shownAt: line.shown_at })) }))
      await finishGenerationTurn(redis, lockKey, String(job.id), true, channel, JSON.stringify({
        type: 'generation_complete', instanceId, jobId: String(job.id),
        event: { id: idString(event._id), sequence, player_input: event.data.player_input, narrative: event.data.ai_response, origin, lines },
      }))
    } finally { void dispatchPostProcessOutbox().catch(() => {}) }
    if (addressedName && origin === 'player' && writing.some(call => call.writer === 'adult')) {
      const said = reply.lines.filter(line => line.name === addressedName).map(line => line.text).join('\n')
      const work = judgeGroupReply(said).then(async explicit => {
        if (explicit === false) await mongoColl.events().updateOne({ _id: event._id }, { $set: { 'data.tame': true } })
        log.info('group.explicit_check', { instanceId, sequence, explicit })
      }).catch(error => log.warn('group.explicit_check_failed', { instanceId, sequence, error: String(error) }))
      deps.onBackground?.(work)
    }
    return { eventId: idString(event._id), sequence }
  } finally {
    router.cancel()
    flushLLMTracesLater(snapshotLLMTrace(), sequence)
  }
}
