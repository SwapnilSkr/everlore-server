import type { ObjectId } from 'mongodb'
import type { RelationshipInitialization, RelationshipState } from '../utils/relationship-baseline'
import type { CharacterIdentityKind } from './character-profile.model'

export interface StatDefinitionDoc {
  default: number
  min: number
  max: number
  description: string
}

export interface FlagDefinitionDoc {
  type: 'boolean' | 'integer' | 'string'
  default: unknown
  description: string
}

/** All optional — narration models default to env (NARRATION_SFW_MODEL /
 *  NARRATION_NSFW_MODEL); a template may override per-world. */
export interface ModelPreferencesDoc {
  logic?: string
  narration_nsfw?: string
  narration_sfw?: string
  summary?: string
}

/** The locked main persona of a sentient template (the character you talk TO).
 *  Seeded deterministically into the instance codex at creation. */
export interface ProtagonistDoc {
  name: string
  persona?: string
  appearance?: string
}

/**
 * An authored, immutable-at-start cast definition. It belongs to the template,
 * never to a shared runtime codex: every instance receives its own independent
 * character cards so later memories, relationships, and state can diverge.
 */
export interface TemplateCastCharacterDoc {
  name: string
  identity_kind?: CharacterIdentityKind
  aliases?: string[]
  role?: string
  appearance?: string
  persona?: string
  immutable_facts?: string[]
  /** Grounded starting bond toward the player, copied into each instance at sequence 0. */
  relationship_initialization?: RelationshipInitialization
  relationship_state?: RelationshipState
}

/**
 * world_templates — authored worlds (draft or published).
 */
export interface WorldTemplateDoc {
  _id: ObjectId
  creator_id: ObjectId
  title: string
  slug: string
  description: string
  /** 'world' = RPG experience (stats, GM or sentient). 'character' = lightweight
   *  chat-with-a-character (always sentient, stats optional). Defaults to 'world'. */
  kind?: 'world' | 'character'
  is_published: boolean
  /**
   * Moderation state, set only by an admin acting on a report.
   *
   * 'hidden' takes a world out of discovery and blocks new playthroughs while
   * leaving the creator's own copy and existing playthroughs intact — the
   * reversible action. Deleting is still available for content that must go.
   * Absent means never moderated, which is the same as 'active'.
   */
  moderation_status?: 'active' | 'hidden'
  moderation_reason?: string
  moderated_at?: Date
  /** Admin username from Basic auth that last changed {@link moderation_status}. */
  moderated_by?: string
  is_sentient: boolean
  is_nsfw_capable: boolean
  version: number
  seed_prompt: string
  global_lore: string
  /** Default narrative voice preset for this world/character (see
   *  narrative-styles.ts). Players may override per-conversation. */
  narrative_style?: string
  /** Optional free-text style refinements appended to the voice block. */
  style_notes?: string
  /** CDN URL of the generated avatar/background image (served via CloudFront). */
  image_url?: string
  /** The visual prompt used to generate {@link image_url} (for re-rolls/editing). */
  image_prompt?: string
  /** Optional first message a sentient persona/character greets the player with. */
  opening_line?: string
  /** Locked main persona for sentient templates (deterministic protagonist). */
  protagonist?: ProtagonistDoc
  /** AI-extracted, creator-authored starting cast, excluding the protagonist. */
  seed_cast?: TemplateCastCharacterDoc[]
  base_stats_template: Record<string, StatDefinitionDoc>
  flag_definitions: Record<string, FlagDefinitionDoc>
  scene_tags: string[]
  model_preferences: ModelPreferencesDoc
  max_context_memories: number
  max_lore_results: number
  created_at: Date
  updated_at: Date
}

/** Projected fields when listing instances with template titles. */
export type WorldTemplateSummaryDoc = Pick<
  WorldTemplateDoc,
  '_id' | 'title' | 'is_sentient' | 'description' | 'kind' | 'image_url'
>
