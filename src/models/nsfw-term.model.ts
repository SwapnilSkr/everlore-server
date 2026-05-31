import type { ObjectId } from 'mongodb'

/**
 * A single entry in the NSFW lexicon used by the narration router to decide
 * whether a turn should go to the explicit (NSFW) model.
 *
 * The collection stores the FULL imported list (including weight-0 profanity that
 * should NOT route narration) so it doubles as a tunable moderation dictionary.
 * The classifier only loads terms with `weight >= 1`.
 */
export type NsfwTermCategory =
  | 'anatomy'   // body parts (cock, clit, nipple...)
  | 'act'       // sexual acts (thrust, blowjob, intercourse...)
  | 'fluid'     // bodily fluids (cum, precum...)
  | 'descriptor'// arousal/intensity descriptors (aroused, throbbing, wet...)
  | 'apparel'   // sexualized apparel (lingerie, panties...)
  | 'profanity' // general cursing / slurs / brands — stored, not routed (weight 0)
  | 'other'

export interface NsfwTermDoc {
  _id: ObjectId
  /** Normalized lowercase term or phrase. */
  term: string
  /** True when `term` contains spaces → matched as a substring, not a whole word. */
  is_phrase: boolean
  category: NsfwTermCategory
  /**
   * Routing contribution. 0 = stored only (not used by the router), 1 = mild
   * sexual signal, 2 = strong/graphic signal. The classifier sums weights and
   * compares against its threshold.
   */
  weight: number
  /** Provenance: 'curated' (hand-authored, high-signal) or 'ldnoobw' (imported list). */
  source: string
  created_at: Date
  updated_at: Date
}
