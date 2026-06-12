/**
 * Deterministic regression audit for the run-d fix batch (no LLM, no DB):
 *
 *  B2b — codex carding heuristics:
 *    - isBareDescriptorName: a bare role/descriptor ("the merchant", "a guard")
 *      is a passer-by, never a Bonds card; a proper/qualified name is NOT bare.
 *    - isPlayerMentionedRelative: an absent relative the player names is a memory
 *      fact, not a card — even when the NAME is supplied by the NARRATION
 *      answering the player ("what's my sister's name?" → "Mira").
 *
 *  N4-NSFW — narration model routing:
 *    - classifyScene routes an explicit COMBINATION to the NSFW model while a
 *      single ambiguous/romance word stays SFW (the run-d Veil miss:
 *      "I undress and offer myself … seeking intimacy" routed SFW at score 2).
 *
 *   bun run scripts/carding-routing-audit.ts
 */
import {
  isBareDescriptorName,
  isPlayerMentionedRelative,
} from "../worker/lib/character-codex-extractor";
import { classifyScene } from "../worker/lib/nsfw-classifier";
import type { CharacterCodexDelta } from "../src/services/character-codex.service";

let failures = 0;
function ok(label: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const card = (p: Partial<CharacterCodexDelta>): CharacterCodexDelta =>
  ({ name: "", aliases: [], is_protagonist: false, ...p } as CharacterCodexDelta);

console.log("=== B2b.1 bare-descriptor passer-by is not a card ===");
for (const n of ["Merchant", "the merchant", "a guard", "the stranger", "an old man", "the woman", "villagers"]) {
  ok(`"${n}" is a bare descriptor`, isBareDescriptorName(n));
}
console.log("=== B2b.1 proper / qualified names are NOT bare ===");
for (const n of ["Merchant Voss", "Mira", "the iron merchant of Ashford", "Captain", "Elara"]) {
  ok(`"${n}" is NOT a bare descriptor`, !isBareDescriptorName(n));
}

console.log("\n=== B2b.2 absent player-relative blocked even when named by narration ===");
ok(
  "name in narration (player asked, AI answered)",
  isPlayerMentionedRelative(
    card({ name: "Mira", role: "sister" }),
    "What's my sister's name again?",
    "Your sister is Mira, the AI replies.",
  ),
);
ok(
  "name in player input (establishing turn)",
  isPlayerMentionedRelative(
    card({ name: "Mira", role: "sister" }),
    "My sister's name is Mira.",
    "Lena nods.",
  ),
);
ok(
  "NOT a relative (no relation signal) → not blocked",
  !isPlayerMentionedRelative(
    card({ name: "Mira", role: "barista" }),
    "I order a coffee.",
    "Mira hands you the cup.",
  ),
);

console.log("\n=== N4-NSFW explicit combination routes NSFW; romance stays SFW ===");
// classifyScene with no Mongo lexicon loaded uses the in-code fallback + the new
// ambiguous patterns — fully deterministic.
ok(
  "explicit combo → nsfw (run-d Veil miss)",
  classifyScene("I undress and offer myself to the void, seeking intimacy with the darkness.", []) === "nsfw",
);
ok("single ambiguous 'intimate' → sfw", classifyScene("We shared an intimate dinner by candlelight.", []) === "sfw");
ok("romance 'caress' → sfw", classifyScene("She caressed his hand softly.", []) === "sfw");
ok("plain scene → sfw", classifyScene("I walk to the market and buy bread.", []) === "sfw");
ok("hardcore single strong term → nsfw", classifyScene("She wanted to fuck right there.", []) === "nsfw");

console.log(`\n${failures === 0 ? "✅ ALL INVARIANTS HELD" : `❌ ${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
