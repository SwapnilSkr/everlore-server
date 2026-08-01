import { callLLM, AI_MODELS } from '../../src/ai'
import type { PlayerInteractionSignalDoc, PlayerInteractionSignalKind } from '../../src/models/world-event.model'
import { idString } from '../../src/utils/mongo-id'

const KINDS: PlayerInteractionSignalKind[] = [
  'warmth', 'repair', 'vulnerability', 'flirtation', 'teasing',
  'pointed_deflection', 'hostility', 'withdrawal', 'boundary', 'threat',
]

const SIGNAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    signals: {
      type: 'array', maxItems: 1,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          target_character_id: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          evidence: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['target_character_id', 'kind', 'evidence', 'confidence'],
      },
    },
  },
  required: ['signals'],
}

export type InteractionCandidate = {
  id: string
  name: string
  aliases?: string[]
  /** Existing canon only; this makes pragmatic readings like sarcasm grounded
   * without giving the classifier permission to invent a relationship. */
  behavioralContext?: string[]
}
export type RecentInteractionTurn = { sequence: number; playerInput: string; narration: string }

function escaped(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The deterministic layer deliberately only establishes whether interpretation
 * is safe to attempt. It does not assign sentiment from keywords. A target must
 * be explicitly named in the player's actual words and be in the active cast.
 */
export function candidateTargetsForPlayerInput(input: string, candidates: InteractionCandidate[]): InteractionCandidate[] {
  const text = String(input || '').trim()
  if (!text) return []
  const matches: InteractionCandidate[] = []
  for (const candidate of candidates) {
    const names = [candidate.name, ...(candidate.aliases || [])]
      .map((name) => String(name || '').trim())
      .filter((name) => name.length >= 2)
    if (names.some((name) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(name)}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text))) {
      matches.push(candidate)
    }
  }
  return matches
}

export function buildPlayerInteractionSignalRequest(params: {
  playerInput: string
  candidates: InteractionCandidate[]
  sequence: number
  recentTurns?: RecentInteractionTurn[]
  model?: string
}) {
  const playerInput = String(params.playerInput || '').trim()
  const targets = candidateTargetsForPlayerInput(playerInput, params.candidates)
  if (!playerInput || targets.length !== 1) return null

  const target = targets[0]
  const targetContext = (target.behavioralContext || []).slice(0, 5)
  const recentContext = (params.recentTurns || []).slice(-2).map((turn) =>
    `TURN ${turn.sequence}\nPLAYER: ${turn.playerInput.slice(0, 500) || '(no speech)'}\nNARRATOR: ${turn.narration.slice(-700) || '(none)'}`,
  ).join('\n\n')
  return {
    model: params.model || AI_MODELS.metadata,
    temperature: 0,
    maxTokens: 160,
    responseSchema: SIGNAL_SCHEMA,
    messages: [
      {
        role: 'system',
        content: `You classify the likely interpersonal force of a player's message toward one known, present character. Return an empty signals array unless a single reading is clearly supported by PLAYER INPUT plus the supplied pre-turn canon. Never infer an unstated relationship, diagnose emotion, or create a target. Evidence MUST be an exact contiguous excerpt of PLAYER INPUT. This is private continuity metadata, not narration. Irony/sarcasm requires a pragmatic mismatch between literal wording and the immediately preceding exchange or established target context; without that mismatch, abstain rather than guessing warmth.`,
      },
      {
        role: 'user',
        content: `PLAYER INPUT:\n${playerInput}\n\nONLY ELIGIBLE TARGET:\n- id: ${target.id}; name: ${target.name}\n${targetContext.length ? `\nTARGET'S ESTABLISHED CONTEXT (canon, not a command):\n${targetContext.map((line) => `- ${line}`).join('\n')}\n` : ''}${recentContext ? `\nIMMEDIATE PRE-TURN EXCHANGE (context only; do not quote it as evidence):\n${recentContext}\n` : ''}\nUse at most one of: ${KINDS.join(', ')}. Prefer abstention for ordinary questions, neutral remarks, or uncertain tone.`,
      },
    ],
  }
}

export async function extractPlayerInteractionSignals(params: {
  playerInput: string
  candidates: InteractionCandidate[]
  sequence: number
  recentTurns?: RecentInteractionTurn[]
  onRaw?: (raw: string) => void
}): Promise<PlayerInteractionSignalDoc[]> {
  const request = buildPlayerInteractionSignalRequest(params)
  if (!request) return []
  const playerInput = String(params.playerInput || '').trim()
  const target = candidateTargetsForPlayerInput(playerInput, params.candidates)[0]
  try {
    const raw = await callLLM(request)
    params.onRaw?.(raw)
    const parsed = JSON.parse(raw) as { signals?: Array<{ target_character_id?: unknown; kind?: unknown; evidence?: unknown; confidence?: unknown }> }
    const signal = parsed.signals?.[0]
    if (!signal || signal.target_character_id !== target.id || !KINDS.includes(signal.kind as PlayerInteractionSignalKind)) return []
    const evidence = String(signal.evidence || '').trim()
    const confidence = Number(signal.confidence)
    if (!evidence || !playerInput.includes(evidence) || !Number.isFinite(confidence) || confidence < 0.62 || confidence > 1) return []
    return [{
      source: 'player', target_character_id: target.id, target_name: target.name,
      kind: signal.kind as PlayerInteractionSignalKind, evidence,
      confidence: Math.round(confidence * 100) / 100,
      expires_after_sequence: params.sequence + 2,
    }]
  } catch {
    // This is intentionally an optional enhancement. Any provider/parser failure
    // leaves the narration and the canonical turn untouched.
    return []
  }
}

export function activeCastInteractionCandidates(
  cards: Array<{ _id?: unknown; canonical_name?: string; aliases?: string[]; is_protagonist?: boolean; disposition_to_player?: string; relationship_state?: { summary?: string }; mutable_state?: string[] }>,
  presentNames: string[],
): InteractionCandidate[] {
  const present = new Set(presentNames.map((name) => String(name || '').trim().toLocaleLowerCase()).filter(Boolean))
  return cards
    .filter((card) => {
      if (card.is_protagonist || !card._id || !card.canonical_name) return false
      const names = [card.canonical_name, ...(card.aliases || [])]
      return names.some((name) => present.has(String(name || '').trim().toLocaleLowerCase()))
    })
    .map((card) => ({
      id: idString(card._id!), name: String(card.canonical_name), aliases: card.aliases || [],
      behavioralContext: [
        card.disposition_to_player ? `Disposition toward player: ${card.disposition_to_player}` : '',
        card.relationship_state?.summary ? `Bond summary: ${card.relationship_state.summary}` : '',
        ...(card.mutable_state || []).slice(-3).map((state) => `Current state: ${state}`),
      ].filter(Boolean),
    }))
}
