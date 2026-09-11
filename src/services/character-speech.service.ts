/**
 * TALKING TO SOMEONE WHO IS ACTUALLY THERE.
 *
 * The map could be walked, opened, ended and ruled without a single person in
 * it ever saying anything. Twenty characters were authored — what each of them
 * wants, fears, knows and will not say — and none of it had a seam to reach the
 * player through. This is that seam.
 *
 * WHAT THE MODEL IS AND IS NOT TRUSTED WITH. It writes the character's words
 * and nothing else. It never sees a flag name, an id, a location key or a
 * portrait id, and it never returns one. What it returns beyond the line is two
 * judgements a reader could make from the fiction alone — whether the character
 * was won over enough to give up what they are holding, and how the exchange
 * left them — and code turns those into the authored flag and the published
 * portrait. A flag minted from a model's own string could open a road no author
 * built, silently, and the map would simply have a new door in it.
 *
 * WHAT IT IS NOT TOLD. `knows_guarded` is filtered upstream by `knowledgeFor`
 * against the live flags, so a fact the player has not earned is not in the
 * prompt at all. There is no instruction telling the model to keep a secret,
 * because an instruction is a request and the failure is invisible: the Duke
 * confessing his complicity on turn one reads as a perfectly good scene.
 *
 * DEGRADED MODE. Every failure returns null and the caller narrates the
 * authored `unanswered` line instead. The player gets a beat of fiction, the
 * world is unchanged, and nothing about a provider ever reaches the screen.
 */
import { AI_MODELS, callLLM } from '../ai'
import type { InteractiveLocationDoc } from '../models/interactive-world.model'
import type { WorldCastMember } from '../worlds/world-source'
import { portraitAssetId } from '../worlds/cast'
import { log } from '../utils/logger'

/**
 * How far a character can be moved, and how fast.
 *
 * Both are mechanism rather than content: without a ceiling a long enough
 * conversation drives disposition to any number at all, and the authored
 * starting values (-2 to 2) stop meaning anything relative to each other.
 */
const DISPOSITION_LIMIT = 3
const STEP_LIMIT = 1
/** How much of the exchange is carried forward. Enough to be remembered, bounded so the prompt cannot grow without end. */
export const RECALLED_EXCHANGES = 6

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    line: { type: 'string' },
    bearing: { type: 'string' },
    turned: { type: 'boolean' },
    disposition_delta: { type: 'number' },
  },
  required: ['line', 'bearing', 'turned', 'disposition_delta'],
}

/**
 * Take the payload out of a response that echoed the SCHEMA back instead of
 * filling it in. One extractor on this server did that on 27.65% of its calls
 * and returned nothing at all, silently, for months.
 */
function unwrapSchemaEcho(parsed: any): Record<string, unknown> {
  if (parsed && typeof parsed === 'object' && parsed.line === undefined && parsed.properties && typeof parsed.properties === 'object') {
    return parsed.properties
  }
  return parsed || {}
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

export interface SpokenExchange {
  said: string
  replied: string
}

/** Everything the character is answering from. Assembled by the caller, never here. */
export interface SpeechContext {
  member: WorldCastMember
  /** Already filtered against the player's flags. A guarded fact must never arrive here ungated. */
  knowledge: string[]
  /**
   * Deeds this person actually saw in this room. Separate from [knowledge]
   * so a static brief cannot deny a fight they just watched.
   */
  witnessed?: string[]
  where: InteractiveLocationDoc
  disposition: number
  met: boolean
  history: SpokenExchange[]
  /** What the player actually typed. Untrusted text. */
  said: string
}

/**
 * The brief the character answers from, kept pure so the audit can read the
 * REAL prompt.
 *
 * Asserting on a mapping proves the mapping; asserting on this proves what was
 * actually sent, which is the only version of the guarded-knowledge invariant
 * worth having.
 *
 * The player's own words go in their own message, introduced as the player
 * speaking, so that text arriving as instructions is answered as speech rather
 * than obeyed — a player who types a demand to break character is a player who
 * said something rude to a character who can refuse it.
 */
export function briefFor(ctx: SpeechContext): { role: 'system' | 'user'; content: string }[] {
  const { member } = ctx
  const bearings = Object.keys(member.portraits)
  return [
    {
      role: 'system',
      content: [
        'You are one person in a grim low-fantasy realm of feuding houses, written rolls and trial by combat, answering someone who has just spoken to you.',
        `You are ${member.name}, ${member.role}.`,
        `You are at ${ctx.where.title}: ${ctx.where.description}`,
        `What you want: ${member.wants}`,
        `What you fear: ${member.fears}`,
        `What you know: ${ctx.knowledge.map((fact) => `- ${fact}`).join('\n')}`,
        ctx.witnessed && ctx.witnessed.length > 0
          ? `What you have seen happen in this place. You were here. Do not deny these, and do not claim ignorance of them:\n${ctx.witnessed.map((fact) => `- ${fact}`).join('\n')}`
          : '',
        ctx.met
          ? 'You have spoken with this person before.'
          : `This is the first time you have met them. How it began: ${member.first_met}`,
        `How you feel about them, from cold hostility at ${-DISPOSITION_LIMIT} to trust at ${DISPOSITION_LIMIT}: ${ctx.disposition}`,
        '',
        'Reply in your own voice, in two or three sentences at most, in the third person past tense, as a novel would render you speaking. Stay inside what you know and what you have witnessed: if something is in neither list, you do not know it, and you may say so.',
        'You are not a helpful narrator. You have your own interest in this and you may lie, deflect, bargain or refuse.',
        // The model was writing "his disposition towards the questioner
        // shifted" and "no judgement was proffered" straight into the line —
        // reporting the machinery back to the player in the middle of the
        // scene. It reaches for that language because these instructions use
        // it, so the ban has to name it: the line carries the moment, and the
        // measurements go in their own fields where nobody reads them.
        '"line" is only what someone standing there would see and hear: what you did, and what you said. Never state how your feeling towards them has changed, never summarise the exchange or its outcome, and never reuse the wording of these instructions.',
        '',
        'Set "turned" true ONLY if, in this reply, you have decided to give this person the thing you are holding back — the name, the way through, the help they came for. It must be earned by what they said, and against your own fear. Otherwise it is false.',
        `Set "bearing" to whichever of these best describes your face as you answer: ${bearings.join(', ')}.`,
        'Set "disposition_delta" between -1 and 1: how this exchange has moved your feeling towards them.',
        '',
        'Never mention rules, systems, scores, progress, or the fact that anything is being decided. Never break out of the world to address the person reading.',
      ].filter(Boolean).join('\n'),
    },
    ...ctx.history.flatMap((exchange) =>
      exchange.said.trim()
        ? [
            { role: 'user' as const, content: `They said: ${exchange.said}` },
            { role: 'user' as const, content: `You answered: ${exchange.replied}` },
          ]
        : [{ role: 'user' as const, content: `You spoke first, unbidden: ${exchange.replied}` }],
    ),
    { role: 'user', content: `They said: ${ctx.said}` },
  ]
}

/**
 * The verification half, pure so the audit can exercise it without a model call.
 *
 * A reply with no words in it is worse than no reply: the scene renders, the
 * portrait changes, and the character stands there having said nothing. Refuse
 * it and let the caller narrate the authored line instead.
 */
export function verifySpokenReply(raw: unknown): {
  line: string
  bearing: string
  turned: boolean
  disposition_delta: number
} | null {
  const body = unwrapSchemaEcho(raw)
  const line = text(body.line)
  if (!line) return null
  const delta = typeof body.disposition_delta === 'number' && Number.isFinite(body.disposition_delta)
    ? body.disposition_delta
    : 0
  return {
    line,
    bearing: text(body.bearing),
    turned: body.turned === true,
    // Clamped on the way in as well as on the way out, so a model that returns
    // 40 moves a character exactly as far as one that returns 1.
    disposition_delta: Math.max(-STEP_LIMIT, Math.min(STEP_LIMIT, delta)),
  }
}

/** What the world does about what was said. Every structural field is minted here. */
export interface SpokenReply {
  character_id: string
  line: string
  /** Resolved from the character's OWN authored portraits, never from the model's string. */
  portrait_asset_id: string
  disposition: number
  /** The authored flag this character can grant, if they granted it. Never a name the model chose. */
  sets_flag: string | null
}

/**
 * Everything about the reply that is NOT the character's words.
 *
 * Pure and separate for the same reason the petition composer is: the portrait,
 * the flag and the bounds are the parts that decide whether the world moves,
 * and they are exactly the parts a model must not be trusted with. A bearing
 * that is not one of this character's own portraits falls back to their default
 * face rather than to an asset id nothing published.
 */
export function composeSpokenReply(
  written: NonNullable<ReturnType<typeof verifySpokenReply>>,
  frame: { member: WorldCastMember; disposition: number; canSet: (flag: string) => boolean },
): SpokenReply {
  const bearing = frame.member.portraits[written.bearing] ? written.bearing : undefined
  const reveals = frame.member.reveals_flag
  return {
    character_id: frame.member.id,
    line: written.line,
    portrait_asset_id: portraitAssetId(frame.member, bearing),
    disposition: Math.max(
      -DISPOSITION_LIMIT,
      Math.min(DISPOSITION_LIMIT, Math.round(frame.disposition + written.disposition_delta)),
    ),
    // Two conditions, and the second is the one that matters: the flag must be
    // something this world actually gates on. Narration is held to the same
    // vocabulary, and a character volunteering a flag nothing reads would be a
    // way around it rather than a second door into it.
    sets_flag: written.turned && reveals && frame.canSet(reveals) ? reveals : null,
  }
}

/**
 * What the character says back, or null if they cannot be made to say anything.
 *
 * Null is not an error. It is the caller's cue to narrate the authored line for
 * a character who does not answer, which is a beat of fiction rather than a
 * dead end — the player can say something else, walk away, or come back.
 */
export async function speakAs(
  ctx: SpeechContext,
  canSet: (flag: string) => boolean,
  instanceId?: string,
): Promise<SpokenReply | null> {
  try {
    const raw = await callLLM({
      model: AI_MODELS.metadata,
      purpose: 'character_speech',
      temperature: 0.9,
      maxTokens: 400,
      responseSchema: SCHEMA,
      messages: briefFor(ctx),
    })
    const verified = verifySpokenReply(JSON.parse(raw))
    if (!verified) {
      log.info('character_speech.refused', { instanceId, character: ctx.member.id })
      return null
    }
    return composeSpokenReply(verified, { member: ctx.member, disposition: ctx.disposition, canSet })
  } catch (err) {
    // A player whose provider is down gets a character who says nothing, and
    // never learns that anything was asked of anyone.
    log.info('character_speech.failed', { instanceId, character: ctx.member.id, error: (err as Error).message })
    return null
  }
}
