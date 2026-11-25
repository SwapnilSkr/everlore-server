import { env } from '../config/env'

/**
 * The only place that knows what a reply language is.
 *
 * English is never stored: absent means English. A code that is off or unknown
 * behaves as English everywhere, including on saves that already carry it.
 */
export interface ReplyLanguageEntry {
  /** Stored on the save and exchanged with the app. */
  code: string
  /** Name handed to the model in the rule ("write in Brazilian Portuguese"). */
  name: string
  /** Name shown to the player in the Story language row. */
  label: string
}

/** English is offered to the player but never stored on a save. */
export const ENGLISH_REPLY_LANGUAGE = { code: 'en', label: 'English' } as const

const REGISTRY: readonly ReplyLanguageEntry[] = [
  { code: 'pt', name: 'Brazilian Portuguese', label: 'Português' },
  { code: 'es', name: 'Spanish', label: 'Español' },
]

export function enabledReplyLanguages(
  enabledCodes: readonly string[] = env.REPLY_LANGUAGES || [],
): ReplyLanguageEntry[] {
  const enabled = new Set(enabledCodes)
  return REGISTRY.filter((entry) => enabled.has(entry.code))
}

/** The registry entry for an effective code, or undefined for English/off/unknown. */
export function effectiveReplyLanguage(
  code?: string | null,
  enabledCodes: readonly string[] = env.REPLY_LANGUAGES || [],
): ReplyLanguageEntry | undefined {
  if (!code || code === ENGLISH_REPLY_LANGUAGE.code) return undefined
  return enabledReplyLanguages(enabledCodes).find((entry) => entry.code === code)
}

/**
 * A save starts in the player's chosen language, else the language a save of
 * theirs last settled in by writing, else English. An explicit `en` setting
 * beats the written memory and yields no code. The phone's language is never
 * read.
 */
export function startingLanguage(params: {
  preference?: string | null
  written?: string | null
  enabledCodes?: readonly string[]
}): string | undefined {
  const enabledCodes = params.enabledCodes ?? env.REPLY_LANGUAGES ?? []
  const preference =
    typeof params.preference === 'string' ? params.preference.trim() : ''
  if (preference) return effectiveReplyLanguage(preference, enabledCodes)?.code
  const written = typeof params.written === 'string' ? params.written.trim() : ''
  if (written) return effectiveReplyLanguage(written, enabledCodes)?.code
  return undefined
}

/**
 * The one narrator instruction. It must be the last system message before the
 * user turn and is only sent for a non-English save.
 */
export function replyLanguageRule(entry: ReplyLanguageEntry): string {
  return `REPLY LANGUAGE (hard rule, overrides everything above about wording): write the ENTIRE reply in ${entry.name}: every line of narration, dialogue and attribution. No English sentence anywhere. Keep the names of people and places exactly as given. The format is unchanged: dialogue in double quotes, every other visible word in single-asterisk italics.`
}

/** Story language row: empty hides it, otherwise English comes first. */
export function replyLanguageOptions(
  enabledCodes: readonly string[] = env.REPLY_LANGUAGES || [],
): Array<{ code: string; label: string }> {
  const enabled = enabledReplyLanguages(enabledCodes)
  if (enabled.length === 0) return []
  return [ENGLISH_REPLY_LANGUAGE, ...enabled.map(({ code, label }) => ({ code, label }))]
}

/**
 * The Story language fields the app reads on a load frame (`reply-language.md`
 * §10): the effective code (`'en'` when absent) and the offered list. One
 * helper, used by `getById` and the live-chat load frame alike, so the two can
 * never drift; the list is `replyLanguageOptions()`, never a second list.
 */
export function liveFrameLanguage(instance: { reply_language?: string | null }): {
  reply_language: string
  reply_languages: Array<{ code: string; label: string }>
} {
  return {
    reply_language: effectiveReplyLanguage(instance.reply_language)?.code ?? ENGLISH_REPLY_LANGUAGE.code,
    reply_languages: replyLanguageOptions(),
  }
}

/** A settings PATCH accepts `en` or an enabled code; everything else is invalid. */
export function isReplyLanguageSetting(
  value: unknown,
  enabledCodes: readonly string[] = env.REPLY_LANGUAGES || [],
): value is string {
  if (typeof value !== 'string') return false
  if (value === ENGLISH_REPLY_LANGUAGE.code) return true
  return enabledReplyLanguages(enabledCodes).some((entry) => entry.code === value)
}

interface ChatMessageLike {
  role: string
  content: string
}

/**
 * Replay splices its directive in before the user turn. The reply-language rule
 * must still be the LAST system message there, so it moves after the directive.
 */
export function spliceReplayDirective(
  messages: ChatMessageLike[],
  directive: string,
  entry?: ReplyLanguageEntry,
): ChatMessageLike[] {
  const last = messages[messages.length - 1]
  const head = messages.slice(0, -1)
  const rule = entry ? replyLanguageRule(entry) : null
  const headWithoutRule = rule
    ? head.filter((message) => !(message.role === 'system' && message.content === rule))
    : head
  return [
    ...headWithoutRule,
    { role: 'system', content: directive },
    ...(rule ? [{ role: 'system', content: rule }] : []),
    last,
  ]
}
