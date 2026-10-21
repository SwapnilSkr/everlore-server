import type { Document } from 'mongodb'

// These are the four stored turn kinds emitted by generation.processor.
export const STORY_TURN_TYPES = ['narration', 'intimate', 'travel', 'calendar_tick']

/** Equality on player_id and type uses idx_events_player_type_created. */
export function userActivityStages(): Document[] {
  return [
    { $lookup: {
      from: 'events', localField: '_id', foreignField: 'player_id', as: '_story_activity',
      pipeline: [
        { $match: { type: { $in: STORY_TURN_TYPES } } },
        { $group: { _id: null, story_turns: { $sum: 1 }, latest: { $max: '$created_at' } } },
      ],
    } },
    { $set: {
      story_turns: { $ifNull: [{ $first: '$_story_activity.story_turns' }, 0] },
      last_active_source: { $cond: [
        { $ne: [{ $ifNull: ['$last_active_at', null] }, null] }, 'request',
        { $cond: [{ $gt: [{ $size: '$_story_activity' }, 0] }, 'story', null] },
      ] },
      last_active_at: { $ifNull: ['$last_active_at', { $ifNull: [{ $first: '$_story_activity.latest' }, null] }] },
    } },
    { $project: { _story_activity: 0, password_hash: 0 } },
  ]
}
