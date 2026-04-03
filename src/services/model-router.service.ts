const OPENAI_MODELS = new Set(['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'])

interface ModelPreferences {
  logic?: string
  narration_nsfw?: string
  narration_sfw?: string
  summary?: string
}

export function isOpenAIModel(model: string): boolean {
  return OPENAI_MODELS.has(model)
}

export function selectNarrationModel(
  preferences: ModelPreferences,
  isNsfw: boolean,
): string {
  if (isNsfw && preferences.narration_nsfw) {
    return preferences.narration_nsfw
  }
  return preferences.narration_sfw || 'gpt-4o'
}

export function selectLogicModel(preferences: ModelPreferences): string {
  return preferences.logic || 'gpt-4o'
}

export function selectSummaryModel(preferences: ModelPreferences): string {
  return preferences.summary || 'gpt-4o-mini'
}
