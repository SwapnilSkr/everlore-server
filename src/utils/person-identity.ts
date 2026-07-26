/**
 * Atmosphere, abstractions, and scene objects that prose frequently
 * personifies ("Silence answers", "Fear waits") but which must never become
 * automatic characters. A real character using one of these names still has a
 * deliberate escape hatch: an explicit in-scene self-introduction is handled
 * by the codex extractor before a new card is allowed.
 */
const ABSTRACT_NON_PERSON_TERMS = new Set([
  'silence', 'darkness', 'light', 'shadow', 'shadows', 'echo', 'echoes',
  'memory', 'memories', 'fear', 'anger', 'grief', 'death', 'fate', 'time', 'valour', 'valor',
  'night', 'morning', 'evening', 'rain', 'wind', 'air', 'fire', 'flame',
  'smoke', 'sound', 'noise', 'voice', 'voices',
])

function normalizedIdentity(value: string | null | undefined): string {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s'-]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:the|a|an)\s+/, '')
    .trim()
}

export function isAbstractNonPersonTerm(value: string | null | undefined): boolean {
  return ABSTRACT_NON_PERSON_TERMS.has(normalizedIdentity(value))
}
