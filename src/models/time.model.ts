import type { ObjectId } from 'mongodb'

export interface StoryCalendarMonthDoc {
  name: string
  days: number
}

export interface StoryCalendarDoc {
  _id: ObjectId
  template_id?: ObjectId
  instance_id?: ObjectId
  name: string
  eras: string[]
  months: StoryCalendarMonthDoc[]
  weekdays?: string[]
  moons?: Array<{ name: string; cycle_days: number }>
  season_model?: Record<string, unknown>
  is_default: boolean
  created_at: Date
  updated_at: Date
}

export interface StoryCalendarDateDoc {
  calendar_id: ObjectId
  year?: number
  month?: number
  day?: number
  era?: string
  label?: string
}

export interface TimeAnchorDoc {
  /** Server storage time for the source event/projection. */
  real_time: Date
  /** Player-experienced event order. */
  sequence: number
  /** In-world calendar date, when known. */
  story_calendar?: StoryCalendarDateDoc
  /** Human label such as "three days later" or "the night before the coronation". */
  event_time_label?: string
  /** Reality/branch this event belongs to. Defaults to "main". */
  timeline_id: string
  causal_parent_event_ids: ObjectId[]
  /** Optional per-entity subjective time labels for loops/visions/future knowledge. */
  subjective_entity_times?: Record<string, string>
}

export interface TimelineBranchDoc {
  _id: ObjectId
  instance_id: ObjectId
  name: string
  timeline_id: string
  parent_timeline_id?: string
  forked_at_sequence: number
  forked_at_story_time?: TimeAnchorDoc
  status: 'active' | 'collapsed' | 'alternate' | 'erased'
  created_at: Date
  updated_at: Date
}
