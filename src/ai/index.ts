/**
 * Central AI module. Every model the backend uses, and every LLM/embedding
 * call, lives here. Import from `../ai` (or `../../src/ai` from the worker):
 *
 *   import { callLLM, callLLMStream, embed, AI_MODELS } from '../ai'
 *
 * To change which model a given task uses, edit `./models.ts` (or its env
 * override). Nothing else needs to change.
 */
export { AI_MODELS, type AiModelKey } from './models'
export { callLLM, callLLMStream, callLLMWithFallback, callLLMStreamWithFallback, type LLMFirstTokenHedge } from './client'
export { runWithLLMUsage, snapshotLLMUsage, isLLMUsageActive, type LLMCallUsage } from './usage'
export { narrationTemperature } from './narration-profile'
export { embed, embedQuery, embedBatch, isEmbedTimeout, EmbedTimeoutError } from './embedding'
export { generateImage } from './image'
export { submitVideo, pollVideo, awaitVideo, downloadVideo } from './video'
export { synthesizeSpeech, type TtsRequest, type TtsResult, type TtsResponseFormat } from './tts'
