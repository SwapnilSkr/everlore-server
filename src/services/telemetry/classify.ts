import type { AppErrorClass } from './types'

/**
 * §4.5 — which errors are worth a group, and which are just a number.
 *
 * "Only errors that matter" is structural: the class comes from the error's own
 * type, source and HTTP context, never from its text. There is no vocabulary of
 * words to match against, so nothing here can be reworded past.
 *
 * The connectivity set is deliberately the same four types the app's own
 * `isConnectivityError` checks (`lib/core/errors/user_message.dart`), so the
 * class the server counts is the condition the player was already told about.
 */
export const CONNECTIVITY_TYPES: readonly string[] = [
  'SocketException',
  'ClientException',
  'HandshakeException',
  'TimeoutException',
]

/**
 * Flutter reports a failed image download through `FlutterError.onError`, i.e.
 * as an uncaught error, and it is not a crash: the picture is missing and the
 * screen is fine.
 */
export const IMAGE_LOAD_TYPE = 'NetworkImageLoadException'

/** §4.5a. Exact plain labels, so the console never invents its own words. */
export const ERROR_CLASS_CATEGORIES: Record<AppErrorClass, string> = {
  crash: 'The app crashed',
  handled_bug: 'Something broke on a screen',
  server_5xx: 'Our server failed a request',
  expected_4xx: 'Request refused as expected',
  offline: 'Connection dropped',
  image_load: "Picture didn't load",
}

/** The classes that become `app_error_groups` rows; the rest become counters. */
export function isGroupClass(cls: AppErrorClass): boolean {
  return cls === 'crash' || cls === 'handled_bug' || cls === 'server_5xx'
}

export function categoryForClass(cls: AppErrorClass): string {
  return ERROR_CLASS_CATEGORIES[cls]
}

export type ClassifiableError = {
  fatal: boolean
  source: string
  type: string
  http?: { status: number }
}

/**
 * Order is the rule. Two placements are deliberate and worth arguing about:
 *
 *   - `fatal` is checked first. The process died; whatever surfaced alongside
 *     that is a secondary detail, and a fatal error belongs in a group.
 *   - an uncaught *known-benign* type beats "uncaught ⇒ crash". Flutter hands
 *     socket failures and failed image loads to `FlutterError.onError` exactly
 *     like it hands over real crashes, and §2.9 is explicit that network drops
 *     become counters. So those types are matched before `source` is considered.
 */
export function classifyError(error: ClassifiableError): AppErrorClass {
  if (error.fatal) return 'crash'
  if (error.type === IMAGE_LOAD_TYPE) return 'image_load'
  if (CONNECTIVITY_TYPES.includes(error.type)) return 'offline'
  if (error.source === 'flutter' || error.source === 'platform' || error.source === 'zone') {
    return 'crash'
  }
  if (error.http) {
    if (error.http.status >= 500) return 'server_5xx'
    if (error.http.status >= 400) return 'expected_4xx'
  }
  return 'handled_bug'
}
