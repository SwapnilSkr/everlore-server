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
  deepseekv4pro: "deepseek/deepseek-v4-pro", // 1M ctx, v3.2 successor
  qwen35flash: "qwen/qwen3.5-flash-02-23", // 1M ctx, cheapest 1M
  mimo25: "xiaomi/mimo-v2.5", // 1M ctx, strong value
  mimo25pro: "xiaomi/mimo-v2.5-pro", // 1M ctx, premium long-horizon
  qwen35plus: "qwen/qwen3.5-plus-20260420", // 1M ctx, multimodal Plus
  qwen35plus15: "qwen/qwen3.5-plus-02-15", // 1M ctx, cheaper Plus
  qwen37max: "qwen/qwen3.7-max", // 1M ctx, Qwen 3.7 flagship
  owlalpha: "openrouter/owl-alpha", // 1M ctx, free, OR RP #3
  gemini35flash: "google/gemini-3.5-flash", // 1M ctx, newest Gemini flash
  geminiflashlite: "google/gemini-2.5-flash-lite", // 1M ctx, fastest Gemini
  geminiflashliteprev: "google/gemini-2.5-flash-lite-preview-09-2025", // 1M alt lite
  geminiflash: "google/gemini-2.5-flash", // 1M ctx, ~170 tok/s, strong prose
  gemini3flash: "google/gemini-3-flash-preview", // 1M ctx, OR RP top-10
  // ── fast small/MoE (lowest latency, cheap) ──
  llama31_8b: "meta-llama/llama-3.1-8b-instruct", // 131K, tiny+fast
  nemo: "mistralai/mistral-nemo", // 131K, ultra-cheap, fast
  gptoss: "openai/gpt-oss-120b", // 131K, fast MoE (Groq/Cerebras routes)
  gemma3: "google/gemma-3-27b-it", // 131K, great cheap prose
  qwen3: "qwen/qwen3-235b-a22b-2507", // 262K, cheap MoE, fast
  seed16flash: "bytedance-seed/seed-1.6-flash", // 262K, ultra-fast
  qwennext80: "qwen/qwen3-next-80b-a3b-instruct", // 262K, cheap instruct MoE
  gemma4: "google/gemma-4-26b-a4b-it", // 262K, OR RP #9
  gemma431: "google/gemma-4-31b-it", // 262K, dense Gemma 4
  mimoflash: "xiaomi/mimo-v2-flash", // 262K, cheap MiMo
  ling26flash: "inclusionai/ling-2.6-flash", // 262K, $0.01/$0.03
  deepseekv31: "deepseek/deepseek-chat-v3.1", // 164K, hybrid V3.1
  step35flash: "stepfun/step-3.5-flash", // 262K, StepFun MoE
  // ── balanced quality ──
  llama33: "meta-llama/llama-3.3-70b-instruct", // 131K, reliable narrator
  glm46: "z-ai/glm-4.6", // 203K, strong creative
  glm47: "z-ai/glm-4.7", // 203K, glm 4.6 upgrade
  glm47flash: "z-ai/glm-4.7-flash", // 203K, budget GLM
  glm5: "z-ai/glm-5", // 203K, latest flagship
  kimi: "moonshotai/kimi-k2.5", // 262K, long-form prose
  kimi26: "moonshotai/kimi-k2.6", // 262K, k2.5 successor
  mistral: "mistralai/mistral-medium-3.1", // 131K, literate
  mistralsmall32: "mistralai/mistral-small-3.2-24b-instruct", // 128K, Cydonia base (censored)
  qwen35_35b: "qwen/qwen3.5-35b-a3b", // 262K, mid Qwen 3.5
  qwen35_122b: "qwen/qwen3.5-122b-a10b", // 262K, large Qwen 3.5
  llama4maverick: "meta-llama/llama-4-maverick", // 1M, Llama 4 MoE
  llama4scout: "meta-llama/llama-4-scout", // 10M, extreme ctx
  grok43: "x-ai/grok-4.3", // 1M, xAI
  grok420: "x-ai/grok-4.20", // 2M, xAI
  glm45air: "z-ai/glm-4.5-air", // 131K, light GLM MoE
  // ── premium (lowest TTFT / best prose) ──
  haiku: "anthropic/claude-haiku-4.5", // 200K, lowest TTFT (~600ms)
  sonnet: "anthropic/claude-sonnet-4.5", // 1M, gold-standard prose
  sonnet46: "anthropic/claude-sonnet-4.6", // 1M, newer Sonnet
  opus46: "anthropic/claude-opus-4.6", // 1M, top prose tier
  opus47: "anthropic/claude-opus-4.7", // 1M, OR RP #5
  opus48: "anthropic/claude-opus-4.8", // 1M, latest Opus
  geminipro: "google/gemini-2.5-pro", // 1M, high-end
  gpt51: "openai/gpt-5.1", // 400K, creative writing lineage
  gpt5chat: "openai/gpt-5-chat", // 128K, chat-tuned
  gpt52chat: "openai/gpt-5.2-chat", // 128K, fast chat
  glm51: "z-ai/glm-5.1", // 203K, GLM coding/agent
};

const { aliases, only } = parseArgs(MODELS, "deepseek");
runModels(MODELS, aliases, only).catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
