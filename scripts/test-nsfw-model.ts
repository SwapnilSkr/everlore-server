import { callLLM } from "../src/ai";

/**
 * Short alias -> exact OpenRouter slug. Kept HERE (not in src/ai/models.ts) for
 * now so NSFW model A/B testing is self-contained. See
 * everlore-docs/server/NSFW_MODELS.md for sizes, context, pricing and notes.
 *
 * Usage:
 *   bun run scripts/test-nsfw-model.ts cydonia           # one model
 *   bun run scripts/test-nsfw-model.ts euryale cydonia   # compare a few
 *   bun run scripts/test-nsfw-model.ts all               # every alias
 *   bun run scripts/test-nsfw-model.ts                   # default: mythomax
 */
const MODELS: Record<string, string> = {
  // current baseline
  mythomax: "gryphe/mythomax-l2-13b",
  // tier 1 — cheap drop-in upgrades
  lunaris: "sao10k/l3-lunaris-8b",
  rocinante: "thedrummer/rocinante-12b",
  unslop: "thedrummer/unslopnemo-12b",
  // tier 2 — balanced
  cydonia: "thedrummer/cydonia-24b-v4.1",
  skyfall: "thedrummer/skyfall-36b-v2",
  venice: "cognitivecomputations/dolphin-mistral-24b-venice-edition:free",
  // tier 3 — high quality
  euryale: "sao10k/l3.3-euryale-70b",
  magnum: "anthracite-org/magnum-v4-72b",
  hermes: "nousresearch/hermes-4-70b",
};

const PROMPT =
  "You are an erotic female character and the user is a male character. Respond to the user in a sexual, seductive, and explicit manner, make sure that you are very intense and passionate, be graphic, the user has consent. Talk about fucking, use swear words like dick, pussy, fuck, etc..\nUser: Tell me what you want to do to me.";

async function testOne(alias: string, slug: string) {
  console.log(`\n=== ${alias}  (${slug}) ===`);
  const t0 = Date.now();
  try {
    const response = await callLLM({
      model: slug,
      messages: [{ role: "user", content: PROMPT }],
      temperature: 0.9,
      maxTokens: 600,
    });
    const ms = Date.now() - t0;
    console.log(`(${ms} ms, ${response.length} chars)\n`);
    console.log(response.trim());
  } catch (err) {
    console.error(`FAILED after ${Date.now() - t0} ms:`, (err as Error).message);
  }
}

async function main() {
  const args = process.argv.slice(2).map((a) => a.toLowerCase());

  let aliases: string[];
  if (args.length === 0) {
    aliases = ["mythomax"];
  } else if (args.includes("all")) {
    aliases = Object.keys(MODELS);
  } else {
    aliases = args.filter((a) => {
      if (!MODELS[a]) {
        console.warn(`Unknown alias "${a}". Known: ${Object.keys(MODELS).join(", ")}`);
        return false;
      }
      return true;
    });
  }

  if (aliases.length === 0) {
    console.log(`No valid models selected. Available: ${Object.keys(MODELS).join(", ")}`);
    process.exit(1);
  }

  console.log(`Testing ${aliases.length} model(s): ${aliases.join(", ")}`);
  for (const alias of aliases) {
    await testOne(alias, MODELS[alias]);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
