/**
 * world_derivations — a model answer that depends only on a world's authored
 * text, stored once per exact input.
 *
 * `_id` is the key, not a minted id: `${kind}:${version}:${sha256(input)}`. The
 * input is exactly the text sent to the model, so editing a world produces a
 * new key on its own and nothing has to be invalidated.
 *
 * A row holds only what the model decided. Nothing here names a player, an
 * instance or a world: the answer is the same for every save of that text.
 */
export const WORLD_DERIVATIONS_COLLECTION = 'world_derivations'

export type WorldDerivationKind = 'calendar' | 'opening_place' | 'opening_language'

export interface WorldDerivationDoc<T = unknown> {
  /** `${kind}:${version}:${sha256(input)}`. */
  _id: string
  kind: WorldDerivationKind
  value: T
  created_at: Date
}
