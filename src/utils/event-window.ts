export const EVENT_WINDOWS = {
  promptRecentEvents: 6,
  loadInstanceRecentEvents: 20,
  chroniclePageSize: 50,
} as const

export function buildEventWindow(total: number, loaded: number) {
  return {
    limit: EVENT_WINDOWS.loadInstanceRecentEvents,
    total,
    hasOlder: total > loaded,
  }
}
