const NSFW_SIGNALS = new Set([
  'kiss', 'kissing',
  'touch', 'touches', 'caress', 'stroke',
  'undress', 'naked', 'bare', 'skin',
  'moan', 'gasp', 'whisper', 'breathe',
  'bed', 'sheets', 'embrace',
  'desire', 'hunger', 'crave',
  'lips', 'neck', 'thigh', 'chest',
  'intimate', 'passion', 'heat', 'closer',
  'body', 'pleasure', 'shiver', 'tremble',
])

const NSFW_PATTERNS = [
  /take\s+(off|your)/i,
  /come\s+closer/i,
  /i\s+want\s+(you|this)/i,
  /show\s+me/i,
  /don['']t\s+stop/i,
  /hold\s+me/i,
  /want\s+you/i,
]

export function classifyScene(
  userMessage: string,
  recentEvents: any[],
): 'sfw' | 'nsfw' {
  const text = userMessage.toLowerCase()

  // Check keywords
  const words = text.split(/\s+/)
  let signalCount = 0
  for (const word of words) {
    if (NSFW_SIGNALS.has(word)) signalCount++
  }

  // Check patterns
  for (const pattern of NSFW_PATTERNS) {
    if (pattern.test(text)) signalCount += 2
  }

  // Check if recent events were intimate (momentum)
  const recentIntimate = recentEvents
    .slice(-3)
    .filter((e) => e.scene_tag === 'intimate' || e.type === 'intimate').length

  signalCount += recentIntimate * 2

  return signalCount >= 3 ? 'nsfw' : 'sfw'
}
