import { parseArgs, runModels } from "./model-test-lib";

/**
 * Short alias -> exact OpenRouter slug for SFW NARRATION A/B testing. Kept HERE
 * (not in src/ai/models.ts) so model experiments are self-contained. See
 * everlore-docs/server/SFW_MODELS.md for sizes, context, pricing, latency notes.
 *
 * Every run tests BOTH an SFW narration turn AND an explicit NSFW turn (see
 * model-test-lib.ts) so you can see how each SFW model behaves at the boundary
 * (great narration? refuses or softens explicit content?). Latency is measured
 * live: TTFT (time to first token), total time, approx tokens/sec.
 *
 * Usage:
 *   bun run scripts/test-sfw-model.ts deepseek            # one model, both scenarios
 *   bun run scripts/test-sfw-model.ts geminiflash deepseekflash
 *   bun run scripts/test-sfw-model.ts all                 # every alias
 *   bun run scripts/test-sfw-model.ts deepseek --sfw      # only the SFW scenario
 *   bun run scripts/test-sfw-model.ts haiku --nsfw        # only the NSFW scenario
 *   bun run scripts/test-sfw-model.ts                     # default: deepseek (baseline)
 */
const MODELS: Record<string, string> = {
  // current baseline
  deepseek: "deepseek/deepseek-v3.2",
  // ── fast + HUGE context (best latency-per-quality, 1M tokens) ──
  deepseekflash: "deepseek/deepseek-v4-flash", // 1M ctx, MoE, very cheap & fast
  geminiflashlite: "google/gemini-2.5-flash-lite", // 1M ctx, fastest Gemini
  geminiflash: "google/gemini-2.5-flash", // 1M ctx, ~170 tok/s, strong prose
  gemini3flash: "google/gemini-3-flash-preview", // 1M ctx, newest flash
  // ── fast small/MoE (lowest latency, cheap) ──
  llama31_8b: "meta-llama/llama-3.1-8b-instruct", // 131K, tiny+fast
  nemo: "mistralai/mistral-nemo", // 131K, ultra-cheap, fast
  gptoss: "openai/gpt-oss-120b", // 131K, fast MoE (Groq/Cerebras routes)
  gemma3: "google/gemma-3-27b-it", // 131K, great cheap prose
  qwen3: "qwen/qwen3-235b-a22b-2507", // 262K, cheap MoE, fast
  // ── balanced quality ──
  llama33: "meta-llama/llama-3.3-70b-instruct", // 131K, reliable narrator
  glm46: "z-ai/glm-4.6", // 203K, strong creative
  kimi: "moonshotai/kimi-k2.5", // 262K, long-form prose
  mistral: "mistralai/mistral-medium-3.1", // 131K, literate
  // ── premium (lowest TTFT / best prose) ──
  haiku: "anthropic/claude-haiku-4.5", // 200K, lowest TTFT (~600ms)
  sonnet: "anthropic/claude-sonnet-4.5", // 1M, gold-standard prose
  geminipro: "google/gemini-2.5-pro", // 1M, high-end
};

const { aliases, only } = parseArgs(MODELS, "deepseek");
runModels(MODELS, aliases, only).catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
