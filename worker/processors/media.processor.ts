import type { Job } from 'bullmq'
import { processVoice } from '../../src/services/media/service'
import { processPicture, processPortrait, processVideo } from '../../src/services/media/visual'

export async function mediaProcessor(job: Job<{ mediaId: string; instanceId: string }>) {
  if (job.name === 'voice') await processVoice(job.data.mediaId)
  else if (job.name === 'picture') await processPicture(job.data.mediaId)
  else if (job.name === 'video') await processVideo(job.data.mediaId)
  else if (job.name === 'portrait') await processPortrait(job.data.mediaId)
}
