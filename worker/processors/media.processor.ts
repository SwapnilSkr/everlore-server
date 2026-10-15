import type { Job } from 'bullmq'
import { processVoice } from '../../src/services/media/service'

export async function mediaProcessor(job: Job<{ mediaId: string; instanceId: string }>) {
  if (job.name === 'voice') await processVoice(job.data.mediaId)
}
