/**
 * Deterministic audit for the two HIGH playtest fixes (no LLM, no DB):
 *
 *  A. Sentient side-chat leak via the GENERATION PROMPT.
 *     A secret a side character reveals in a private chat (its name, hidden
 *     thought, plan) must NEVER reach the codex card the MAIN narrator reads.
 *     projectSideChatDeltas keeps only meters/disposition and strips every
 *     narration-visible content field. Verified mechanism: instance
 *     6a2bea89626fb837070f2b72, Jora's hidden_thought + mutable_state carried
 *     the "Umbral Gate" secret into main narration.
 *
 *  B. Player minted as a codex card on self-intro.
 *     detectSelfIntroName must pull the name the player introduces for THEMSELVES
 *     ("I'm Kael", "call me Swapnil", "my name is Alex") so the guard can drop
 *     any codex delta that would card the player alongside the player entity.
 *
 *   bun run scripts/side-chat-privacy-audit.ts
 */
import { projectSideChatDeltas } from "../worker/lib/side-chat-privacy";
import { detectSelfIntroName } from "../worker/processors/generation.processor";
import type { CharacterCodexDelta } from "../src/services/character-codex.service";

let failures = 0;
function ok(label: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

console.log("=== A. Side-chat privacy projection (no secret bleeds to the public card) ===");
{
  // The real leak shape from instance 6a2bea89…: Jora's private revelation.
  const joraSecret: CharacterCodexDelta = {
    name: "Jora",
    aliases: [],
    immutable_facts: ["knows a secret path through the marrow"],
    mutable_state: ["knows the rift's true name is the Umbral Gate"],
    persona: "whispers secrets, carries the weight of desperation",
    appearance: "hollow-eyed, at the void's edge",
    role: "wanderer",
    hidden_thought: "The name of the rift is a burden she carries.",
    disposition_to_player: "trusts the player with a dangerous secret",
    relationship_deltas: { trust: 4 },
    is_protagonist: false,
  };
  const [out] = projectSideChatDeltas([joraSecret]);
  ok("delta survives (carries a meter/disposition)", !!out);
  ok("immutable_facts stripped", !out?.immutable_facts);
  ok("mutable_state (the secret name) stripped", !out?.mutable_state);
  ok(
    "no 'Umbral' anywhere in the projected delta",
    !/umbral|marrow|rift/i.test(JSON.stringify(out)),
    JSON.stringify(out),
  );
  ok("hidden_thought stripped", !out?.hidden_thought);
  ok("persona stripped", !out?.persona);
  ok("appearance stripped", !out?.appearance);
  ok("identity (name) preserved", out?.name === "Jora");
  ok("meters preserved", out?.relationship_deltas?.trust === 4);
  ok("disposition preserved", !!out?.disposition_to_player);
}
{
  // A pure content-only delta (no meters, no disposition) becomes a no-op.
  const contentOnly: CharacterCodexDelta = {
    name: "Jora",
    aliases: [],
    immutable_facts: ["the rift's true name is the Umbral Gate"],
    mutable_state: [],
    is_protagonist: false,
  };
  ok(
    "content-only private delta is dropped entirely",
    projectSideChatDeltas([contentOnly]).length === 0,
  );
}

console.log("\n=== B. Player self-intro name detection ===");
{
  const cases: Array<[string, string | null]> = [
    ["I'm Kael, by the way.", "Kael"],
    ["call me Swapnil", "Swapnil"],
    ["My name is Alex.", "Alex"],
    ["I am Lena", "Lena"],
    ["they call me Veyra Lin", "Veyra Lin"],
    // run-d #5: greeting + self-intro + trailing clause (the exact phrasing that
    // slipped a "Swapnil" card onto Lena). The detector caught it; the carding
    // came from the alias persist racing later turns (now awaited).
    ["Hi Lena. I'm Swapnil — just moved here last month.", "Swapnil"],
    ["I'm sorry about earlier", null],
    ["I am here to help", null],
    ["I look around the room.", null],
    ["She said her name is Mira.", null], // third-person self-intro is NOT the player; correctly ignored
  ];
  for (const [input, expected] of cases) {
    const got = detectSelfIntroName(input);
    ok(`detect("${input}") = ${JSON.stringify(expected)}`, got === expected, `got ${JSON.stringify(got)}`);
  }
}

console.log(`\n${failures === 0 ? "✅ ALL INVARIANTS HELD" : `❌ ${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
