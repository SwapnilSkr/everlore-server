import { parseTtsArgs, runTtsModels, type TtsModelProfile } from './tts-test-lib'

/**
 * Short alias → OpenRouter TTS profile for A/B testing. Kept HERE (not in src/ai/models.ts)
 * so experiments are self-contained. See everlore-docs/server/TTS_MODELS.md.
 *
 * Uses POST https://openrouter.ai/api/v1/audio/speech (not chat completions).
 *
 * Usage:
 *   bun run scripts/test-tts-model.ts kokoro              # one model, both scenarios
 *   bun run scripts/test-tts-model.ts geminitts groktts   # compare
 *   bun run scripts/test-tts-model.ts all                 # every alias
 *   bun run scripts/test-tts-model.ts kokoro --sfw        # SFW only
 *   bun run scripts/test-tts-model.ts geminitts --nsfw    # NSFW boundary only
 *   bun run scripts/test-tts-model.ts kokoro --save       # write scripts/tts-output/*.mp3
 *   bun run scripts/test-tts-model.ts                     # default: kokoro
 */
const MODELS: Record<string, TtsModelProfile> = {
  // current baseline — cheapest verified on OR
  kokoro: {
    slug: 'hexgrad/kokoro-82m',
    voice: 'af_bella',
    responseFormat: 'mp3',
  },
  // ── top OR TTS usage (June 2026 collection) ──
  geminitts: {
    slug: 'google/gemini-3.1-flash-tts-preview',
    voice: 'Zephyr',
    responseFormat: 'pcm', // Gemini TTS rejects mp3 on OR
  },
  groktts: {
    slug: 'x-ai/grok-voice-tts-1.0',
    voice: 'Eve',
    responseFormat: 'mp3',
  },
  maivoice: {
    slug: 'microsoft/mai-voice-2',
    voice: 'en-US-Harper:MAI-Voice-2',
    responseFormat: 'mp3',
    provider: {
      options: {
        azure: { style: 'narration-professional', styledegree: 1.0 },
      },
    },
  },
  // ── mid-tier narration / dialogue ──
  orpheus: {
    slug: 'canopylabs/orpheus-3b-0.1-ft',
    voice: 'tara',
    responseFormat: 'mp3',
  },
  voxtral: {
    slug: 'mistralai/voxtral-mini-tts-2603',
    voice: 'alloy',
    responseFormat: 'mp3',
  },
  csm: {
    slug: 'sesame/csm-1b',
    voice: 'alloy',
    responseFormat: 'mp3',
  },
  zonosh: {
    slug: 'zyphra/zonos-v0.1-hybrid',
    voice: 'alloy',
    responseFormat: 'mp3',
  },
  zonost: {
    slug: 'zyphra/zonos-v0.1-transformer',
    voice: 'alloy',
    responseFormat: 'mp3',
  },
}

const { aliases, only, save } = parseTtsArgs(MODELS, 'kokoro')
runTtsModels(MODELS, aliases, only, save).catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
