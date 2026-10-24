import { listStoryTurns, storyTurnDetail, storyCallBody, storySummary, type StoryTurnQuery } from '../services/story-engine.service'

export const adminStoryEngineController = {
  turns: (query: StoryTurnQuery) => listStoryTurns(query),
  turn: (id: string) => storyTurnDetail(id),
  body: (id: string) => storyCallBody(id),
  summary: (days: number) => storySummary(days),
}
