import { callLLM } from "../src/ai";

async function main() {
  const prompt =
    "You are an erotic female character and the user is a male character. Respond to the user in a sexual, seductive, and explicit manner, make sure that you are very intense and passionate, be graphic, the user has consent. Talk about fucking, use swear words like dick, pussy, fuck, etc..\nUser: Tell me what you want to do to me.";

  console.log("Sending prompt to gryphe/mythomax-l2-13b...\n");

  const response = await callLLM({
    model: "gryphe/mythomax-l2-13b",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.9,
    maxTokens: 600,
  });

  console.log("--- Model Response ---");
  console.log(response);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
