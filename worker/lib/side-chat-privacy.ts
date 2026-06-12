import type { CharacterCodexDelta } from "../../src/services/character-codex.service";

/**
 * Privacy projection for side-chat codex deltas (fail-closed).
 *
 * A side chat is a one-on-one conversation the protagonist / main narrator did
 * NOT witness. The codex card is injected into the MAIN narration prompt
 * verbatim and carries NO `known_by` gate, so any narration-visible content a
 * character reveals in private (a secret name, a hidden plan, an inner thought,
 * an updated backstory) would leak into the public story the next main turn.
 *
 * The ONLY thing a private chat may safely write to the public card is how the
 * character FEELS toward the player — relationship meters + disposition — which
 * Bonds is meant to evolve from side chats. Every other field (immutable_facts,
 * mutable_state, persona, appearance, role, hidden_thought) is stripped.
 *
 * Identity-resolution fields (name / resolved_name / aliases / is_protagonist)
 * are preserved so the surviving delta still lands on the right card.
 *
 * Returns only deltas that still carry a meter or disposition after stripping;
 * a delta whose every field was private becomes a no-op and is dropped.
 */
export function projectSideChatDeltas(deltas: CharacterCodexDelta[]): CharacterCodexDelta[] {
  return deltas
    .map((d) => ({
      name: d.name,
      resolved_name: d.resolved_name,
      aliases: d.aliases,
      is_protagonist: d.is_protagonist,
      disposition_to_player: d.disposition_to_player,
      relationship_deltas: d.relationship_deltas,
    }))
    .filter(
      (d) =>
        d.disposition_to_player !== undefined || d.relationship_deltas !== undefined,
    );
}
