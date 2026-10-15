import { HttpError } from './http-error'

export class StoryRestingError extends HttpError {
  readonly resetsAt: string

  constructor(now = new Date()) {
    const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString()
    super(429, 'Your story rests until tomorrow.', { code: 'STORY_RESTING', resets_at: resetsAt })
    this.name = 'StoryRestingError'
    this.resetsAt = resetsAt
  }
}
