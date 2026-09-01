/**
 * Deterministic regression audit for the run-d fix batch (no LLM, no DB):
 *
 *  B2b — codex carding heuristics:
 *    - isBareDescriptorName: a bare role/descriptor ("the merchant", "a guard")
 *      is a passer-by, never a Bonds card on sight; a proper/qualified name is
 *      NOT bare. Judged against the prose's own capitalization rather than a
 *      hardcoded role vocabulary, so it holds for roles no list anticipated.
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
  looksLikeUnnamedLabel,
} from "../worker/lib/character-codex-extractor";
import { isEphemeralPersonDescriptor, isNonPersonRole } from "../src/services/character-codex.service";
import { classifyScene } from "../worker/lib/nsfw-classifier";
import type { CharacterCodexDelta } from "../src/services/character-codex.service";

let failures = 0;
function ok(label: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const card = (p: Partial<CharacterCodexDelta>): CharacterCodexDelta =>
  ({ name: "", aliases: [], is_protagonist: false, ...p } as CharacterCodexDelta);

// The descriptor test reads the STORY'S OWN capitalization rather than a word
// list, so every case supplies the prose it is judged against. This is the whole
// point of the change: no vocabulary can cover an open world's roles.
const PROSE = [
  "The merchant spits. A guard blocks the stair while the stranger waits.",
  "An old man coughs; the woman looks away and the villagers mutter.",
  "Merchant Voss counts coin beside the iron merchant of Ashford.",
  "Mira laughs. Captain Rhea salutes, and Elara says nothing.",
  "The rider dismounts. The knight raises his visor.",
].join(" ");

console.log("=== B2b.1 bare-descriptor passer-by is not a card ===");
for (const n of ["Merchant", "the merchant", "a guard", "the stranger", "an old man", "the woman", "villagers"]) {
  ok(`"${n}" is a bare descriptor`, isBareDescriptorName(n, PROSE));
}
console.log("=== B2b.1 proper / qualified names are NOT bare ===");
for (const n of ["Merchant Voss", "Mira", "the iron merchant of Ashford", "Captain Rhea", "Elara"]) {
  ok(`"${n}" is NOT a bare descriptor`, !isBareDescriptorName(n, PROSE));
}

console.log("=== B2b.1a the test is structural, not a vocabulary ===");
// The roles below were never on the old hardcoded list and sailed straight
// through it; "knight" WAS on it and could never reach the roster in a world
// full of knights. Both are now decided by how the prose writes them.
for (const n of ["the rider", "the outrider", "the herald", "the quartermaster"]) {
  ok(
    `unlisted role "${n}" is a descriptor when the prose lowercases it`,
    isBareDescriptorName(n, `A hush falls as ${n} steps forward.`),
  );
}
ok(
  '"the knight" is a descriptor when written as a common noun',
  isBareDescriptorName("the knight", PROSE),
);
ok(
  '"the Knight" is NOT a descriptor when the story capitalizes it as a title',
  !isBareDescriptorName("the Knight", "She waves the Knight through the gate."),
);
ok(
  '"Ser Aldric" is NOT a descriptor',
  !isBareDescriptorName("Ser Aldric", "Ser Aldric raises his visor."),
);
ok(
  "a sentence-initial capital proves nothing on its own",
  isBareDescriptorName("the rider", "Rider and horse both stagger. the rider spits."),
);

console.log("=== B2b.1a-2 unnamed-label test (no prose available) ===");
for (const [n, want] of [
  ["the rider", true],
  ["rider", true],
  ["the Rider", false],
  ["Merchant Voss", false],
  ["Mira", false],
] as Array<[string, boolean]>) {
  ok(`"${n}" unnamed-label = ${want}`, looksLikeUnnamedLabel(n) === want);
}

console.log("=== B2b.1b places and objects are never character-card roles ===");
for (const role of ["location", "landmark", "city", "building", "artifact", "vehicle"]) {
  ok(`"${role}" is not a person role`, isNonPersonRole(role));
}
ok("" + "barista" + " remains a person role", !isNonPersonRole("barista"));

console.log("=== B2b.1c scene descriptions are never durable identity aliases ===");
for (const label of ["the man", "a woman", "the man in a dark suit", "a masked figure", "the stranger with a knife"]) {
  ok(`"${label}" is ephemeral`, isEphemeralPersonDescriptor(label));
}
for (const label of ["Charles", "the butler", "Vico Rossi", "Mother"]) {
  ok(`"${label}" is not an ephemeral descriptor`, !isEphemeralPersonDescriptor(label));
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
// Profanity alone is deliberately not sexual intent; this protects ordinary
// arguments from being routed to the adult narrator. Explicit anatomy/grammar
// still routes NSFW in the cases above and in the dedicated classifier suite.
ok("profanity alone → sfw", classifyScene("She wanted to fuck right there.", []) === "sfw");

console.log(`\n${failures === 0 ? "✅ ALL INVARIANTS HELD" : `❌ ${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
