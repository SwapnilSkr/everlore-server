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
 * Primary subtag of a BCP 47 or underscore locale (`pt-BR`, `pt_BR`, `es-419`),
 * but only when that language is enabled. English and everything else are
 * undefined — English is the absence of a language.
 */
export function languageFromLocale(
  locale?: string | null,
  enabledCodes: readonly string[] = env.REPLY_LANGUAGES || [],
): string | undefined {
  if (typeof locale !== 'string') return undefined
  const trimmed = locale.trim()
  if (!trimmed) return undefined
  const primary = trimmed.replace(/_/g, '-').split('-')[0]?.toLowerCase()
  if (!primary) return undefined
  return enabledReplyLanguages(enabledCodes).some((entry) => entry.code === primary)
    ? primary
    : undefined
}

/**
 * A save starts in the player's chosen language, else the device locale, else
 * English. An explicit `en` preference beats the device and yields no code.
 */
export function startingLanguage(params: {
  preference?: string | null
  deviceLocale?: string | null
  enabledCodes?: readonly string[]
}): string | undefined {
  const enabledCodes = params.enabledCodes ?? env.REPLY_LANGUAGES ?? []
  if (typeof params.preference === 'string' && params.preference.trim()) {
    return effectiveReplyLanguage(params.preference.trim(), enabledCodes)?.code
  }
  return languageFromLocale(params.deviceLocale, enabledCodes)
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

/** A settings PATCH accepts `en` or an enabled code; everything else is invalid. */
export function isReplyLanguageSetting(
  value: unknown,
  enabledCodes: readonly string[] = env.REPLY_LANGUAGES || [],
): value is string {
  if (typeof value !== 'string') return false
  if (value === ENGLISH_REPLY_LANGUAGE.code) return true
  return enabledReplyLanguages(enabledCodes).some((entry) => entry.code === value)
}

/** A locale from the create body: max 35 chars, well-formed, otherwise ignored. */
export function normalizeDeviceLocale(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 35) return undefined
  return /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/.test(trimmed) ? trimmed : undefined
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
