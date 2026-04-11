const OPENAI_MODELS = new Set(['gpt-5', 'gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'])

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
  // Always use gpt-5 regardless of NSFW setting
  return 'gpt-5'
}

export function selectLogicModel(preferences: ModelPreferences): string {
  return 'gpt-5'
}

export function selectSummaryModel(preferences: ModelPreferences): string {
  return 'gpt-5'
}
