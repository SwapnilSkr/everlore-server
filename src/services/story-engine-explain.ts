import type { GenerationLogDoc } from '../models/generation-log.model'
import type { LLMCallDoc } from '../models/llm-call.model'

export const STORY_LABELS: Record<string, string> = {
  narration: 'Narrator', choice_metadata: 'Choices', scene_witness: 'Scene witness (who is here, where)',
  entity_adjudication: 'Cast check', character_deaths: 'Deaths check', deaths: 'Deaths check',
  scene_endpoint: 'Scene ending check', beat_ledger: 'Continuity notes', player_interaction: 'Interaction check',
  codex_extraction: 'Card update', codex_compaction: 'Card cleanup', memory_curation: 'Memory curation',
  scene_summary: 'Scene summary', chapter_summary: 'Chapter summary', arc_summary: 'Arc summary',
  embedding_query: 'Search embedding', embedding_memory: 'Memory embedding', embedding_summary: 'Summary embedding',
  embedding_batch: 'Index embeddings', content_intent: 'Content intent check',
  rag_rerank: 'Memory re-ranking', calendar_derivation: 'Calendar setup',
  rate_limited: 'the model was busy', timeout: 'the request timed out', no_first_token: 'no first word arrived',
  stalled: 'the response stopped arriving', provider_error: 'the host returned an error',
  empty_response: 'the host returned no text', bad_json: 'the response was invalid JSON', aborted: 'the request was cancelled', other: 'a request error',
  kinship_epithet: 'Relationship name check', premise_kinship: 'Premise relationships', template_cast: 'Starting cast',
  before_reply: 'Before the reply', reply: 'The reply', after_reply: 'After the reply', background: 'Background',
  world_and_rules: 'World and rules', style: 'Writing style', canon: 'Story canon', memories: 'Retrieved memories and lore',
  summaries: 'Earlier summaries', recent_turns: 'Recent turns', directives: 'Turn instructions', player_input: 'Player input',
  live_check: 'Save check', prior_turn_wait: 'Previous turn', fence: 'Card update wait', recent_events: 'Recent history',
  mentions: 'Character references', stub_wake: 'Character wake-up', embed_wait: 'Search embedding', vector: 'Memory search',
  vector_prefetch: 'Early memory search', rag_mongo: 'Memory records', codex: 'Character cards', packet_tail: 'Context assembly',
  post_packet: 'Context hand-off', dispatch: 'Message hand-off', queue_wait: 'Worker queue', job_setup: 'Worker setup', prompt_build: 'Prompt assembly',
}
export const storyLabel = (key: string): string => STORY_LABELS[key] ?? key
export function winningNarrator(calls: LLMCallDoc[]): LLMCallDoc | undefined {
  return calls.find(call => call.purpose === 'narration' && call.won === true)
    ?? calls.find(call => call.purpose === 'narration' && call.status === 'ok')
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const percent = (part: number, total: number) => Math.round(total > 0 ? part / total * 100 : 0)

export function explainStoryTurn(turn: Partial<GenerationLogDoc>, calls: LLMCallDoc[]) {
  const first = turn.end_to_end_ttft_ms ?? turn.ttft_ms ?? 0
  const after = turn.post_stream_ms ?? 0
  const host = turn.ttft_ms ?? 0
  const preparation = Math.max(0, first - host)
  const prepEntries = Object.entries({ ...turn.prep_stages, ...turn.pre_narrator_stages })
    .filter(([key]) => key !== 'vector_prefetch')
    .sort((a, b) => b[1] - a[1])
  const prepName = prepEntries[0] ? storyLabel(prepEntries[0][0]) : 'Preparation'
  const headline = first < 2000 && after < 2000
    ? `A normal turn: first word in ${seconds(first)}, done ${seconds(after)} after the reply.`
    : host >= preparation
      ? `The narrator's host took ${seconds(host)} to start writing — ${percent(host, first)}% of the ${seconds(first)} wait for the first word.`
      : `${prepName} led our ${seconds(preparation)} preparation — ${percent(preparation, first)}% of the ${seconds(first)} wait for the first word.`
  const points: string[] = []
  const narrator = winningNarrator(calls)
  const narratorHedge = calls.find(call => call.purpose === 'narration' && call.role === 'hedge')
  if (narratorHedge || turn.hedged) {
    const primary = calls.find(call => call.purpose === 'narration' && call.role === 'primary')
    const delay = primary && narratorHedge ? narratorHedge.started_at.getTime() - primary.started_at.getTime() : 3500
    const winner = narrator?.role === 'hedge' || turn.hedge_winner === 'hedge' ? 'second' : 'first'
    const failedEarly = primary && primary.status === 'error' && primary.duration_ms < delay
    points.push(failedEarly
      ? `The first request failed before writing, so a second copy was sent; the ${winner} copy won.`
      : `The first request gave no word in ${seconds(delay)}, so a second copy was sent; the ${winner} copy won.`)
  }
  const fallback = turn.fallback_attempts ?? calls.filter(call => call.role === 'fallback' && call.purpose === 'narration')
    .map(call => ({ from: calls.find(c => c.error?.kind === 'rate_limited')?.model ?? 'The first model', to: call.model }))
  for (const attempt of fallback) points.push(`Model ${attempt.from} was busy (rate-limited), so the turn moved to ${attempt.to}.`)
  if (after >= 1000) {
    const tail = calls.filter(call => call.phase === 'after_reply' && call.status === 'ok')
      .sort((a, b) => (b.started_at.getTime() + b.duration_ms) - (a.started_at.getTime() + a.duration_ms))[0]
    if (tail) {
      const replyEnd = turn.reply_ended_at?.getTime()
      const waited = replyEnd === undefined ? Math.min(tail.duration_ms, after)
        : Math.max(0, Math.min(after, tail.started_at.getTime() + tail.duration_ms - Math.max(tail.started_at.getTime(), replyEnd)))
      points.push(`After the reply, ${storyLabel(tail.purpose).toLowerCase()} took ${seconds(waited)} (${percent(waited, after)}% of the wait); the player waited ${seconds(after)} in total.`)
    }
    else if (turn.tail_slowest_call) points.push(`After the reply, ${storyLabel(turn.tail_slowest_call).toLowerCase()} took ${seconds(turn.tail_stages?.[turn.tail_slowest_call] ?? 0)}; the player waited ${seconds(after)} in total.`)
    else points.push(`After the reply, finishing the turn took ${seconds(after)}.`)
  }
  for (const call of calls) {
    if (call.attempts > 1) points.push(`${storyLabel(call.purpose)} made ${call.attempts} HTTP attempts (${call.attempts - 1} retries).`)
    if (call.status === 'error' || call.status === 'timeout') points.push(`${storyLabel(call.purpose)} ${call.status === 'timeout' ? 'timed out' : 'failed'}: ${storyLabel(call.error?.kind ?? 'other')}.`)
  }
  if (narrator?.finish_reason === 'length') points.push('The reply hit its length limit and was cut.')
  if (narrator?.cached_tokens !== undefined && narrator.prompt_tokens > 0) points.push(`${percent(narrator.cached_tokens, narrator.prompt_tokens)}% of the narrator's prompt was served from the host's cache.`)
  return { headline, points }
}
