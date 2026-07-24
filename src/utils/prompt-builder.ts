import { countTokens } from './token-counter'
import { buildStyleBlock, buildLengthDirective, buildStyleReminder, type MessageLength } from './narrative-styles'
import { buildModeDirective, modeReminderLabel } from './chat-modes'
import {
  buildNarrationToneDirective,
  buildNarrationToneReminder,
  narrationToneLabel,
} from './narration-tones'
import { parsePlayerInput } from './player-input-parser'
import { CHOICE_TAIL_INSTRUCTION } from '../../worker/lib/choice-tail'
import type { PersonaSnapshotDoc } from '../models/persona.model'

interface PromptInput {
  seedPrompt: string
  isSentient: boolean
  worldState: Record<string, number>
  activeFlags: Record<string, any>
  globalLore: string
  retrievedLore: string[]
  retrievedMemories: string[]
  /** Unresolved promises/conflicts/questions the world still owes a payoff for. */
  openThreads?: string[]
  /** Current story-time/timeline context from the context packet. */
  timeContext?: string | null
  /** Current place context from the context packet. */
  locationContext?: string | null
  sceneSummary: string | null
  /** Distant chapter/scene summaries retrieved as relevant to this turn. */
  relevantSummaries?: string[]
  recentEvents: any[]
  userMessage: string
  userSpokenInput?: string
  userNarrationFacts?: string[]
  isContinuation?: boolean
  maxTokens: number
  /** When true, ask for plain narrative prose instead of the JSON envelope.
   *  Used for the uncensored NSFW model, whose structured metadata is extracted
   *  by a separate pass. */
  proseOnly?: boolean
  /** When true (proseOnly only), the narrator also appends a sentinel-delimited
   *  CHOICES tail after the prose, so the tap-to-play choices are generated WITH the
   *  narrator's full context instead of a context-starved second pass. The worker
   *  strips the tail from the player stream and parses it (see worker/lib/choice-tail). */
  emitChoices?: boolean
  /** Narration person. Defaults to third. */
  narrationPov?: 'first' | 'third'
  /** Chat MODE key (see chat-modes.ts) — how the chat flows. Player-chosen. */
  chatMode?: string
  /** Narrative VOICE preset key (see narrative-styles.ts). Stable per instance. */
  narrativeStyle?: string
  /** Player-selected prose register, independent of narrative style and chat mode. */
  narrationTone?: string
  /** Stable instance identifier used to select one compact tone reference. */
  toneExampleSeed?: string
  /** Free-text creator/player style refinements appended to the voice block. */
  styleNotes?: string
  /** Optional reusable player persona selected for this instance. */
  playerPersona?: PersonaSnapshotDoc | null
  /** Desired reply length: 'short' | 'medium' | 'long'. Defaults to medium. */
  messageLength?: MessageLength
  /** Canonical emergent character cards enforced as story constraints. */
  characterCodex?: Array<{
    canonical_name: string
    aliases?: string[]
    role?: string
    appearance?: string
    persona?: string
    immutable_facts?: string[]
    mutable_state?: string[]
    disposition_to_player?: string
    hidden_thought?: string
    is_protagonist?: boolean
  }>
  /** Optional focused character id/name chosen by player for this instance. */
  focusCharacterName?: string
  /** CANON BRIEF (relationships) — compact kinship facts incl. lifecycle state
   *  ("Aldric is your father (deceased)"). Always-on, high-priority, derived from
   *  the kinship graph so the narrator can't contradict established ties. */
  relationshipFacts?: string[]
  /** CANON BRIEF (positions) — where active characters were last seen when elsewhere
   *  ("Mara was last seen in the Ash Tavern"), so "go find X" stays grounded. */
  positionFacts?: string[]
  /** CANON BRIEF (companions) — who is travelling WITH the player, present by default. */
  companionFacts?: string[]
}

interface PromptMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function openingCharacterName(recentEvents: any[], names: string[]): string | null {
  const last = [...recentEvents].reverse().find((event) => String(event.data?.ai_response || '').trim())
  const text = String(last?.data?.ai_response || '')
    .trim()
    .replace(/^[\s*_]+/, '')
  for (const name of names) {
    if (!name) continue
    const re = new RegExp(`^${escapeRegExp(name)}(?:\\b|'s\\b)`, 'i')
    if (re.test(text)) return name
  }
  return null
}

function eventPlayerParts(event: any): {
  spoken: string
  narrationFacts: string[]
} {
  const data = event.data || {}
  if (typeof data.player_spoken_input === 'string' || Array.isArray(data.player_narration_facts)) {
    return {
      spoken: String(data.player_spoken_input || '').trim(),
      narrationFacts: Array.isArray(data.player_narration_facts)
        ? data.player_narration_facts.map((f: unknown) => String(f || '').trim()).filter(Boolean)
        : [],
    }
  }
  const parsed = parsePlayerInput(String(data.player_input || ''))
  return { spoken: parsed.spoken, narrationFacts: parsed.narrationFacts }
}

/**
 * Turn data that is safe to carry forward as continuity.
 *
 * Do not put an earlier narration response in the generation prompt.  Even
 * with an instruction not to imitate it, a small/remote narrator will treat a
 * nearby response as an in-context completion example and can copy it when
 * the next player action is semantically similar.  That is exactly how a
 * second "phone call" turn became a word-for-word repeat of the first.
 *
 * The durable facts are already available on the event's structured fields
 * (and through RAG/memories).  This deliberately keeps the recent-turn ledger
 * factual, compact, and free of copyable story phrasing.
 */
function structuredOutcomeFacts(event: any): string[] {
  const data = event?.data || {}
  const facts: string[] = []

  const present = Array.isArray(data.present_characters)
    ? data.present_characters
        .map((name: unknown) => String(name || '').trim())
        .filter(Boolean)
        .slice(0, 8)
    : []
  if (present.length > 0) facts.push(`Present: ${present.join(', ')}`)

  const deltas = Array.isArray(data.codex_deltas) ? data.codex_deltas : []
  for (const delta of deltas.slice(0, 4)) {
    const name = String(delta?.resolved_name || delta?.name || '').trim()
    if (!name) continue
    const state = Array.isArray(delta?.mutable_state)
      ? delta.mutable_state
          .map((item: unknown) => String(item || '').trim())
          .filter(Boolean)
          .slice(0, 3)
      : []
    const disposition = String(delta?.disposition_to_player || '').trim()
    if (state.length > 0) facts.push(`${name}'s current state: ${state.join(', ')}`)
    if (disposition) facts.push(`${name}'s disposition toward the player: ${disposition}`)
  }

  const stateMutations = data.state_mutations
  if (stateMutations && typeof stateMutations === 'object' && !Array.isArray(stateMutations)) {
    const changes = Object.entries(stateMutations)
      .slice(0, 6)
      .map(([key, value]) => `${key}: ${String(value)}`)
    if (changes.length > 0) facts.push(`World state changes: ${changes.join('; ')}`)
  }

  const flagMutations = data.flag_mutations
  if (flagMutations && typeof flagMutations === 'object' && !Array.isArray(flagMutations)) {
    const changes = Object.entries(flagMutations)
      .slice(0, 6)
      .map(([key, value]) => `${key}: ${String(value)}`)
    if (changes.length > 0) facts.push(`Story flag changes: ${changes.join('; ')}`)
  }

  if (event?.scene_tag) facts.push(`Scene mode: ${String(event.scene_tag)}`)
  return facts
}

function compactPersonaLine(input: PromptInput): string {
  const p = input.playerPersona
  if (!p?.name) return ''
  const parts: string[] = [`Name: ${String(p.name).trim()}`]
  if (p.gender) parts.push(`Gender: ${p.gender === 'non_binary' ? 'non-binary' : p.gender}`)
  if (typeof p.age === 'number') parts.push(`Age: ${p.age}`)
  if (p.description) parts.push(`Description: ${String(p.description).replace(/\s+/g, ' ').trim().slice(0, 500)}`)
  if (p.other_info) parts.push(`Other: ${String(p.other_info).replace(/\s+/g, ' ').trim().slice(0, 500)}`)
  return parts.join('\n')
}

/**
 * Per-section context budget CEILINGS (tokens). A safety net so no single
 * reference section can crowd out the others or push the prompt past
 * MAX_CONTEXT_TOKENS. Generous on purpose: in normal worlds every ranked item
 * fits and nothing is trimmed. When they do bite (very large worlds), items
 * are already sorted most-relevant-first — codex by recency-weighted
 * importance, memories by RRF, threads by importance — so only the LEAST
 * relevant tail is dropped.
 */
const SECTION_TOKEN_BUDGET = {
  codex: 1800,
  memories: 1100,
  lore: 450,
  threads: 350,
  summaries: 500,
} as const

/**
 * Packet-level allocation: recent-turn continuity gets a GUARANTEED floor, and
 * the reference sections share what remains after the static prefix —
 * proportionally (ratios mirror the ceilings above), each still capped at its
 * ceiling. In normal worlds the pool exceeds every ceiling, so nothing
 * changes; in worlds with a huge static prefix the reference sections shrink
 * together instead of independently overflowing and starving recents to zero.
 */
const RECENTS_FLOOR_TOKENS = 1000
/** Headroom for the small uncapped dynamic blocks (protagonist card, persona,
 *  state/flags, directives) + the POV reminder and current turn. */
const FIXED_OVERHEAD_TOKENS = 700
const REFERENCE_SHARE = {
  codex: 0.45,
  memories: 0.28,
  lore: 0.1,
  threads: 0.08,
  summaries: 0.09,
} as const

function allocateSectionBudgets(staticTokens: number, maxTokens: number) {
  const pool = Math.max(
    600, // never zero out reference context entirely, even under extreme prefixes
    maxTokens - staticTokens - RECENTS_FLOOR_TOKENS - FIXED_OVERHEAD_TOKENS,
  )
  return {
    codex: Math.min(SECTION_TOKEN_BUDGET.codex, Math.floor(pool * REFERENCE_SHARE.codex)),
    memories: Math.min(SECTION_TOKEN_BUDGET.memories, Math.floor(pool * REFERENCE_SHARE.memories)),
    lore: Math.min(SECTION_TOKEN_BUDGET.lore, Math.floor(pool * REFERENCE_SHARE.lore)),
    threads: Math.min(SECTION_TOKEN_BUDGET.threads, Math.floor(pool * REFERENCE_SHARE.threads)),
    summaries: Math.min(SECTION_TOKEN_BUDGET.summaries, Math.floor(pool * REFERENCE_SHARE.summaries)),
  }
}

/**
 * Keep leading items (already priority-ordered) whose cumulative token cost
 * stays within `budget`. Always keeps at least the first item so a section is
 * never silently emptied by an over-budget head.
 */
function withinTokenBudget(items: string[], budget: number): string[] {
  const kept: string[] = []
  let used = 0
  for (const item of items) {
    const t = countTokens(item)
    if (used + t > budget && kept.length > 0) break
    used += t
    kept.push(item)
  }
  return kept
}

function formatRecentTurnForContinuity(event: any): string {
  const action = event?.data?.world_action as Record<string, unknown> | undefined
  const parts = eventPlayerParts(event)
  const lines = [`Turn ${event.sequence || '?'}:`]
  if (action?.kind === 'travel') {
    const destination = String(action.destination || '').trim()
    const companions = Array.isArray(action.companions)
      ? action.companions.map((name) => String(name || '').trim()).filter(Boolean)
      : []
    lines.push(
      `- Player world action already happened: travelled to ${destination || 'the chosen destination'}${companions.length ? ` with ${companions.join(', ')}` : ' alone'}.`,
    )
  } else if (action?.kind === 'relationship') {
    lines.push(
      `- Player world action already happened: ${String(action.character || 'That character')} is their ${String(action.relation || 'confirmed relation')}.`,
    )
  } else if (parts.narrationFacts.length > 0) {
    lines.push(`- Player actions already happened: ${parts.narrationFacts.join('; ')}`)
  }
  if (parts.spoken) {
    lines.push(`- Player spoke: ${parts.spoken}`)
  } else if (!action && parts.narrationFacts.length === 0) {
    lines.push(`- Player waited/observed without speaking.`)
  }
  for (const fact of structuredOutcomeFacts(event)) {
    lines.push(`- Recorded outcome: ${fact}`)
  }
  return lines.join('\n')
}

/**
 * Persisted hygiene findings are safe, useful continuity: they carry a small
 * corrective rule into the next turn without carrying any copyable prose. This
 * deliberately maps only stable formatting/pacing failures, not subjective
 * style judgments or raw issue details.
 */
function recentHygieneReminders(events: any[], messageLength?: MessageLength): string[] {
  const codes = new Set<string>()
  for (const event of (events || []).slice(-3)) {
    const issues = event?.data?.prose_hygiene_issues
    if (!Array.isArray(issues)) continue
    for (const issue of issues) {
      if (typeof issue?.code === 'string') codes.add(issue.code)
    }
  }

  const reminders: string[] = []
  const selectedLength = messageLength || 'medium'
  if (
    codes.has('unquoted_text_outside_markers') ||
    codes.has('plain_narration_outside_markers') ||
    codes.has('unbalanced_italics') ||
    codes.has('double_asterisk_markers')
  ) {
    reminders.push(
      'Put every non-spoken narration fragment inside single asterisks; only spoken dialogue may appear outside them.',
    )
  }
  if (codes.has('unbalanced_dialogue_quotes')) {
    reminders.push('Balance every dialogue quote and keep quoted speech distinct from its italicized attribution.')
  }
  if (codes.has('incomplete_ending')) {
    reminders.push('Finish on a complete, punctuated story beat; never stop mid-sentence.')
  }
  if (codes.has('short_reply_overexpanded') || codes.has('too_many_paragraphs') || codes.has('length_too_long')) {
    const layout = selectedLength === 'short'
      ? 'one compact paragraph with only the essential consequence'
      : selectedLength === 'long'
        ? '3–5 developed paragraphs without padding'
        : '2–3 short paragraphs without bloat'
    reminders.push(`Honor the selected ${selectedLength} length: ${layout}.`)
  }
  if (codes.has('length_too_short') || codes.has('too_few_paragraphs') || codes.has('long_reply_underdeveloped')) {
    reminders.push(`Honor the selected ${selectedLength} length with a complete reaction and consequence; do not undercut the beat.`)
  }
  return reminders
}

function currentTurnUserMessage(input: PromptInput): string {
  const spoken = (input.userSpokenInput ?? input.userMessage).trim()
  const facts = (input.userNarrationFacts || []).map((f) => String(f || '').trim()).filter(Boolean)
  const fallbackInstruction =
    !spoken && facts.length === 0 && input.userMessage.trim() && !/no spoken dialogue/i.test(input.userMessage)
      ? input.userMessage.trim()
      : ''
  const lines = ['CURRENT PLAYER TURN:']
  if (facts.length > 0) {
    lines.push(
      'Player actions/narration already happened in this turn. Treat them as immediate canon, not suggestions or future intent:',
    )
    for (const fact of facts) lines.push(`- ${fact}`)
  }
  lines.push(`Player spoken aloud: ${spoken || '(none)'}`)
  if (fallbackInstruction) lines.push(`Turn instruction: ${fallbackInstruction}`)
  lines.push(
    'Now respond to this exact current turn. Do not replay, paraphrase, line-edit, or lightly modify the previous assistant response. Advance from the latest established beat and directly acknowledge any player action facts that just happened.',
  )
  return lines.join('\n')
}

export function buildPrompt(input: PromptInput): { messages: PromptMessage[] } {
  const messages: PromptMessage[] = []

  // ── STATIC SYSTEM PROMPT (cacheable prefix) ─────
  // World-stable content emitted first and kept byte-identical across every turn
  // of this instance so OpenAI automatic prompt caching can reuse it. NOTHING
  // that varies per turn (state, flags, retrieved lore/memories) belongs here.
  let staticContent = ''

  // Identity framing — POV is player-controllable (defaults to third person)
  const pov = input.narrationPov ?? 'third'
  if (input.isSentient) {
    staticContent += `${input.seedPrompt}\n\n`
    if (pov === 'first') {
      staticContent += `You ARE this entity. Speak and act in the FIRST person (I, me, my). You have feelings and react to the player's actions emotionally and physically. Refer to the player directly as you, never as "the player" or "the user".\n\n`
    } else {
      staticContent += `You ARE this entity, but portray yourself in the THIRD person — narrate your own speech, actions, and feelings with pronouns by default (she/he/they), using your name only when clarity genuinely requires it. You still have feelings and react emotionally and physically. Refer to the player directly as you, never as "the player" or "the user" (e.g. *She watches you*, not *She watches the player*).\n\n`
    }
  } else {
    // For a Game Master, POV chooses how the player is addressed: second-person
    // immersive (you) vs third-person (the adventurer).
    if (pov === 'first') {
      staticContent += `You are the Game Master of this world. Narrate in the SECOND person, addressing the player directly as you (e.g. You push open the tavern door and the room falls silent). You describe the world, its inhabitants, and the consequences of the player's actions.\n\n`
    } else {
      staticContent += `You are the Game Master of this world. Narrate in the THIRD person, referring to the player by their role rather than you (e.g. The adventurer pushes open the tavern door). You describe the world, its inhabitants, and the consequences of the player's actions.\n\n`
    }
    staticContent += `World Premise: ${input.seedPrompt}\n\n`
  }

  // Narrative VOICE / STYLE — the single biggest lever on how it sounds.
  // World-stable (per instance) so it stays in the cacheable prefix and costs ~0
  // extra TTFT after turn 1. Placed high so it frames everything that follows.
  const styleBlock = buildStyleBlock(input.narrativeStyle, input.styleNotes)
  if (styleBlock) {
    staticContent += `${styleBlock}\n\n`
  }
  // Tone is the player's diction/register control. It follows the creator's
  // genre style so its wording priority is explicit, but is stable per session
  // and therefore remains inside the cacheable static prefix.
  staticContent += `${buildNarrationToneDirective(input.narrationTone, input.toneExampleSeed)}\n\n`

  // Global lore — typically the largest block, hence the biggest caching payoff
  staticContent += `WORLD LORE:\n${input.globalLore}\n\n`

  staticContent += `NON-NEGOTIABLE NATURAL PROSE HYGIENE:
- Natural conversation flow is mandatory. Character-name repetition is a quality failure.
- Character names are for disambiguation only: first entrance, reintroduction after absence, direct address, multiple same-gender/ambiguous actors, or explicit contrast between characters.
- If the active character is already clear, do NOT name them again. Use pronouns, body language, gesture, action, silence, dialogue, role descriptors, or setting beats instead.
- Do not use a protagonist's or character's full canonical name in ordinary narration unless the scene genuinely requires formal identification. Prefer a first name or pronoun when a name is unavoidable.
- Do not open replies with a character name by default. Open with speech, action, reaction, body language, silence, setting, or a pronoun.
- Never start consecutive sentences or paragraphs with any character name.
- Never repeat the same character name as a rhythmic sentence starter.
- Do not mention every character in the codex. Refer only to characters actually present, speaking, acting, or being directly discussed in this turn.
- In a one-on-one beat, avoid names almost entirely after the character is established. A single short name is acceptable only if clarity would otherwise suffer.
- In multi-character scenes, use names sparingly to establish who acts or speaks, then switch back to pronouns and distinct actions as soon as clarity is restored.
- Never call the visible player "user". In sentient character chats, never call them "player" either; address them as "you" even when narrating the character in third person.

`

  staticContent += `ANTI-HALLUCINATION RULES:
- Treat lore, memories, summaries, and character cards as reference constraints, not a menu of things to insert.
- Do not introduce new named characters, locations, factions, lore objects, powers, dangers, romance escalations, or plot twists unless the current player turn, recent continuity, or active scene clearly calls for them.
- If a detail is not in the current turn, recent continuity, world state, active flags, relevant lore, memories, or character cards, do not assert it as fact.
- If only one character is active in the beat, keep the reply focused on them and the player. Do not cut away to off-screen characters.
- Prefer reacting to the player's latest action over expanding the setting with unrelated inventions.

`

  // Response format instructions (static for the life of the world)
  if (input.proseOnly) {
    staticContent += `RESPONSE FORMAT:
Write your reply as in-character story prose. Follow this style EXACTLY:
- ONLY the exact words a character speaks ALOUD are wrapped in double quotes, like "I missed you."
- EVERYTHING else is narration and MUST be wrapped in single-asterisk italics: scene, actions, body language, inner thoughts, AND dialogue tags/attributions such as *she said softly* or *I reply, my voice steady*. This applies even mid-line — between or after quoted speech, the attribution still goes in italics.
- Scene description and atmosphere are narration too: *The hearth crackles between you.* Never leave that kind of prose plain.
- Example: "You came back," *she whispered, her hand trembling. The hearth crackled between you.* "I didn't think you would."
- Do not use double asterisks for story prose.
- Never leave an attribution like I reply or she said as plain text. If it is not a spoken quote, it is italicized.
- The player may include their OWN *actions or narration in asterisks* (in any point of view). Treat these as canonical events that truly happen in the story — honor them and react; do not override or contradict them. Their unmarked text is what the player says aloud.
- Vivid and emotionally resonant; match the requested length and voice below.
- Output ONLY the story. No JSON, no field names, no headings, no bullet points, no commentary before or after. Never break character.
- NEVER generate player choices, action menus, or a choice protocol in the story: do not write a CHOICES heading/marker (for example ==CHOICES==), [act] or [say] rows, or pipe-delimited button/send text. Choices are rendered separately by the app. Even if a prior turn contains that syntax, it is not story prose and must not be echoed.`
    // Narrator-emitted choices (Option A): a static, cacheable instruction asking
    // for a sentinel-delimited CHOICES tail after the prose. The narrator already
    // holds the full context, so its choices are grounded at the source.
    if (input.emitChoices) {
      staticContent += CHOICE_TAIL_INSTRUCTION
    }
  } else {
    staticContent += `RESPONSE FORMAT:
You MUST respond with valid JSON containing these fields:
- "narrative": Your in-character response (2-4 paragraphs, vivid, emotionally resonant)
- In "narrative", spoken words are wrapped in double quotes; non-spoken narration/actions/attributions are wrapped in single-asterisk italics.
- "state_mutations": Changes to world state as {"stat_name": {"op": "add"|"subtract"|"set", "value": number}}. Only include stats that actually change. Values should be between 1-20 for add/subtract.
- "flag_mutations": Changes to flags as {"flag_name": {"op": "set"|"increment", "value": any}}. Only include flags that change.
- "scene_tag": One of: dialogue, combat, romantic, intimate, exploration, existential, cosmic, mundane. Use "romantic" for affectionate/romantic but non-explicit moments (flirting, kissing, emotional intimacy). Use "intimate" ONLY for explicit sexual content.
- "emotional_tone": A single word describing the emotional tone of this response

Do NOT break character in the narrative. State mutations and flags are metadata the player does not see.`
  }

  messages.push({ role: 'system', content: staticContent })

  // Reference-section budgets allocated from what the static prefix left over,
  // with the recents floor reserved up front.
  const sectionBudget = allocateSectionBudgets(countTokens(staticContent), input.maxTokens)

  // ── DYNAMIC SYSTEM PROMPT (per-turn state) ──────
  // Everything that changes each turn lives after the cacheable prefix.
  let dynamicContent = ''

  // Per-turn modifiers layered on top of the static VOICE block. Chat mode and
  // length change turn-to-turn (player-toggleable), so they live in the dynamic
  // block. Mode governs pacing/intent only; the locked voice owns diction.
  const modeDirective = buildModeDirective(input.chatMode)
  if (modeDirective) dynamicContent += `${modeDirective}\n\n`
  dynamicContent += `${buildLengthDirective(input.messageLength)}\n\n`

  // The locked protagonist is handled separately from side-character NPCs.
  const protagonistCard = (input.characterCodex || []).find((c) => c.is_protagonist)
  // Identity guard: a card whose name or alias matches the protagonist's is a
  // duplicate referent of the SAME person (e.g. a role title minted as its own
  // card). Presenting it as an NPC would make the narrator treat the player as
  // two people — exclude it from injection entirely.
  const protagonistRefs = new Set(
    [protagonistCard?.canonical_name, ...(protagonistCard?.aliases || [])]
      .filter((n): n is string => !!n)
      .map((n) => n.trim().toLowerCase()),
  )
  const npcCodex = (input.characterCodex || []).filter(
    (c) =>
      !c.is_protagonist &&
      !(c.canonical_name && protagonistRefs.has(c.canonical_name.trim().toLowerCase())) &&
      !(c.aliases || []).some((a) => protagonistRefs.has(a.trim().toLowerCase())),
  )

  if (protagonistCard) {
    // Show the most recent facts (storage may hold more between compactions).
    const facts = (protagonistCard.immutable_facts || []).slice(-14)
    const state = protagonistCard.mutable_state || []
    if (input.isSentient) {
      // Identity is already in the seed ("You ARE Elara"), so don't re-inject
      // persona/appearance. But DO inject evolving history/status so first-person
      // narration stays consistent (e.g. she remembers she broke the engagement).
      if (facts.length || state.length) {
        dynamicContent += `YOUR EVOLVING STATE (you are ${protagonistCard.canonical_name} — stay consistent with what has happened to you):\n`
        for (const f of facts) dynamicContent += `- (happened) ${f}\n`
        for (const s of state) dynamicContent += `- (current) ${s}\n`
        dynamicContent += `\n`
      }
    } else {
      // GM world: the protagonist is the PLAYER. Tell the narrator who they are
      // so the story stays anchored to the player's character + their changes.
      dynamicContent += `THE PLAYER (protagonist — narrate the world around them): ${protagonistCard.canonical_name}\n`
      if (protagonistCard.persona) dynamicContent += `- identity: ${protagonistCard.persona}\n`
      for (const f of facts) dynamicContent += `- (happened) ${f}\n`
      for (const s of state) dynamicContent += `- (current) ${s}\n`
      dynamicContent += `\n`
    }
  }

  // CANON BRIEF — established relationships (incl. lifecycle state). Placed before
  // the cast list and framed as hard canon: these are derived from the structured
  // kinship graph, so they must never be contradicted (this is what stops "your
  // father died" on turn N becoming "you meet your father" on turn N+10). Small +
  // bounded (≤14 lines) so it's never trimmed.
  if (input.relationshipFacts && input.relationshipFacts.length > 0) {
    dynamicContent += `ESTABLISHED RELATIONSHIPS (canon — treat as settled fact; never contradict, reverse, or forget these):\n`
    for (const fact of input.relationshipFacts) {
      dynamicContent += `- ${fact}\n`
    }
    dynamicContent += `\n`
  }

  if (npcCodex.length > 0) {
    dynamicContent += `CANONICAL CHARACTER CODEX (continuity reference only — not the current scene roster):
- Never contradict these facts when a listed character is actually relevant.
- Do NOT introduce, mention, name-drop, summarize, or cut away to a codex character merely because they appear in this list.
- A codex character belongs in the next reply only if they are already present in the active scene, the player directly mentions them, recent events put them in focus, or their absence would create a clear continuity error.
- If the current beat involves one active character, keep the reply centered on that character and leave unrelated codex characters unmentioned.
CHARACTER CARDS:
`
    // Build each card as a line, keeping the highest-ranked cards that fit the
    // codex token budget (the slice is already recency-importance ranked, so a
    // trim drops the least-relevant cards first).
    let codexTokensUsed = 0
    for (const c of npcCodex.slice(0, 16)) {
      let line = `- ${c.canonical_name}`
      if (c.role) line += ` | role: ${c.role}`
      if (c.aliases && c.aliases.length) line += ` | aliases: ${c.aliases.join(', ')}`
      if (c.appearance) line += ` | appearance: ${c.appearance}`
      if (c.persona) line += ` | persona: ${c.persona}`
      if (c.immutable_facts && c.immutable_facts.length) {
        line += ` | immutable facts: ${c.immutable_facts.slice(-14).join('; ')}`
      }
      if (c.mutable_state && c.mutable_state.length) {
        line += ` | current state: ${c.mutable_state.join('; ')}`
      }
      if (c.disposition_to_player) {
        line += ` | disposition toward player: ${c.disposition_to_player}`
      }
      if (c.hidden_thought) {
        line += ` | private thought (internal only, never quoted verbatim): ${c.hidden_thought}`
      }
      line += '\n'
      const lineTokens = countTokens(line)
      if (codexTokensUsed + lineTokens > sectionBudget.codex && codexTokensUsed > 0) break
      codexTokensUsed += lineTokens
      dynamicContent += line
    }
    dynamicContent += '\n'
  }

  if (input.focusCharacterName && input.focusCharacterName.trim()) {
    dynamicContent += `FOCUS CHARACTER: ${input.focusCharacterName.trim()} (continuity anchor, not a forced cameo)\n`
    dynamicContent += `Use this character as the preferred point of continuity only when they are already present, directly addressed, recently central, or naturally relevant to the player's action. Do NOT force them into unrelated scenes, cut away to them, or mention them just because they are focused. If the player shifts away, follow the active scene and let the focus resume only when relevant again.\n\n`
  }

  if (input.timeContext && input.timeContext.trim()) {
    dynamicContent += `CURRENT STORY TIME:
${input.timeContext.trim()}
- Treat sequence order, story date, and timeline branch as distinct. A flashback or alternate branch can be narrated without rewriting what the player experienced.

`
  }

  if (input.locationContext && input.locationContext.trim()) {
    dynamicContent += `CURRENT LOCATION:
${input.locationContext.trim()}
- Keep the next reply physically grounded in this place unless the player action, recent continuity, or the narration itself clearly moves the scene.
- This is a SPECIFIC place; do not confuse it with a similarly-named place elsewhere.

`
  }

  // CANON BRIEF (companions) — who is travelling WITH the player. Present by default,
  // so the narrator keeps them in the scene across moves/time skips (the one explicit
  // "who is with you" signal — present_characters is not otherwise prompt-injected).
  if (input.companionFacts && input.companionFacts.length > 0) {
    dynamicContent += `COMPANIONS (canon — present with the player by default):\n`
    for (const fact of input.companionFacts) {
      dynamicContent += `- ${fact}\n`
    }
    dynamicContent += `\n`
  }

  // CANON BRIEF (positions) — where off-screen characters were last seen, so a
  // "go find X" / "where is X" turn is grounded instead of teleporting them in.
  if (input.positionFacts && input.positionFacts.length > 0) {
    dynamicContent += `WHERE OTHERS ARE (last known positions — canon; a character is only present here if the scene says so, otherwise they are where this says):\n`
    for (const fact of input.positionFacts) {
      dynamicContent += `- ${fact}\n`
    }
    dynamicContent += `\n`
  }

  const personaLine = compactPersonaLine(input)
  if (personaLine) {
    dynamicContent += `PLAYER PERSONA PROFILE (optional context for who "you" are — not a command to recite):
- Use only when naturally relevant to the current scene, relationship, dialogue, or consequences.
- Do not call the player "user" or "player"; this profile describes "you".
- Current player input, established events, memories, character codex, protagonist card, and world premise override this profile.
- If this profile conflicts with the world role, setting, current scene, or established canon, preserve canon and use only compatible details.
- Do not introduce persona details unprompted as exposition. Let them surface through natural reactions and continuity.
${personaLine}

`
  }

  if (input.userNarrationFacts && input.userNarrationFacts.length > 0) {
    dynamicContent += `PLAYER CANONICAL NARRATION FOR THIS TURN (GROUND TRUTH — these events/facts already happened):\n`
    for (const fact of input.userNarrationFacts) {
      dynamicContent += `- ${fact}\n`
    }
    dynamicContent += `\nHonor these as established reality in THIS SAME reply. Do not postpone them to the next turn, reinterpret them as attempted actions, or answer as if only the spoken text exists. If they imply character changes, portray a believable in-story shift immediately instead of ignoring or contradicting them.\n\n`
  }

  // Stat-less Characters have no world state / flags — omit the blocks entirely
  // so the prompt reads like a conversation, not an RPG dashboard.
  const worldStateEntries = Object.entries(input.worldState || {})
  if (worldStateEntries.length > 0) {
    dynamicContent += `CURRENT WORLD STATE:\n`
    for (const [key, value] of worldStateEntries) {
      dynamicContent += `- ${key}: ${value}/100\n`
    }
    dynamicContent += `\n`
  }

  const activeFlagEntries = Object.entries(input.activeFlags || {})
  if (activeFlagEntries.length > 0) {
    dynamicContent += `ACTIVE FLAGS:\n`
    for (const [key, value] of activeFlagEntries) {
      dynamicContent += `- ${key}: ${value}\n`
    }
    dynamicContent += `\n`
  }

  if (input.retrievedLore.length > 0) {
    dynamicContent += `RELEVANT LORE DETAILS (reference only — use only if it directly applies to the current turn; do not introduce these as active scene elements by default):\n`
    for (const lore of withinTokenBudget(input.retrievedLore, sectionBudget.lore)) {
      dynamicContent += `- ${lore}\n`
    }
    dynamicContent += `\n`
  }

  if (input.retrievedMemories.length > 0) {
    dynamicContent += `THINGS YOU REMEMBER ABOUT THIS PLAYER (reference only — use for continuity, not as a reason to change topic or summon unrelated events):\n`
    for (const mem of withinTokenBudget(input.retrievedMemories, sectionBudget.memories)) {
      dynamicContent += `- ${mem}\n`
    }
    dynamicContent += `\n`
  }

  if (input.openThreads && input.openThreads.length > 0) {
    dynamicContent += `OPEN THREADS (unresolved promises, conflicts, and questions the story still owes a payoff for):
- These are live continuity debts, not a to-do list. Do NOT force them into this turn or resolve several at once.
- Let them quietly inform reactions, tension, and consequences when the current scene naturally touches them.
- If the player's current action directly engages one, honor it faithfully — characters remember what was promised.
`
    for (const thread of withinTokenBudget(input.openThreads, sectionBudget.threads)) {
      dynamicContent += `- ${thread}\n`
    }
    dynamicContent += `\n`
  }

  if (input.relevantSummaries && input.relevantSummaries.length > 0) {
    dynamicContent += `RELEVANT PAST CHAPTERS (compressed recall of earlier, possibly distant parts of the story that bear on this turn — reference only, for continuity; do not replay them as current action):\n`
    for (const summary of withinTokenBudget(input.relevantSummaries, sectionBudget.summaries)) {
      dynamicContent += `- ${summary}\n`
    }
    dynamicContent += `\n`
  }

  messages.push({ role: 'system', content: dynamicContent })

  // ── SCENE SUMMARY ──────────────────────────────
  if (input.sceneSummary) {
    messages.push({
      role: 'system',
      content: `PREVIOUS SCENE SUMMARY:\n${input.sceneSummary}`,
    })
  }

  // ── RECENT EVENTS (continuity ledger, not style examples) ───────
  // HARD floor: recent-turn continuity is the one section the story cannot
  // function without, so it always gets at least RECENTS_FLOOR_TOKENS even if
  // an oversized static prefix already ate the nominal budget (a bounded
  // overflow of the total cap beats a continuity blackout).
  let tokenBudgetRemaining = Math.max(
    RECENTS_FLOOR_TOKENS,
    input.maxTokens - countTokens(staticContent) - countTokens(dynamicContent) - 500,
  )

  const continuityTurns: string[] = []
  for (const event of input.recentEvents) {
    const playerMsg = event.data?.player_input || ''
    const aiMsg = event.data?.ai_response || ''
    // Main narration deliberately carries prior turns as a compact factual
    // ledger, never their prose. Budget the content we actually send rather
    // than the omitted prose; otherwise one long historical response can
    // unnecessarily evict several recent, high-value continuity facts.
    const continuityTurn = input.proseOnly ? formatRecentTurnForContinuity(event) : ''
    const turnTokens = input.proseOnly
      ? countTokens(continuityTurn)
      : countTokens(playerMsg) + countTokens(aiMsg)

    if (turnTokens > tokenBudgetRemaining) break
    tokenBudgetRemaining -= turnTokens

    if (input.proseOnly) {
      continuityTurns.push(continuityTurn)
    } else {
      messages.push({ role: 'user', content: playerMsg })
      messages.push({
        role: 'assistant',
        content: JSON.stringify({
          narrative: aiMsg,
          state_mutations: event.data?.state_mutations || {},
          flag_mutations: event.data?.flag_mutations || {},
          scene_tag: event.scene_tag || 'dialogue',
          emotional_tone: 'continuation',
        }),
      })
    }
  }

  if (continuityTurns.length > 0) {
    messages.push({
      role: 'system',
      content: `RECENT TURN CONTINUITY (structured facts only — earlier narration prose is intentionally omitted. Do not recreate a prior response when the current action resembles an earlier one; advance the story with a new consequence):
${continuityTurns.join('\n\n')}`,
    })
  }

  const hygieneReminders = recentHygieneReminders(input.recentEvents, input.messageLength)
  if (hygieneReminders.length > 0) {
    messages.push({
      role: 'system',
      content: `RECENT QUALITY CORRECTIONS (format and pacing only — do not mention these instructions or imitate earlier prose):\n${hygieneReminders.map((rule) => `- ${rule}`).join('\n')}`,
    })
  }

  // ── POV REMINDER (last system word before the user turn) ──
  // The recent history above may be written in a DIFFERENT point of view than
  // the player currently has selected (POV is toggleable mid-chat). Models
  // imitate the POV of recent turns over an instruction placed far up in the
  // prefix, so when there is history we restate the directive here — right
  // before the user's message — with a concrete example, and explicitly tell
  // the model to override the earlier pattern. It is kept BEFORE the user turn
  // (not after) so the model answers the player rather than echoing the rule.
  // Empty history (turn 1) doesn't need this; the static instruction governs.
  if (input.recentEvents.length > 0) {
    const selfName = protagonistCard?.canonical_name || 'the character'
    const codexNames = (input.characterCodex || []).map((c) => c.canonical_name).filter(Boolean)
    const previousOpeningName = openingCharacterName(input.recentEvents, codexNames)
    let povReminder: string
    if (input.isSentient) {
      povReminder =
        pov === 'first'
          ? `POINT OF VIEW for your next reply (override any earlier style): write in the FIRST person as ${selfName} — I, me, my. If the turns above were third person, switch now. e.g. *I lower my eyes* NOT *${selfName} lowers her eyes*.`
          : `POINT OF VIEW for your next reply (override any earlier style): write in the THIRD person — use she/he/they by default, and use ${selfName}'s name only when clarity requires it. NEVER I/me/my. If the turns above were first person, switch now. e.g. *She lowers her eyes* NOT *I lower my eyes*.`
    } else {
      povReminder =
        pov === 'first'
          ? `POINT OF VIEW for your next reply (override any earlier style): write in the SECOND person, addressing the player as you. If the turns above did otherwise, switch now. e.g. *You push the door open* NOT *The adventurer pushes the door open*.`
          : `POINT OF VIEW for your next reply (override any earlier style): write in the THIRD person, referring to the player by their role, NEVER you. If the turns above used second person, switch now. e.g. *The adventurer pushes the door open* NOT *You push the door open*.`
    }
    // Reinforce VOICE + tone + length here too: weak models imitate the register
    // of recent history over a static instruction far up the prefix, exactly like
    // POV. A compact restatement right before the user turn keeps the writing on
    // the chosen voice regardless of which model is serving.
    const styleCue = buildStyleReminder(
      input.narrativeStyle,
      modeReminderLabel(input.chatMode),
      input.messageLength,
      narrationToneLabel(input.narrationTone),
    )
    if (styleCue) povReminder += `\n${styleCue}`
    povReminder += `\n${buildNarrationToneReminder(input.narrationTone)}`
    povReminder += `\nNAME HYGIENE for your next reply: natural flow is mandatory. Do not open with a character name unless there is no other clear option. Use full names only for formal identification or unavoidable disambiguation. Prefer pronouns, action, body language, dialogue, silence, setting, or role descriptors. Do not repeat the same name as a sentence rhythm.`
    if (input.isSentient) {
      povReminder += `\nPLAYER ADDRESS for your next reply: address the player as "you"; never write "the player" or "the user" in story prose.`
    }
    if (previousOpeningName) {
      povReminder += ` Do not start this reply with ${previousOpeningName}; the previous assistant turn already opened that way.`
    }
    if (input.isContinuation && input.isSentient) {
      povReminder += ` This is an autonomous continuation with no new player speech, so do not open with ${selfName}; start with pronoun, action, body language, speech, or setting instead.`
    }
    povReminder += `\nHISTORY HYGIENE: treat previous assistant turns as continuity facts, not prose style to imitate. If earlier turns overused names, repeated sentence shapes, malformed formatting, awkward phrasing, or drifted from the current voice, correct course and follow the current instructions instead.`
    povReminder += `\nANTI-HALLUCINATION: answer only from the current player turn, recent continuity, active scene, and provided reference material. Do not add unrelated lore, off-screen characters, sudden dangers, new locations, or new plot complications just to make the response dramatic.`
    povReminder += `\nFORMAT HYGIENE: spoken words must be wrapped in double quotes. Every non-spoken element must be wrapped in single-asterisk italics, including actions, scene description, atmosphere, inner thoughts, and dialogue tags such as *she said* or *I whisper*. Text outside asterisks must be quoted speech only. Do not use double asterisks. Do not leave narration or attributions as plain text.`

    messages.push({ role: 'system', content: povReminder })
  }

  // ── CURRENT USER MESSAGE ───────────────────────
  messages.push({
    role: 'user',
    content: currentTurnUserMessage(input),
  })

  return { messages }
}
