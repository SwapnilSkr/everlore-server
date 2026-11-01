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
import { idString, parseObjectId } from '../../src/utils/mongo-id'
import { finishGenerationTurn, generationLockKey, waitForPriorGeneration } from '../../src/utils/generation-lock'
import { liveInstanceExists } from '../../src/utils/live-instance'
import { startIntentRouter, decideIntentRoute } from '../lib/intent-router'
import { stagePostProcess, dispatchPostProcessOutbox } from '../../src/services/post-process-outbox.service'
import { loadGroupMembers } from '../../src/services/group-chat/instance'
import { buildGroupDynamic, buildAddressedStatic } from '../../src/services/group-chat/prompt'
import { rollSpeakers, advanceSilence, pickAddressed } from '../../src/services/group-chat/roll'
import { timeLines } from '../../src/services/group-chat/lines'
import { writeGroupReply } from '../../src/services/group-chat/reply'
import type { GroupOrigin, NamedLine } from '../../src/services/group-chat/types'
import type { WorldEventDoc } from '../../src/models/world-event.model'
import { log } from '../../src/utils/logger'

export interface GroupTurnJob {
  instanceId: string; playerId: string; userMessage: string
  origin?: GroupOrigin; gapStart?: string; priorTurnId?: string
}

export async function groupTurnProcessor(job: Job<GroupTurnJob>, deps: { rng?: () => number } = {}) {
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
  const members = await loadGroupMembers(instance)
  const recent = await mongoColl.events().find({ instance_id: iid }).sort({ sequence: -1 }).limit(30).toArray()
  recent.reverse()
  const sequence = (recent.at(-1)?.sequence || 0) + 1
  setLLMTraceSequence(sequence)
  const history: NamedLine[] = recent.flatMap(event => [
    ...(event.data.player_input ? [{ name: instance.group_context!.player, text: event.data.player_input }] : []),
    ...(event.data.lines || []).flatMap(line => {
      const member = members.find(member => member.id === line.character_id)
      return member ? [{ name: member.name, text: line.text }] : []
    }),
  ])
  const previousLines: NamedLine[] = (await Promise.all(members.map(async member => {
    const events = await mongoColl.events().find({ instance_id: iid, 'data.lines.character_id': member.id })
      .sort({ sequence: -1 }).limit(5).toArray()
    return events.reverse().flatMap(event => (event.data.lines || [])
      .filter(line => line.character_id === member.id).map(line => ({ name: member.name, text: line.text }))).slice(-5)
  }))).flat()
  const state = instance.group_state
  const config = instance.group_context
  const roll = rollSpeakers(members, state.silent_for, origin, userMessage, rng)
  const topic = config.topics[state.topics_used % config.topics.length]
  const query = origin === 'player' ? userMessage : recent.at(-1)?.data.ai_response || topic
  const enabled = player.preferences?.nsfw_enabled === true
  // No same-turn intent request for autonomy: only recent scene scoring applies.
  const router = startIntentRouter({ capable: origin === 'player' && template.is_nsfw_capable, enabled,
    mode: instance.mode, text: origin === 'player' ? userMessage : '' })
  try {
    const [rag, distant, summary] = await Promise.all([
      queryRag(idString(instance.template_id), instanceId, query, template.max_lore_results || 10,
        template.max_context_memories || 25, [], 'main', null).catch(() => ({ memoryTexts: [] as string[] })),
      querySummaries(instanceId, query, 3).catch(() => []),
      mongoColl.sceneSummaries().findOne({ instance_id: iid, status: { $ne: 'stale' },
        'event_range.end_sequence': { $lt: recent[0]?.sequence || 0 } }, { sort: { 'event_range.end_sequence': -1 } }),
    ])
    if (origin === 'player' && template.is_nsfw_capable && enabled) await router.wait(2000)
    // Re-read consent immediately before the first narrator, after retrieval.
    const fresh = await mongoColl.users().findOne({ _id: pid }, { projection: { 'preferences.nsfw_enabled': 1 } })
    const route = decideIntentRoute({ router, capable: template.is_nsfw_capable,
      enabled: fresh?.preferences?.nsfw_enabled === true, mode: instance.mode,
      text: origin === 'player' ? userMessage : '', recentEvents: recent })
    const adult = route.sceneClassification === 'nsfw'
    const primary = adult ? template.model_preferences?.narration_nsfw || AI_MODELS.groupNsfw
      : template.model_preferences?.narration_sfw || AI_MODELS.narrationSfw
    const fallbacks = adult ? AI_MODELS.groupNsfwFallbacks : AI_MODELS.narrationSfwFallbacks
    const adultChain = [...new Set([primary, ...fallbacks].map(model => model.trim()).filter(Boolean))]
    const normalChain = [...new Set([template.model_preferences?.narration_sfw || AI_MODELS.narrationSfw, ...AI_MODELS.narrationSfwFallbacks])]
    const writing: Array<{ writer: string; model: string; purpose: string }> = []
    const addressed = adult ? pickAddressed(members, origin === 'player' ? userMessage : '', roll.picked) : undefined
    const now = new Date()
    const reply = await writeGroupReply({ members, speakers: roll.picked, tags: roll.tags,
      player: config.player, origin, adult: addressed ? { addressed, rng } : undefined, previous: previousLines, openings: config.opening_lines,
      blocked: text => screenPlayerInput(text).blocked,
      onChecks: counts => log.info('group.line_checks', { instanceId, sequence, ...counts, writing_calls: writing.length }),
      write: async (speakers, _fallback, request) => {
        const interested = members.find(member => member.id === addressed)?.group.interested === true
        const wantsAdult = request.writer === 'adult' && interested
        let chain = wantsAdult ? adultChain : normalChain
        let redirected = !wantsAdult
        for (let index = request.index; index < chain.length; index++) {
          // Each transport attempt is explicit: a fallback must re-read consent too.
          const consent = request.writer === 'adult'
            ? await mongoColl.users().findOne({ _id: pid }, { projection: { 'preferences.nsfw_enabled': 1 } }) : undefined
          // Consent gates the addressed prompt even when interest selects the normal writer.
          const addressedPrompt = request.writer === 'adult' && adult && template.is_nsfw_capable && consent?.preferences?.nsfw_enabled === true
          const stillAdult = addressedPrompt && !redirected
          if (request.writer === 'adult' && !stillAdult && !redirected) { chain = normalChain; index = 0; redirected = true }
          const model = chain[index]
          const selected = members.filter(member => speakers.includes(member.id))
          const split = !!addressed
          const dynamic = buildGroupDynamic({ memories: rag.memoryTexts,
            summaries: [...(summary ? [summary.summary_text] : []), ...distant.map(hit => hit.text)],
            history: [...history, ...(origin === 'player' && split && !addressedPrompt ? [{ name: config.player, text: userMessage }] : []), ...(split ? request.history : [])],
            historyLimit: split ? addressedPrompt ? 12 : 5 : 30,
            messageRule: split ? addressedPrompt ? 'Write one to three messages.' : 'Each writes one short message.' : undefined,
            now, offsetMinutes: state.tz_offset_minutes, speakers: selected.map(member => member.name),
            situation: origin === 'player' ? split && !addressedPrompt ? '' : `${config.player}: ${userMessage}`
              : origin === 'catchup' ? `Write up to four messages they sent while ${config.player} was away. Topic: ${topic}`
                : `${config.player} is quiet. The group carries on. Topic: ${topic}`,
          })
          const system = addressedPrompt ? buildAddressedStatic({ ...template, members, player: config.player }, selected[0]) : config.static_prompt
          writing.push({ writer: stillAdult ? 'adult' : 'normal', model, purpose: request.purpose })
          try {
            const result = await callLLMWithFallback({ model, purpose: 'narration',
              messages: [{ role: 'system', content: system }, { role: 'user', content: dynamic }],
              temperature: narrationTemperature(model), maxTokens: split ? addressedPrompt ? 160 : 60 * speakers.length : 400,
              sessionId: instanceId }, [])
            return { ...result, writer: stillAdult ? 'adult' as const : 'normal' as const, nextIndex: index + 1 }
          } catch (error) {
            if (error instanceof EmptyLLMResponseError) return { content: '', model, writer: stillAdult ? 'adult' as const : 'normal' as const, nextIndex: index + 1 }
            if (!stillAdult && !isRateLimitError(error)) throw error
            if (index === chain.length - 1) return { content: '', model, writer: stillAdult ? 'adult' as const : 'normal' as const, nextIndex: chain.length }
          }
        }
        return { content: '', model: '', nextIndex: chain.length }
      },
    })
    log.info('group.reply_checked', { instanceId, sequence, origin, ...reply.counts,
      writing_calls: writing.length, writing, picked_but_silent: reply.picked_but_silent, routing: route.trace })
    const gapStart = origin === 'catchup' && job.data.gapStart ? new Date(job.data.gapStart) : undefined
    const lines = timeLines(reply.lines, members, new Date(), gapStart, rng)
    const usage = snapshotLLMUsage()
    const writingCalls = Math.max(writing.length, usage.filter(call => call.purpose === 'narration').length)
    const nextState = { ...state, silent_for: advanceSilence(members, state.silent_for, lines.map(line => line.character_id)),
      topics_used: state.topics_used + (origin === 'player' ? 0 : 1),
      unprompted_since_player: origin === 'player' ? 0 : state.unprompted_since_player + 1,
      writing_calls: (state.writing_calls || 0) + writingCalls }
    const event: WorldEventDoc = {
      _id: new ObjectId(), instance_id: iid, player_id: pid, sequence, type: adult ? 'intimate' : 'narration',
      scene_tag: 'dialogue', is_user_edited: false, edit_history: [], created_at: now,
      data: { player_input: origin === 'player' ? userMessage : '',
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
        $set: { group_state: nextState, 'meta.total_events': sequence, 'meta.last_active_at': now, updated_at: now },
        $inc: { 'meta.total_tokens_consumed': event.data.tokens_in + event.data.tokens_out },
      })
      if (!updated.matchedCount) {
        await mongoColl.events().deleteOne({ _id: event._id })
        throw new Error('That chat could not be found.')
      }
      if (Math.floor(nextState.writing_calls / 20) > Math.floor((state.writing_calls || 0) / 20)) {
        const batch = [...recent.filter(event => event.data.model_used !== 'seed').slice(-19), event]
        await stagePostProcess({ instanceId, playerId, eventId: idString(event._id), kind: 'memory_curation',
          payload: { instanceId, playerId, eventId: idString(event._id), playerInput: '',
            aiResponse: batch.map(event => `${event.data.player_input ? `${config.player}: ${event.data.player_input}\n` : ''}${event.data.ai_response}`).join('\n'), sceneTag: 'dialogue' } })
        await stagePostProcess({ instanceId, playerId, eventId: idString(event._id), kind: 'scene_summary',
          payload: { instanceId, playerId, sceneTag: 'dialogue', startSequence: batch[0].sequence, endSequence: sequence } })
      }
      await redis.del(`session:${instanceId}`)
      await redis.publish(channel, JSON.stringify({ type: 'group_lines', instanceId, eventId: idString(event._id),
        lines: lines.map(line => ({ characterId: line.character_id, name: members.find(member => member.id === line.character_id)!.name,
          text: line.text, shownAt: line.shown_at })) }))
      await finishGenerationTurn(redis, lockKey, String(job.id), true, channel, JSON.stringify({
        type: 'generation_complete', instanceId, jobId: String(job.id),
        event: { id: idString(event._id), sequence, player_input: event.data.player_input, narrative: event.data.ai_response, origin, lines },
      }))
    } finally { void dispatchPostProcessOutbox().catch(() => {}) }
    return { eventId: idString(event._id), sequence }
  } finally {
    router.cancel()
    flushLLMTracesLater(snapshotLLMTrace(), sequence)
  }
}
