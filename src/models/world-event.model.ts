import type { ObjectId } from 'mongodb'
import type { ProseHygieneIssue } from '../utils/prose-hygiene'
import type { CharacterCodexDelta } from '../services/character-codex.service'
import type { ChoiceOption } from '../../worker/lib/structured-output'
import type { TimeAnchorDoc } from './time.model'
import type { LocationAnchorDoc } from './location.model'

export type StateMutationOp = 'add' | 'subtract' | 'set'

export interface StateMutationDoc {
  op: StateMutationOp
  value: number
}

export type FlagMutationOp = 'set' | 'increment' | 'decrement'

export interface FlagMutationDoc {
  op: FlagMutationOp
  value?: unknown
}

export interface ReplayVariantDoc {
  id: string
  narrative: string
  model_used: string
  created_at: Date
  /** System-generated replay, manual edit, imported baseline, etc. */
  source?: 'base' | 'replay' | 'edit' | string
  retrieval_profile?: {
    lore_top_k: number
    memory_top_k: number
    recent_event_window: number
  }
  prose_hygiene_issues?: ProseHygieneIssue[]
  /** Tap-to-play chips + scene presence derived from THIS variant's prose, so
   *  selecting a variant restores its own chips without re-running the extractor. */
  choices?: ChoiceOption[]
  present_characters?: string[]
  /** Backend-OWNED trackable mentions derived from THIS variant's prose, so
   *  browsing/committing a variant carries its own underline data without
   *  re-running the canon-gap classifier. Same shape as EventDataDoc. */
  trackable_mentions?: Array<{ key: string; display: string; tier: import('../../worker/lib/presence-gap-detector').MentionTier; evidence: string }>
}

/** One ledgered location change this turn — the rebuildable projection of the
 *  place graph, mirroring codex_deltas/relation_assertions. Each carries its
 *  authority source + confidence so a rebuild reconstructs the place exactly and a
 *  player-narrated place-fact can outrank a narrator one. See world-authority.ts. */
export interface LocationDeltaDoc {
  type: 'location_anchor' | 'location_fact' | 'location_state' | 'containment'
  /** The place name (anchor/containment) or the fact/state clause text. */
  name: string
  source: import('../utils/world-authority').WorldFactSource
  confidence: number
  sequence: number
}

/** This turn's time advance as an authority-tagged delta, the time twin of
 *  LocationDeltaDoc: records WHO drove the skip (player narration / narrator prose /
 *  continuation tick) + confidence, so the timeline is a rebuildable projection and a
 *  player-narrated skip can outrank a narrator one. The bare `time_advanced` string is
 *  kept for the existing calendar consumers. See world-authority.ts. */
export interface TimeDeltaDoc {
  /** The advance label fed to `advanceDays` ("three days", "the next morning"). */
  label: string
  source: import('../utils/world-authority').WorldFactSource
  confidence: number
  sequence: number
}

export interface EventDataDoc {
  player_input: string
  /** Spoken dialogue outside narration markers. */
  player_spoken_input?: string
  /** Canonical narration/action facts authored inside *...* or **...**. */
  player_narration_facts?: string[]
  /** Structured, player-confirmed command that drove this turn, when any. */
  world_action?: import('../utils/world-action').PlayerWorldAction
  ai_response: string
  /** Suggested next moves (tap-to-play chips) derived in the metadata pass.
   *  `send` is the formatted player input dispatched on tap (act = *narration*,
   *  say = spoken aloud); `label` is the chip caption shown to the player. */
  choices?: Array<{ label: string; kind: 'act' | 'say'; send: string }>
  /** Story landmark crossed this turn (brass-seal moment), when one occurred. */
  milestone?: string | null
  /** In-story time that passed this turn (e.g. "several days") — set on an
   *  explicit calendar_tick AND on any turn whose prose narrates a time skip
   *  (travel, "weeks later"). Advances the day-level calendar. */
  time_advanced?: string
  /** Present on `type: 'travel'` turns — where the protagonist moved between
   *  two concrete places this turn (denormalized names for cheap rendering). */
  travel?: { from: string; to: string }
  /** Open-thread text that seeded this turn's beat, when fate came knocking. */
  fate_thread?: string
  /** Characters present in the scene at the end of this turn (scene-aware bond
   *  actions: approach vs. seek out). Empty/absent when the viewpoint is alone. */
  present_characters?: string[]
  /** Backend-OWNED trackable mentions: people the prose surfaced this turn that
   *  weren't already present/carded, each with a confidence tier. The frontend
   *  renders these instead of running its own canon-gap detection. Confirmed +
   *  probable are auto-added to present_characters and stubbed; mentioned_only are
   *  surfaced for the player to optionally track. */
  trackable_mentions?: Array<{ key: string; display: string; tier: import('../../worker/lib/presence-gap-detector').MentionTier; evidence: string }>
  /** Character-codex deltas applied THIS turn (post-guard). Ledgered like
   *  state_mutations so the codex is an exact rebuildable projection: on rewind
   *  the surviving deltas are replayed deterministically, so no fact or meter
   *  from a removed turn can ever linger. Absent on pre-ledger (legacy) turns. */
  codex_deltas?: CharacterCodexDelta[]
  /** This turn's location changes, ledgered with authority for an exact rebuild of
   *  the place graph (anchor + containment + state + enduring facts). */
  location_deltas?: LocationDeltaDoc[]
  /** This turn's time advance, authority-tagged for a rebuildable timeline (parallel
   *  to location_deltas). Present only when time actually advanced. */
  time_delta?: TimeDeltaDoc
  replay_variants?: ReplayVariantDoc[]
  selected_replay_index?: number
  state_mutations: Record<string, StateMutationDoc>
  flag_mutations: Record<string, FlagMutationDoc>
  model_used: string
  tokens_in: number
  tokens_out: number
  prose_hygiene_issues?: ProseHygieneIssue[]
}

export interface EventEditHistoryEntry {
  previous_data: EventDataDoc
  edited_at: Date
}

/**
 * Present only on `type: 'side_chat'` events — the side character the player is
 * privately talking to. Side chats share the main sequence counter (so rewind,
 * time anchors, and the continuity audit stay exact) but are excluded from the
 * main-narration window, scene summaries, and the Play feed.
 */
export interface SideChatRefDoc {
  character_id: ObjectId
  character_entity_id: ObjectId | null
  character_name: string
  /** How the character was reachable for this chat (present/nearby/remote/seek) —
   *  drives prompt framing + lets the UI explain the conversation's footing.
   *  See worker/lib/side-chat-reachability.ts. */
  mode?: import('../../worker/lib/side-chat-reachability').SideChatMode
  /** Who could KNOW what was said. A 1:1 side chat is 'private' by default (the
   *  main narrator didn't witness it); reserved for future public/local group
   *  side chats. See world-authority.VisibilityScope. */
  visibility_scope?: import('../utils/world-authority').VisibilityScope
  /** Entity ids of the conversation participants (player + character). */
  participants?: ObjectId[]
  /** Whether this chat may influence the MAIN story (false for an ordinary private
   *  beat; a hook for future consequence propagation). */
  mainline_effect?: boolean
}

/**
 * events — chronological narration turns (events collection).
 */
export interface WorldEventDoc {
  _id: ObjectId
  instance_id: ObjectId
  player_id: ObjectId
  sequence: number
  type: 'intimate' | 'narration' | 'calendar_tick' | 'travel' | 'side_chat' | string
  side_chat?: SideChatRefDoc
  data: EventDataDoc
  is_user_edited: boolean
  edit_history: EventEditHistoryEntry[]
  scene_tag: string
  /** Set only for a verified current-turn sexual-intent signal. Read by
   *  scoreScene momentum to route the NEXT turn explicit. */
  nsfw_intent?: boolean
  /** Provenance for nsfw_intent. Rows written before this field are deliberately
   *  not trusted as routing momentum, because legacy routing could mark profanity
   *  as sexual intent. */
  nsfw_intent_source?: 'direct_explicit' | 'intent_judge'
  /** Story-time anchor: sequence time, real time, calendar date, and timeline branch. */
  time_anchor?: TimeAnchorDoc
  /** End-of-turn place anchor, when known. */
  location_anchor?: LocationAnchorDoc | null
  created_at: Date
  updated_at?: Date
}
