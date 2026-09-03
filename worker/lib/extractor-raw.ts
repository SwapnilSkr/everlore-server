import type { ExtractorStage } from '../../src/models/extractor-raw.model'

const STAGE_CAP = 32_000

export function createExtractorRawSink() {
  const stages: Partial<Record<ExtractorStage, string>> = {}
  const capture = (stage: ExtractorStage) => (raw: string) => {
    stages[stage] = String(raw || '').slice(0, STAGE_CAP)
  }
  return { stages, capture }
}
