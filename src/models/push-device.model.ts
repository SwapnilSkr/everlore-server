import type { ObjectId } from 'mongodb'

export interface PushDeviceDoc {
  player_id: ObjectId
  token: string
  platform: 'android'
  tz_offset_minutes?: number
  updated_at: Date
}
