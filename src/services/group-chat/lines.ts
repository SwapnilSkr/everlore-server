import type { GroupLine, GroupMember, GroupOrigin, NamedLine } from './types'

export type LineCounts = Record<'player' | 'unknown' | 'off_list' | 'over_cap' | 'duplicate' | 'repeated_opener' | 'unsafe' | 'empty' | 'stage_directions' | 'copied_example' | 'trimmed' | 'repeated_idea' | 'invented_detail' | 'hidden_guess' | 'self_named' | 'repeated_sentence', number>
export const emptyLineCounts = (): LineCounts => ({ player: 0, unknown: 0, off_list: 0, over_cap: 0, duplicate: 0, repeated_opener: 0, unsafe: 0, empty: 0, stage_directions: 0, copied_example: 0, trimmed: 0, repeated_idea: 0, invented_detail: 0, hidden_guess: 0, self_named: 0, repeated_sentence: 0 })
const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()
const wordsOnly = (text: string) => normalized(text).replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim()
const sentencesOf = (text: string) => text.split(/(?<=[.!?…])\s+/u)
// Long enough to be a phrase, short enough to catch a stock line. Explicit lines share shorter ones fairly.
const REPEATED_SENTENCE_WORDS = 4

const opener = (text: string): string | undefined => {
  const words = stripStageDirections(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
  return words.length >= 2 ? words.slice(0, 2).join(' ') : undefined
}

export function parseLines(raw: string, members: GroupMember[], player: string, counts: LineCounts, soleSpeaker?: string): NamedLine[] {
  const names = new Map(members.map(member => [member.name.toLowerCase(), member.name]))
  const lines: NamedLine[] = []
  let current: NamedLine | undefined
  let unnamed = false
  let rejected = false
  for (const source of raw.split(/\r?\n/)) {
    const text = source.trim()
    if (!text) continue
    const prefix = text.match(/^\*{0,2}([^:*\n]+?)\*{0,2}\s*:\s*(.*)$/u)
    if (prefix) {
      const key = prefix[1].trim().toLowerCase()
      const name = names.get(key)
      // Do not attach a rejected speaker's continuation to an earlier member.
      current = undefined
      unnamed = false
      rejected = !name
      if (key === player.toLowerCase()) counts.player++
      else if (!name) counts.unknown++
      else { current = { name, text: (text.startsWith('**') ? prefix[2].replace(/^\*\*/, '') : prefix[2]).trim() }; lines.push(current) }
    } else if (current && !unnamed) current.text = `${current.text} ${text}`.trim()
    // Proven live: writing for one person, the writer often leaves off the name, and
    // dropping those replies paid for a second call. Each line is its own message.
    else if (soleSpeaker && !rejected) { current = { name: soleSpeaker, text }; unnamed = true; lines.push(current) }
    else counts.unknown++
  }
  return lines
}

export function stripStageDirections(text: string): string {
  return text.replace(/\*[^*]*\*/g, '').replace(/^\*[^*]*$|[^*]*\*$/g, '').replace(/\*[^*]*$/g, '').replace(/\s+/g, ' ').trim()
}

// Emoji sequences are kept together, including skin tones, flags and joined glyphs.
const emoji = String.raw`(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}[\uFE0E\uFE0F]?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}[\uFE0E\uFE0F]?\p{Emoji_Modifier}?)*)`
const sentenceEnd = new RegExp(String.raw`(?:[.!?…]|${emoji})(?=\s|$)(?:\s*${emoji}(?=\s|$))*`, 'gu')

export function trimReply(text: string, tokenLimited: boolean, adult: boolean): string {
  const ends = [...text.matchAll(sentenceEnd)].map(match => match.index! + match[0].length)
  let clean = tokenLimited ? text.slice(0, ends.at(-1) ?? 0).trimEnd() : text
  if (adult && Array.from(clean).length > 280) {
    const end = ends.filter(end => Array.from(text.slice(0, end)).length <= 280).at(-1)
    if (end !== undefined) return text.slice(0, end).trimEnd()
    let prefix = ''
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(clean)) {
      if (Array.from(prefix + segment).length > 280) break
      prefix += segment
    }
    // No spaces (one long token) still obeys the hard limit without splitting a glyph.
    const boundary = prefix.search(/\s+\S*$/u)
    clean = boundary >= 0 ? prefix.slice(0, boundary) : prefix
  }
  return clean
}

export const contentWords = (text: string) => new Set<string>(text.toLowerCase().match(/\p{L}{4,}/gu) || [])
/** How much of this line's wording another line already holds. */
const sharedWording = (text: string, other: string) => {
  const words = contentWords(text), held = contentWords(other)
  return words.size ? [...words].filter(word => held.has(word)).length / words.size : 0
}
// Measured on a live scene: later messages that circled earlier ones shared half or more.
const REPEATED_IDEA_SHARE = 0.5
// Proven live: an example with one clause dropped passed as new. Short lines share common words fairly.
const NEAR_COPY_SHARE = 0.8
const NEAR_COPY_WORDS = 6
const NUMBERED = /^\s*\d+[.)]\s/

/** A character's longest example lines: short ones are small talk. */
export const sceneVoiceLines = (voice: string[] = []) => [...voice].sort((a, b) => b.length - a.length).slice(0, 3)

export function filterLines(input: NamedLine[], options: {
  members: GroupMember[]; speakers: string[]; origin: GroupOrigin
  previous: NamedLine[]; openings: NamedLine[]
  thisTurn?: NamedLine[]
  blocked: (text: string) => boolean
  player?: string; onCopiedExample?: (example: string) => void
  addressed?: string; sceneMembers?: string[]; repeatedOpener?: boolean; repeatedIdea?: boolean; oneMessage?: boolean; finishReason?: string | null
  /** Everything the writer was shown; a long number from nowhere is a guess. */
  knownText?: string
  /** Words of the player's question that only someone else's private thread explains. */
  hiddenWords?: string[]
}, counts: LineCounts): NamedLine[] {
  const kept: NamedLine[] = []
  const used = new Map<string, number>()
  for (const source of input) {
    const line = { ...source }
    const member = options.members.find(member => member.name === line.name)
    if (!member || !options.speakers.includes(member.id)) { counts.off_list++; continue }
    const clean = stripStageDirections(line.text)
    if (line.text.includes('*') && clean !== line.text.trim()) counts.stage_directions++
    const withoutTag = options.player ? clean.replace(new RegExp(`^@${options.player.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])[,\\s]*`, 'iu'), '') : clean
    line.text = trimReply(withoutTag, options.finishReason === 'length' && source === input.at(-1), !!options.addressed || !!options.sceneMembers?.includes(member.id))
    if (line.text !== withoutTag) counts.trimmed++
    // Proven by replay: copying a numbered example gave "1. 2. 3.". An item with nothing in it goes.
    line.text = line.text.replace(/(?<=^|\s)\d+[.)]\s+(?=\d+[.)](\s|$))/g, '')
    if (/^\s*\d+[.)]\s*$/.test(line.text)) { counts.empty++; continue }
    // Proven live: one numbered reply in a scene made every later one a list. Dropping the numbers costs no call.
    if (options.sceneMembers?.includes(member.id) && NUMBERED.test(line.text) && NUMBERED.test(options.previous.filter(other => other.name === line.name).at(-1)?.text ?? '')) {
      line.text = line.text.replace(/(?<=^|\s)\d+[.)]\s+/g, '')
    }
    if (!line.text.trim()) { counts.empty++; continue }
    if (options.blocked(line.text)) { counts.unsafe++; continue }
    // Proven live: a writer's note to itself reached the player (its own name, then "messages will reflect
    // that"). Nobody texts their own name; a line that does is the writer talking.
    if (new RegExp(`(?<![\\p{L}\\p{N}_])${line.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu').test(line.text)) { counts.self_named++; continue }
    if (member.group.voice?.some(example => {
      const copy = normalized(stripStageDirections(example))
      // Proven live: every example joined into one message passed a whole-line comparison.
      // Proven live: retrying these copies stretched a turn to 16 s, and the copies were in voice and
      // fitted. In a scene, one of a character's longest lines may go out whole, once.
      if (copy === normalized(line.text) && options.sceneMembers?.includes(member.id) && sceneVoiceLines(member.group.voice).includes(example)
        && ![...options.previous, ...kept].some(other => other.name === line.name && normalized(stripStageDirections(other.text)) === copy)) return false
      const copied = copy === normalized(line.text) || (copy.split(/\s+/).length >= 3 && wordsOnly(line.text).includes(wordsOnly(copy)))
        // Proven live: the tail of an example, sent alone, passed as a new line.
        || (wordsOnly(line.text).split(' ').length >= 5 && wordsOnly(copy).includes(wordsOnly(line.text)))
        || (contentWords(line.text).size >= NEAR_COPY_WORDS && sharedWording(line.text, copy) >= NEAR_COPY_SHARE)
      if (copied) options.onCopiedExample?.(example)
      return copied
    })) { counts.copied_example++; continue }
    // Proven live: asked for a code nobody had told them, characters answered with one.
    // A character can only hold a long number by having been shown it.
    if (options.knownText !== undefined && (line.text.match(/\p{N}{3,}/gu) || []).some(number => !options.knownText!.includes(number))) { counts.invented_detail++; continue }
    // Proven live: asked in the group about a secret told in a direct message, characters
    // who were never told it answered anyway ("your locker code is your birthday").
    // Asking back is fine; a statement using those words is a guess, or the secret itself.
    if (options.hiddenWords?.length && !line.text.trim().endsWith('?') && [...contentWords(line.text)].some(word => options.hiddenWords!.includes(word))) { counts.hidden_guess++; continue }
    // Proven live: one stock sentence came back in four replies, each otherwise new. Removing
    // only that sentence costs no call, and the next prompt no longer shows it to copy.
    // Proven live: two characters in one scene opened on the same sentence.
    const said = new Set([...[...options.previous, ...options.openings, ...kept].filter(other => other.name === line.name), ...(options.thisTurn || []).filter(other => other.name !== line.name)].flatMap(other => sentencesOf(other.text).map(wordsOnly)))
    const sentences = sentencesOf(line.text)
    const fresh = sentences.filter(sentence => wordsOnly(sentence).split(' ').length < REPEATED_SENTENCE_WORDS || !said.has(wordsOnly(sentence)))
    // Proven on a saved scene: with most of a line gone, what's left is a scrap ("That feels
    // amazing."). A mostly repeated line is a repeat, and the writer tries again.
    const wordCount = (texts: string[]) => wordsOnly(texts.join(' ')).split(' ').filter(Boolean).length
    if (wordCount(fresh) < wordCount(sentences) / 2) { counts.duplicate++; continue }
    if (fresh.length < sentences.length) { line.text = fresh.join(' '); counts.repeated_sentence++ }
    const previous = options.previous.filter(other => other.name === line.name).slice(-5)
    // A short reaction can fairly recur; a full sentence copied from further back can't.
    const looksBack = line.text.trim().split(/\s+/).length >= 4 ? options.previous.filter(other => other.name === line.name) : previous
    const duplicates = [...looksBack, ...options.openings.filter(other => other.name === line.name), ...kept.filter(other => other.name === line.name)]
    // Proven live: the same reply with its punctuation moved passed as new.
    if (duplicates.some(other => normalized(other.text) === normalized(line.text) || (wordsOnly(line.text).split(' ').length >= REPEATED_SENTENCE_WORDS && wordsOnly(other.text) === wordsOnly(line.text)))) { counts.duplicate++; continue }
    const firstWords = opener(line.text)
    // Within one reply only. Proven live: against earlier turns this removed explicit
    // lines, which tend to open the same way, and once emptied a reply.
    if (options.repeatedOpener && member.id === options.addressed && firstWords !== undefined
      && kept.filter(other => other.name === line.name).some(other => opener(other.text) === firstWords)) { counts.repeated_opener++; continue }
    // The first message stands, so a line asking to hear something again still gets it.
    if (options.repeatedIdea && member.id === options.addressed && kept.some(other => other.name === line.name) &&
      options.previous.filter(other => other.name === line.name).some(other => sharedWording(line.text, other.text) >= REPEATED_IDEA_SHARE)) { counts.repeated_idea++; continue }
    if ((used.get(line.name) ?? 0) >= (options.oneMessage ? 1 : member.id === options.addressed || options.sceneMembers?.includes(member.id) ? 3 : 2) || (options.origin === 'catchup' && kept.length >= 4)) { counts.over_cap++; continue }
    used.set(line.name, (used.get(line.name) ?? 0) + 1)
    kept.push(line)
  }
  return kept
}

export function timeLines(lines: NamedLine[], members: GroupMember[], now: Date, gapStart?: Date,
  rng: () => number = Math.random): GroupLine[] {
  let at = now.getTime()
  return lines.map((line, index) => {
    if (gapStart && gapStart < now) at = gapStart.getTime() + (now.getTime() - gapStart.getTime()) * (index + 1) / (lines.length + 1)
    else if (index) at += 1500 + Math.floor(rng() * 2501)
    return { character_id: members.find(member => member.name === line.name)!.id, text: line.text, shown_at: new Date(at) }
  })
}
