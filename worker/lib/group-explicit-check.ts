import { buildChatRequest } from '../../src/ai/client'
import { recordLLMUsage, traceFetch, usageFromProvider } from '../../src/ai/usage'
import { getOpenRouter } from '../../src/config/openai'
import { env } from '../../src/config/env'

export const EXPLICIT_JUDGE_PROMPT = `You judge one reply from an adult chat. Answer true only if it plainly names sex acts or sexual body parts. Flirting, teasing, invitations, innuendo and putting it off are false. Respond ONLY with JSON: {"explicit":true} or {"explicit":false}`

/** Runs after the reply is sent, so it can never slow one down. Null means no verdict. */
export async function judgeGroupReply(text: string): Promise<boolean | null> {
  const { params } = buildChatRequest({ model: env.NSFW_SAME_TURN_ROUTER_MODEL, purpose: 'group_explicit_check',
    messages: [{ role: 'system', content: EXPLICIT_JUDGE_PROMPT }, { role: 'user', content: text }],
    temperature: 0, maxTokens: 16, responseFormat: { type: 'json_object' } })
  params.provider = { ...params.provider, order: [env.NSFW_SAME_TURN_ROUTER_HOST], only: [env.NSFW_SAME_TURN_ROUTER_HOST], allow_fallbacks: false, require_parameters: true }
  params.reasoning = { enabled: false }
  let usage: unknown
  try {
    const response = await getOpenRouter().withOptions({ fetch: traceFetch }).chat.completions.create(params, { timeout: 6000, maxRetries: 0 }) as { usage?: unknown; choices?: Array<{ message?: { content?: unknown } }> }
    usage = response.usage
    const content = response.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !/^\s*\{\s*"explicit"\s*:\s*(true|false)\s*\}\s*$/.test(content)) return null
    return (JSON.parse(content) as { explicit: boolean }).explicit
  } catch { return null } finally {
    recordLLMUsage({ purpose: 'group_explicit_check', model: params.model, streamed: false, ...usageFromProvider(usage) })
  }
}
