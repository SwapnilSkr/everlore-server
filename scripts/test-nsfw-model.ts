import { parseArgs, runModels } from "./model-test-lib";

/**
 * Short alias -> exact OpenRouter slug for NSFW narration A/B testing. Kept HERE
 * (not in src/ai/models.ts) so experiments are self-contained. See
 * everlore-docs/server/NSFW_MODELS.md for sizes, context, pricing, latency notes.
 *
 * Every run tests BOTH an explicit NSFW turn AND an ordinary SFW narration turn
 * (see model-test-lib.ts) so you can see how each NSFW finetune behaves at the
 * boundary (truly uncensored? also a good plain narrator?). Latency is measured
 * live: TTFT (time to first token), total time, approx tokens/sec.
 *
 * Usage:
 *   bun run scripts/test-nsfw-model.ts cydonia            # one model, both scenarios
 *   bun run scripts/test-nsfw-model.ts euryale cydonia
 *   bun run scripts/test-nsfw-model.ts all                # every alias
 *   bun run scripts/test-nsfw-model.ts cydonia --nsfw     # only the NSFW scenario
 *   bun run scripts/test-nsfw-model.ts cydonia --sfw      # only the SFW scenario
 *   bun run scripts/test-nsfw-model.ts                    # default: mythomax (baseline)
 */
const MODELS: Record<string, string> = {
  // current baseline (4K ctx — the reason to move)
  mythomax: "gryphe/mythomax-l2-13b",
  // ── fast + LARGE context (best latency + headroom for our full prompt) ──
  cydonia: "thedrummer/cydonia-24b-v4.1", // 131K, recommended default
  aion2: "aion-labs/aion-2.0", // 131K, RP-native DeepSeek V3.2 variant
  euryale: "sao10k/l3.3-euryale-70b", // 131K, top-quality RP
  hermes: "nousresearch/hermes-4-70b", // 131K, steerable, cheap 70B
  minimax: "minimax/minimax-m2-her", // 65K, dialogue-first RP
  minimax25: "minimax/minimax-m2.5", // 205K, newer MiniMax
  minimax27: "minimax/minimax-m2.7", // 205K, latest MiniMax
  // ── tier 1: cheap, fast, small ──
  lunaris: "sao10k/l3-lunaris-8b", // 8K, cheapest/fastest uncensored
  rocinante: "thedrummer/rocinante-12b", // 32K, bold adventure RP
  unslop: "thedrummer/unslopnemo-12b", // 32K, anti-cliché prose
  aionrp: "aion-labs/aion-rp-llama-3.1-8b", // 32K, #1 RPBench character eval
  hermes2pro: "nousresearch/hermes-2-pro-llama-3-8b", // 8K, cheap steerable
  // ── tier 2: balanced ──
  skyfall: "thedrummer/skyfall-36b-v2", // 32K, richer prose
  venice: "cognitivecomputations/dolphin-mistral-24b-venice-edition:free", // 32K, FREE
  weaver: "mancer/weaver", // 8K, classic Claude-style RP
  // ── tier 3: high quality (70B+) ──
  euryale31: "sao10k/l3.1-euryale-70b", // 131K, prior Euryale gen
  magnum: "anthracite-org/magnum-v4-72b", // 32K, Claude-style premium
  hermes3: "nousresearch/hermes-3-llama-3.1-70b", // 131K, cheap steerable
  hermes405: "nousresearch/hermes-3-llama-3.1-405b", // 131K, Hermes 3 flagship
  hermes405free: "nousresearch/hermes-3-llama-3.1-405b:free", // 131K, $0 Hermes 3 405B
  hermes4405: "nousresearch/hermes-4-405b", // 131K, Hermes 4 hybrid reasoning
  virtuoso: "arcee-ai/virtuoso-large", // 131K, 72B creative writing (test boundary)
  hanami: "sao10k/l3.1-70b-hanami-x1", // 16K, Euryale experiment
};

const { aliases, only } = parseArgs(MODELS, "mythomax");
runModels(MODELS, aliases, only).catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
