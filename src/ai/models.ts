import { env } from '../config/env'

/**
 * ============================================================================
 *  AI MODEL MAP — the SINGLE SOURCE OF TRUTH for every model the backend calls.
 * ============================================================================
 *
 * Every AI call in the codebase reads its model from this object — there are no
 * hardcoded model strings anywhere else. To swap or A/B a model, change the
 * value here, or override it via the matching environment variable (no code
 * change / redeploy of logic needed).
 *
 * Provider routing is automatic (see ./client.ts): known OpenAI model ids go to
 * the OpenAI API; everything else (e.g. `deepseek/…`, `gryphe/…`) goes to
 * OpenRouter. So you can point any entry at an OpenRouter model freely.
 *
 *  PURPOSE              MODEL (default)              STREAMED?  PROVIDER   ENV OVERRIDE
 *  ───────────────────────────────────────────────────────────────────────────────────
 *  narrationSfw         deepseek/deepseek-v3.2       yes        OpenRouter NARRATION_SFW_MODEL
 *  narrationNsfw        gryphe/mythomax-l2-13b       yes        OpenRouter NARRATION_NSFW_MODEL
 *  metadata             gpt-4o-mini                  no         OpenAI     MODEL_METADATA
 *  memoryCuration       gpt-4o-mini                  no         OpenAI     MODEL_MEMORY_CURATION
 *  sceneSummary         gpt-4o-mini                  no         OpenAI     MODEL_SCENE_SUMMARY
 *  codexExtraction      gpt-4o-mini                  no         OpenAI     MODEL_CODEX_EXTRACTION
 *  codexCompaction      gpt-4o-mini                  no         OpenAI     MODEL_CODEX_COMPACTION
 *  protagonistDerive    gpt-4o-mini                  no         OpenAI     MODEL_PROTAGONIST_DERIVE
 *  embedding            text-embedding-3-small       —          OpenAI     MODEL_EMBEDDING
 *  image                bytedance-seed/seedream-4.5  —          OpenRouter IMAGE_MODEL
 *  authoring            google/gemini-2.5-flash-lite —          OpenRouter AUTHORING_MODEL
 *  tts                  hexgrad/kokoro-82m           —          OpenRouter TTS_MODEL
 */
export const AI_MODELS = {
  /** Main story narration, SFW. Streamed token-by-token (TTFT-critical). Prose only. */
  narrationSfw: env.NARRATION_SFW_MODEL,

  /** Main story narration, NSFW / uncensored. Streamed. Prose only. */
  narrationNsfw: env.NARRATION_NSFW_MODEL,

  /** Derives stat/flag mutations, scene tag, and tone from finished prose (NSFW path). */
  metadata: process.env.MODEL_METADATA || 'gpt-4o-mini',

  /** Extracts long-term memories from a completed turn. */
  memoryCuration: process.env.MODEL_MEMORY_CURATION || 'gpt-4o-mini',

  /** Compresses a block of turns into a 2-paragraph scene (chapter) summary. */
  sceneSummary: process.env.MODEL_SCENE_SUMMARY || 'gpt-4o-mini',

  /** Extracts emergent character-codex deltas (facts, state, disposition) from a turn. */
  codexExtraction: process.env.MODEL_CODEX_EXTRACTION || 'gpt-4o-mini',

  /** Distills an overgrown character fact list back down (compaction). */
  codexCompaction: process.env.MODEL_CODEX_COMPACTION || 'gpt-4o-mini',

  /** Derives a sentient world's locked protagonist (name/persona) from its seed prompt. */
  protagonistDerive: process.env.MODEL_PROTAGONIST_DERIVE || 'gpt-4o-mini',

  /** Embedding model for ALL vector stores (world lore + per-instance memories). */
  embedding: process.env.MODEL_EMBEDDING || 'text-embedding-3-small',

  /** Cheap judge for optional, gated signal passes: memory-recall re-ranking
   *  (RAG_RERANK_ENABLED) and borderline-NSFW intent (NSFW_INTENT_DEFER_ENABLED).
   *  Default gpt-4o-mini (direct OpenAI key). Keep NON-Claude for cost; any
   *  non-OpenAI id routes via OpenRouter — see ./client.ts. Set CHEAP_RANK_MODEL. */
  cheapRank: env.CHEAP_RANK_MODEL,

  /** Image generation (world/character avatars + chat backgrounds). OpenRouter,
   *  modalities:["image","text"]. Default Seedream 4.5 — anime-strong, cheap,
   *  fast. Override via IMAGE_MODEL. See server/IMAGE_MODELS.md for alternates. */
  image: env.IMAGE_MODEL,

  /** One-shot creation autofill — drafts an entire world/character from a brief.
   *  Default gemini-2.5-flash-lite (cheap, fast, 1M ctx, strong JSON + creative).
   *  Override via AUTHORING_MODEL. */
  authoring: env.AUTHORING_MODEL,

  /** Text-to-speech for reading narration aloud. OpenRouter /audio/speech.
   *  Default Kokoro 82M — cheapest. Override via TTS_MODEL. See server/TTS_MODELS.md. */
  tts: env.TTS_MODEL,
} as const

export type AiModelKey = keyof typeof AI_MODELS
