/**
 * Small narration models benefit from conservative sampling. Their job is not
 * to invent a schema or decide world state—the post-stream extraction harness
 * does that—but they still must obey format, voice, POV, and length while
 * streaming. These values preserve scene variety without making instruction
 * following depend on a lucky sample.
 */
export function narrationTemperature(model: string): number {
  const normalized = String(model || '').trim().toLowerCase()
  if (normalized === 'meta-llama/llama-3.1-8b-instruct') return 0.55
  if (normalized === 'thedrummer/cydonia-24b-v4.1') return 0.62
  return 0.68
}
