import type { ObjectId } from 'mongodb'
import type { ProseHygieneIssue } from '../utils/prose-hygiene'
import type { CharacterCodexDelta } from '../services/character-codex.service'
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
}

export interface EventDataDoc {
  player_input: string
  /** Spoken dialogue outside narration markers. */
  player_spoken_input?: string
  /** Canonical narration/action facts authored inside *...* or **...**. */
  player_narration_facts?: string[]
  ai_response: string
  /** Suggested next moves (tap-to-play chips) derived in the metadata pass.
   *  `send` is the formatted player input dispatched on tap (act = *narration*,
   *  say = spoken aloud); `label` is the chip caption shown to the player. */
  choices?: Array<{ label: string; kind: 'act' | 'say'; send: string }>
  /** Story landmark crossed this turn (brass-seal moment), when one occurred. */
  milestone?: string | null
  /** In-story time that passed on a calendar_tick turn (e.g. "several days"). */
  time_advanced?: string
  /** Open-thread text that seeded this turn's beat, when fate came knocking. */
  fate_thread?: string
  /** Characters present in the scene at the end of this turn (scene-aware bond
   *  actions: approach vs. seek out). Empty/absent when the viewpoint is alone. */
  present_characters?: string[]
  /** Character-codex deltas applied THIS turn (post-guard). Ledgered like
   *  state_mutations so the codex is an exact rebuildable projection: on rewind
   *  the surviving deltas are replayed deterministically, so no fact or meter
   *  from a removed turn can ever linger. Absent on pre-ledger (legacy) turns. */
  codex_deltas?: CharacterCodexDelta[]
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
}

/**
 * events — chronological narration turns (events collection).
 */
export interface WorldEventDoc {
  _id: ObjectId
  instance_id: ObjectId
  player_id: ObjectId
  sequence: number
  type: 'intimate' | 'narration' | 'calendar_tick' | 'side_chat' | string
  side_chat?: SideChatRefDoc
  data: EventDataDoc
  is_user_edited: boolean
  edit_history: EventEditHistoryEntry[]
  scene_tag: string
  /** Story-time anchor: sequence time, real time, calendar date, and timeline branch. */
  time_anchor?: TimeAnchorDoc
  /** End-of-turn place anchor, when known. */
  location_anchor?: LocationAnchorDoc | null
  created_at: Date
  updated_at?: Date
}
