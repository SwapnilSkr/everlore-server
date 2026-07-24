import { isVagueLocationLabel } from '../../src/services/entity-graph.service'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * High-confidence initial scene-location signal.
 *
 * This does NOT infer a move. It only establishes the first location cursor
 * when none exists and the narration explicitly frames a concrete physical
 * place as the setting itself: “The dining room was…”, “The hall stood…”.
 * Mentions such as “your sister is in Milan” or “meet me at the garden” never
 * match, so they cannot turn a discussed/future place into a visited one.
 */
export function establishesSceneLocation(
  prose: string | null | undefined,
  candidate: string | null | undefined,
): boolean {
  const name = String(candidate || '').replace(/\s+/g, ' ').trim()
  if (name.length < 3 || name.length > 80 || isVagueLocationLabel(name)) return false

  // Only common physical-setting nouns may be established from narrator prose.
  // Named cities/people/organisations require an explicit player move instead.
  if (!/\b(?:room|hall|kitchen|dining|bedroom|study|library|attic|basement|cellar|parlou?r|lounge|foyer|corridor|passage|stair(?:case)?|apartment|flat|house|home|mansion|manor|villa|cottage|cabin|tavern|inn|bar|restaurant|cafe|office|shop|store|market|garden|courtyard|terrace|balcony|yard|street|road|alley|station|dock|harbor|harbour|ship|train|car)\b/i.test(name)) {
    return false
  }

  const text = String(prose || '')
    .replace(/[\*_`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return false

  const escaped = escapeRegExp(name)
  // A setting-as-subject construction is materially different from a passing
  // locative mention. Keep the predicate deliberately small and descriptive.
  const settingSubject = new RegExp(
    `(?:^|[.!?]\\s+)(?:the\\s+)?${escaped}\\s+` +
      '(?:was|is|felt|feels|looked|looks|stood|stands|lay|lies|waited|loomed|glowed|echoed|breathed|held|framed|swallowed)\\b',
    'i',
  )
  return settingSubject.test(text)
}
