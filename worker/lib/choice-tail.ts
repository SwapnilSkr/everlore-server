/**
 * Narrator-emitted CHOICES tail (Option A spike).
 *
 * The tap-to-play choices are a GENERATION act, not bookkeeping extraction: the
 * model that wrote the prose — with the player's input, memories, threads, codex,
 * and the world's full premise in context — is the only one that already knows
 * whether "the ghost in the doorway" is a literal spirit or a metaphor for the
 * overlooked protagonist. So we let the NARRATOR append its own choices after the
 * prose, instead of re-deriving them in a context-starved second model pass.
 *
 * To keep token-by-token prose streaming intact we don't use JSON (the uncensored
 * NSFW narration models can't emit it anyway). The narrator writes a sentinel line
 * then one plain line per choice. This module owns three pure concerns so the live
 * path and the audit can't drift:
 *   1. {@link makeChoiceTailFilter} — strips the tail out of the player-facing
 *      delta stream as chunks arrive (the player must never see the marker).
 *   2. {@link parseChoiceTail} — parses the block into raw choice objects.
 *   3. {@link CHOICE_SENTINEL} / {@link CHOICE_TAIL_INSTRUCTION} — the contract,
 *      shared by the prompt builder so the format we ask for is the format we parse.
 */

/** Marker that separates story prose from the machine-readable choices block.
 *  Chosen to be effectively impossible in natural story prose. */
export const CHOICE_SENTINEL = '===CHOICES==='

/** One raw choice as authored in the tail, pre-sanitization. */
export interface RawTailChoice {
  label: string
  kind: 'act' | 'say'
  send: string
}

/**
 * Stateful filter that splits a streaming completion into (a) the prose safe to
 * show the player right now and (b) the trailing choices block. Feed every model
 * chunk through {@link push}; publish whatever it returns. The filter holds back a
 * few trailing characters so a half-arrived sentinel ("===CHOIC") never flashes on
 * screen, and swallows everything once the full sentinel is seen.
 */
export interface ChoiceTailFilter {
  /** Feed a raw model chunk; returns the substring SAFE to display now ('' if none). */
  push(chunk: string): string
  /** Call once the stream ends; returns any final safe prose to flush ('' if none). */
  end(): string
  /** True once the sentinel has been seen — all prose is in and everything after is
   *  the (player-invisible) choices tail. Lets the caller end the visible stream the
   *  instant the story is done, so the typing indicator doesn't hang while the model
   *  writes hidden choices. */
  inTail(): boolean
  /** The prose with the choices tail removed (valid after the stream completes). */
  prose(): string
  /** The raw text after the sentinel ('' when the narrator emitted no tail). */
  choiceBlock(): string
}

/**
 * Models occasionally emit a near-miss of the canonical sentinel (for example
 * `==CHOICES==`) even when narrator-owned choices are disabled. Treat all such
 * protocol-looking markers as hidden metadata: the player must never see an
 * action menu duplicated inside the narrator bubble.
 */
function findChoiceMarker(text: string): { index: number; length: number } | null {
  const marker = /={2,}\s*choices\s*={2,}/i.exec(text)
  if (marker?.index != null) return { index: marker.index, length: marker[0].length }
  // Backstop for a model that skips the heading but starts emitting the wire
  // format itself. Narrative dialogue never uses these protocol tags.
  const row = /(?:^|\n)\s*\[(?:act|say)\]\s+/im.exec(text)
  if (row?.index != null) return { index: row.index, length: 0 }
  return null
}

export function makeChoiceTailFilter(): ChoiceTailFilter {
  let acc = ''
  let published = 0
  let cut = -1 // index where the sentinel starts; -1 until seen
  let markerLength = CHOICE_SENTINEL.length
  // Never emit a tail short enough to be a partial sentinel.
  const hold = CHOICE_SENTINEL.length - 1

  return {
    push(chunk: string): string {
      acc += chunk
      if (cut >= 0) return '' // already inside the choices block — swallow
      const marker = findChoiceMarker(acc)
      if (marker) {
        cut = marker.index
        markerLength = marker.length
        const out = acc.slice(published, cut)
        published = cut
        return out
      }
      // No (complete) sentinel yet: publish everything except a possible partial.
      const safeEnd = Math.max(published, acc.length - hold)
      if (safeEnd > published) {
        const out = acc.slice(published, safeEnd)
        published = safeEnd
        return out
      }
      return ''
    },
    end(): string {
      if (cut >= 0) return '' // tail was reached; nothing more is prose
      const out = acc.slice(published)
      published = acc.length
      return out
    },
    inTail(): boolean {
      return cut >= 0
    },
    prose(): string {
      return cut >= 0 ? acc.slice(0, cut) : acc
    },
    choiceBlock(): string {
      return cut >= 0 ? acc.slice(cut + markerLength) : ''
    },
  }
}

/** The label is a CHIP CAPTION — a clean imperative, never decorated. Even with the
 *  instruction, a model may wrap it in the *asterisks* / "quotes" it (correctly) uses
 *  on the send, or end it with sentence punctuation. Strip that decoration off the
 *  LABEL ONLY (the send stays verbatim) so the button never shows raw markup. */
function cleanLabel(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^[*"'“”‘’\s]+/, '')
    .replace(/[*"'“”‘’\s]+$/, '')
    .replace(/[.!?,;:]+$/, '')
    .trim()
}

/** Parse the post-sentinel block into raw choices. Tolerant: ignores blank lines,
 *  stray prose, and malformed rows; caps at 4. Lines look like:
 *    [act] Step closer | *I step closer, lowering my voice.* What are you hiding?
 *    [say] Welcome him back | You came back. I didn't think you would.
 *  Length clamps / send asterisk-wrapping are left to sanitizeChoices so the narrator
 *  path and the metadata path produce identically-shaped choices. */
export function parseChoiceTail(block: string): RawTailChoice[] {
  const out: RawTailChoice[] = []
  for (const line of String(block || '').split('\n')) {
    const m = line.match(/^\s*[-*]?\s*\[(act|say)\]\s*(.+?)\s*\|\s*(.+?)\s*$/i)
    if (!m) continue
    const label = cleanLabel(m[2])
    const send = m[3].trim()
    if (!label || !send) continue
    out.push({ kind: m[1].toLowerCase() as 'act' | 'say', label, send })
    if (out.length >= 4) break
  }
  return out
}

/** The instruction appended to the narrator prompt asking for the tail. Kept here
 *  next to the parser so the requested format and the parsed format stay in lockstep.
 *  Deliberately LEAN — the narrator already holds the POV, cast, persona, and world
 *  premise in context, so unlike the old metadata pass it needs no roster dump or
 *  figurative-vs-literal essay to ground a choice. */
export const CHOICE_TAIL_INSTRUCTION = `

AFTER the story prose, output a line containing ONLY the marker ${CHOICE_SENTINEL}, then 2-4 suggested next moves for the player — one per line — in EXACTLY this format:
[act] <label> | <send>
[say] <label> | <send>
Each line has TWO different parts split by a single pipe (|):
- <label> = a SHORT button caption, 2-6 words, an imperative the player gives themselves ("Walk away", "Block their view", "Demand an answer"). It is a summary, NOT the literal line — write NO quotation marks, NO *asterisks*, and NO trailing punctuation in the label.
- <send> = the FULL pre-filled player input that gets sent when the button is tapped. For [say] write the spoken words plainly in quotes; for [act] write the action in first person wrapped in *asterisks*.
The label and the send are NEVER identical — the label is the tidy caption, the send is the literal text. Worked example:
[say] Challenge the mood | "What exactly is the mood I'm disrupting?"
[act] Retreat to the attic | *I turn my back on them and climb to the only room that is mine.*
Choice rules:
- Every choice is the PLAYER'S OWN next move, written in the player's first person ("I ..."). Honor the WORLD MODE / POV established above for who "I" is.
- Use [say] when the send is words spoken aloud; use [act] when it is a silent physical action or narration.
- Make the set distinct in spirit (mix bold / cautious / emotional / curious).
- If a label sends the player to a specific destination ("Head for the cafe", "Go to the attic"), the <send> MUST explicitly name that exact same destination and describe going there. Never use vague wording such as "the one place that feels neutral"; it cannot be honored as a location commitment.
- Ground every choice in what THIS scene and the established world actually contain. Never invent a person, place, or relationship that does not exist. A figurative epithet you used for an existing person — "the ghost in the doorway", "the monster at the table" for someone present — is NOT a real separate being; never write a choice that treats it as one. Address the actual person instead.
- The ${CHOICE_SENTINEL} marker and everything after it is hidden metadata the player never reads as story — never mention it or let it leak into the prose above.`
