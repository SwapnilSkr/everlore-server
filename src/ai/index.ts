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
export { callLLM, callLLMStream } from './client'
export { embed, embedBatch } from './embedding'
