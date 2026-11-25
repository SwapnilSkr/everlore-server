import type { PlayerWorldAction } from '../../src/utils/world-action'
import { parsePlayerInput, type ParsedPlayerInput } from '../../src/utils/player-input-parser'
import {
  extractExplicitPhysicalDestination,
  isExplicitPlayerSceneTransition,
} from './movement-signal'
import { extractStatedPosition } from './location-citation'
/** The one normalisation a tapped chip is recognised by, shared with
 *  `matchesOfferedChip` so the two can never disagree about what a chip is. */
import { normalizeReplyText as normalizeChipText } from './reply-language-check'
import {
  classifyPlayerTravel,
  travelPromptDirective,
  type PendingDestination,
  type TravelIntentResult,
  type TravelKind,
} from './travel-intent'

/**
 * Everything the engine derives from the player's own text for ONE turn, in one
 * place (`everlore-docs/phases/reply-language.md` §4).
 *
 * The processor reads these values twice: before the packet, from the text the
 * player actually typed (so the narrator is told what they meant), and, after
 * the stream, from the hidden English copy (so the extractors read English).
 * Both calls must produce the SAME shape or the two halves disagree about where
 * the player went. The English path calls it once with `playerText ===
 * narratorText` and gets exactly the values it used to compute inline.
 *
 * Pure: no I/O, no model. `travel` is the processor's map reading, passed in so
 * this module never queries the place graph.
 */

export interface ReadPlayerTurnInput {
  /**
   * The text every deterministic reading runs on: the English copy when one is
   * known (a tapped chip's stored English, or the witness after the stream),
   * otherwise the player's native text.
   */
  playerText: string
  /**
   * The player's words as the NARRATOR is shown them. On a non-English turn
   * this stays native even when `playerText` is English: the narrator must see
   * the player's own words. Defaults to `playerText`.
   */
  narratorText?: string
  isContinuation: boolean
  /** A structured world action drove this turn; its narration outranks the text. */
  worldAction?: PlayerWorldAction
  /** `worldActionNarration(worldAction)` — the synthetic player line. */
  actionNarration?: string
  /** `worldActionDirective(worldAction)` — the precomputed prompt directive. */
  worldActionDirective?: string
  /** The save's pending destination at dispatch (`session.pending_destination`). */
  priorPending?: PendingDestination | null
  /** The location cursor, for the directive's "they are still at X". */
  cursorName?: string | null
  /**
   * The cursor the MAP reading names in its own directive. The processor's
   * pre-packet directive reads the cached session cursor and its post-packet
   * map directive reads the packet's; they are normally the same and are kept
   * separate so an English turn's prompt bytes cannot move.
   */
  travelCursorName?: string | null
  /** The map's travel reading. Absent before the packet; present to apply it. */
  travel?: TravelIntentResult
}

export interface PlayerTurn {
  /** The parse the deterministic readings ran on. */
  parsed: ParsedPlayerInput
  /**
   * The parse of the words the narrator is shown. The SAME object as `parsed`
   * whenever the two texts agree, so an English turn cannot drift.
   */
  narratorParsed: ParsedPlayerInput
  explicitPhysicalDestination: string | null
  playerTravel: { kind: TravelKind; label: string | null }
  travelDirective: string | null
  statedPosition: string | null
  playerSceneTransition: boolean
  playerForcesFreshCast: boolean
  /** The prompt user message, with the player's own (native) words when shown. */
  promptUserMessage: string
  /** The map reading, present only when `input.travel` was given. */
  travel: TravelIntentResult | null
  /** The map travel prompt directive, present only when it yields one. */
  mapTravelDirective: string | null
}

/**
 * The autonomous-continue directive. Moved here verbatim from the processor so
 * the two halves share one string; the prompt bytes are unchanged.
 */
export const CONTINUE_USER_MESSAGE =
  '[The player waits and observes. Continue the current beat naturally without asking what they do. You MUST move the scene through a concrete response: a present NPC speaks (preferred in a conversation), takes a meaningful action, makes a decision, reveals information, or produces a consequence. Do NOT answer a Continue with only silence, tension, glances, hesitation, body language, or atmospheric description; never repeat a stalled silence from the preceding beat. A detached or disinterested character still responds through a terse dismissal, evasion, refusal, cold action, or consequential withdrawal. Do not introduce a new complication, location, character, danger, romance escalation, or major plot turn unless it was already clearly set up by recent events. Because this is an autonomous continuation, do not open with the active character\'s name; begin with pronoun, action, body language, speech, or setting instead.]'

/** A fresh empty parse for a continue, so callers never share a mutable array. */
export function emptyPlayerParse(): ParsedPlayerInput {
  return {
    raw: '',
    spoken: '',
    narrationFacts: [],
    corrections: [],
    claims: [],
    actionFacts: [],
    fragments: [],
  }
}

/**
 * §2: the typed text is the newest event's offered chip AND that chip carries
 * its stored English — return the English `send`, which is the player's English
 * for this turn. `witness.choices` is aligned by index with `data.choices`, so
 * the chip's index is the index to read. Anything else is `undefined`: a typed
 * line, an edited chip, a chip with no stored English.
 */
export function offeredChipEnglish(text: string, newestEvent: unknown): string | undefined {
  const typed = normalizeChipText(text)
  if (!typed) return undefined
  const data = (newestEvent as { data?: Record<string, unknown> } | null)?.data
  if (!data || !Array.isArray(data.choices)) return undefined
  const choices = data.choices as Array<{ send?: unknown; label?: unknown } | null>
  const witness = data.witness as { choices?: Array<{ send?: unknown }> } | undefined
  const english = Array.isArray(witness?.choices) ? witness!.choices! : null
  if (!english) return undefined
  for (let i = 0; i < choices.length; i++) {
    const chip = choices[i] || {}
    if (
      (chip.send !== undefined && normalizeChipText(String(chip.send)) === typed) ||
      (chip.label !== undefined && normalizeChipText(String(chip.label)) === typed)
    ) {
      const stored = english[i]?.send
      return typeof stored === 'string' && stored.trim() ? stored : undefined
    }
  }
  return undefined
}

export function readPlayerTurn(input: ReadPlayerTurnInput): PlayerTurn {
  const playerText = String(input.playerText ?? '')
  const narratorText = input.narratorText === undefined ? playerText : String(input.narratorText)
  const actionNarration = String(input.actionNarration ?? '')
  const worldAction = input.worldAction
  const priorPending = input.priorPending ?? null
  const cursorName = input.cursorName ?? null

  // A continue has no player text at all; a world action's synthetic narration
  // outranks whatever the client happened to send alongside it.
  const readingSource = input.isContinuation ? '' : actionNarration || playerText
  const narratorSource = input.isContinuation ? '' : actionNarration || narratorText
  const parsed = input.isContinuation ? emptyPlayerParse() : parsePlayerInput(readingSource)
  const narratorParsed = narratorSource === readingSource
    ? parsed
    : input.isContinuation ? emptyPlayerParse() : parsePlayerInput(narratorSource)

  // A normal choice chip remains editable prose, but an action that explicitly
  // names a physical destination is still a player commitment. Carry it into the
  // narrator prompt and the location seam so "Head for the cafe" cannot become
  // an unrequested warehouse detour.
  const explicitPhysicalDestination = worldAction
    ? null
    : extractExplicitPhysicalDestination(parsed.raw)
  const playerTravel = worldAction || input.isContinuation
    ? { kind: 'none' as const, label: null }
    : classifyPlayerTravel(parsed.raw)
  const travelDirective = worldAction
    ? null
    : travelPromptDirective({
        kind: playerTravel.kind,
        label: playerTravel.label,
        resolvedName:
          playerTravel.kind === 'arrival' && priorPending?.name ? priorPending.name : playerTravel.label,
        cursorName,
        playerInput: narratorParsed.raw,
      })
  const statedPosition = worldAction || input.isContinuation
    ? null
    : extractStatedPosition(parsed.raw)
  // Intent ("let's head to the tavern") is not a scene break — the player is
  // still here. Arrival and owned-room leave are. extractExplicitPhysicalDestination
  // used to treat "let's head to X" as a transition and emptied the room.
  let playerSceneTransition =
    !worldAction &&
    !input.isContinuation &&
    playerTravel.kind !== 'intent' &&
    (playerTravel.kind === 'owned_leave' ||
      playerTravel.kind === 'arrival' ||
      isExplicitPlayerSceneTransition(parsed.raw))
  let playerForcesFreshCast = playerSceneTransition || worldAction?.kind === 'travel'

  let promptUserMessage = worldAction && input.worldActionDirective !== undefined
    ? input.worldActionDirective
    : travelDirective
      ? travelDirective
      : statedPosition && !explicitPhysicalDestination
        ? `[PLAYER POSITION: The player has placed themselves "${statedPosition}". That is where this scene happens. Narrate from there. Do not return them to the previous place, and do not contradict their own statement of where they are.]`
        : explicitPhysicalDestination
          ? `[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to ${explicitPhysicalDestination}. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]
PLAYER ACTION: ${narratorParsed.raw}`
          : playerSceneTransition
            ? `[PLAYER SCENE TRANSITION: The player has physically left the prior scene. Keep the narration anchored to the player's viewpoint and the place they reach. Do NOT cut away to, or keep scene focus on, people they left behind unless the player explicitly brought them along.]
PLAYER ACTION: ${narratorParsed.raw}`
            : input.isContinuation
              ? CONTINUE_USER_MESSAGE
              : narratorParsed.spoken || '[No spoken dialogue from player this turn.]'

  // After the packet: the map's own travel reading, and its authority over the
  // scene break and fresh-cast rule. A tapped chip's English arrives this way,
  // so a tapped "go to the market" moves the player as the English reading does.
  const travel = input.travel ?? null
  let mapTravelDirective: string | null = null
  if (travel) {
    mapTravelDirective = travelPromptDirective({
      kind: travel.kind,
      label: travel.label,
      resolvedName: travel.destination?.name || travel.label,
      cursorName: input.travelCursorName === undefined ? cursorName : input.travelCursorName,
      playerInput: narratorParsed.raw,
    })
    if (travel.kind === 'arrival' || travel.kind === 'owned_leave') {
      playerSceneTransition = true
      playerForcesFreshCast = true
      if (mapTravelDirective) promptUserMessage = mapTravelDirective
    } else if (travel.kind === 'intent' && mapTravelDirective) {
      playerSceneTransition = false
      playerForcesFreshCast = worldAction?.kind === 'travel'
      promptUserMessage = mapTravelDirective
    }
  }

  return {
    parsed,
    narratorParsed,
    explicitPhysicalDestination,
    playerTravel,
    travelDirective,
    statedPosition,
    playerSceneTransition,
    playerForcesFreshCast,
    promptUserMessage,
    travel,
    mapTravelDirective,
  }
}
