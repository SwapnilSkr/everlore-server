import { callLLM } from '../../ai/client'
import { AI_MODELS } from '../../ai/models'
import type { WorldTemplateDoc } from '../../models/world-template.model'
import { HttpError } from '../../utils/http-error'
import type { RelationshipInitializationKind } from '../../utils/relationship-baseline'
import { checkGroupText, groupTextLines } from './text-gate'
import type { GroupStatusLines, GroupTraits, NamedLine } from './types'
import { validateGroup } from './validation'

/**
 * Drafts a whole group from the player's form.
 *
 * The model only ever writes words. Every structural field — a person's name,
 * age and starting bond, the template kind, the identity kind, the aliases and
 * the voice split — is minted here from the form, so nothing the model returns
 * can name a world, an id or a relationship. The assembled draft is then put
 * through the same shape rules the authored catalog obeys (`validateGroup`)
 * and the same text gate every saved group passes.
 *
 * Two calls are drafted at a time: one for the group, then one per person in
 * parallel. A shape failure redrafts that call once. A gate refusal redrafts
 * the refused person — or the group, for a group-level path — once. Anything
 * still failing fails the whole draft with one plain sentence.
 */

export const draftEffects = { call: callLLM }

const FAILED_MESSAGE = "We couldn't write this group. Try changing the descriptions."
const MAX_ATTEMPTS = 2

type Closeness = 'acquaintance' | 'friend' | 'unrequited_attraction' | 'rival'

export interface GroupDraftPerson {
  name: string
  age: number
  look: string
  personality: string
  knows_player: string
  closeness: Closeness
}

export interface GroupDraftInput {
  title: string
  setting: string
  adult: boolean
  people: GroupDraftPerson[]
}

export interface GroupDraftCastMember {
  name: string
  role: string
  appearance: string
  persona: string
  identity_kind: 'human'
  aliases: []
  first_texts: string[]
  statuses: GroupStatusLines
  group: GroupTraits
}

/** A body `POST /templates/` accepts unchanged when `kind` is `group`. */
export interface GroupDraft {
  title: string
  description: string
  kind: 'group'
  is_sentient: false
  is_nsfw_capable: boolean
  seed_prompt: string
  global_lore: string
  topics: string[]
  opening_lines: NamedLine[]
  seed_cast: GroupDraftCastMember[]
}

interface GroupWords {
  description: string
  global_lore: string
  seed_prompt: string
  topics: string[]
  opening_lines: NamedLine[]
}

interface PersonWords {
  role: string
  appearance: string
  persona: string
  speech: string
  wants: string
  intimacy: string | undefined
  first_texts: string[]
  statuses: GroupStatusLines
  talkativeness: number
  plain: string[]
  explicit: string[]
}

/** How each authored bond reads to a writer, without exposing the key. */
const CLOSENESS_WORDS: Record<Closeness, string> = {
  acquaintance: 'they have just met the player',
  friend: 'they are a friend of the player',
  unrequited_attraction: 'they have a crush on the player',
  rival: 'they are a rival of the player',
}

const PERIODS = ['morning', 'afternoon', 'evening', 'night'] as const

/** A shape failure is redrafted once; a second one fails the draft. */
class ShapeFailure extends Error {}

function shape(): never {
  throw new ShapeFailure()
}

function failed(): never {
  throw new HttpError(422, FAILED_MESSAGE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return undefined
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1]!.trim()
  if (!text.startsWith('{')) {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) text = text.slice(start, end + 1)
  }
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** A prose field: non-empty once trimmed, with an optional storage cap. */
function prose(value: unknown, max?: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  if (max !== undefined && Array.from(text).length > max) return null
  return text
}

/** A written line: non-empty, one line, with an optional cap. */
function line(value: unknown, max?: number): string | null {
  if (typeof value !== 'string') return null
  if (/[\r\n]/u.test(value)) return null
  const text = value.trim()
  if (!text) return null
  if (max !== undefined && Array.from(text).length > max) return null
  return text
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The rule the authored data check applies: a voice line never names itself. */
function namesSelf(text: string, name: string): boolean {
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`,
    'iu',
  ).test(text)
}

export const GROUP_DRAFT_PROMPT = [
  'You write the shared part of a fictional group chat for an adult roleplay app. The player is a member of the group.',
  'Return ONLY a JSON object (no markdown, no prose) with EXACTLY these keys:',
  '{',
  '"description": the group as it appears in the app, one short paragraph (max 600 characters),',
  '"global_lore": the shared history, place and situation every member knows, one or more paragraphs (max 3000 characters),',
  '"seed_prompt": the premise the chat runs on — who these people are, where they are and what the player is doing there, in second person (10–2500 characters),',
  '"topics": EXACTLY 10 things this group would talk about, each a short sentence (max 1000 characters),',
  '"opening_lines": 3 to 6 lines of a short conversation the player walks in on, each {"name": one of the people, "text": one line (max 1000 characters)}',
  '}',
  'Use only the people you are given, by the exact names given. Write each opening line in that person\'s own voice; never name the speaker inside the line.',
  'The only names you return are the speakers of the opening lines. Do not return an age, a starting bond, an id, a place, a flag or an asset key; the server sets those.',
  'Stay within every character limit. Be specific and lively, not generic.',
].join('\n')

/** The person prompt states the authoring rule only for an adult group. */
export function personDraftPrompt(adult: boolean): string {
  const lines = [
    'You write ONE member of a fictional group chat for an adult roleplay app. The player is a member of the group.',
    'Return ONLY a JSON object (no markdown, no prose) with EXACTLY these keys:',
    '{',
    '"role": who they are in the group and in the world, one line (max 400 characters),',
    '"appearance": their look, built from the look you are given, opening with their age from the form in digits, e.g. "27, ..." (max 1000 characters),',
    '"persona": how they think, talk and treat the player, one paragraph (max 2500 characters),',
    '"speech": how they write in a group chat — sentence length, punctuation, emoji or none (max 2000 characters),',
    '"wants": what they want from the group and from the player (max 2500 characters),',
  ]
  if (adult) {
    lines.push(
      '"intimacy": how they are in private, in their own voice, direct and unembarrassed,',
      '"voice": an object with "plain" (2 to 4 everyday lines they would say in the chat) and "explicit" (EXACTLY 3 explicit lines),',
    )
  } else {
    lines.push('"voice": an object with "plain" (2 to 4 everyday lines they would say in the chat),')
  }
  lines.push(
    '"first_texts": EXACTLY 3 first messages they might send the player privately, each one line (max 120 characters),',
    '"statuses": exactly {"morning": …, "afternoon": …, "evening": …, "night": …}, one short line for each part of the player\'s day (max 120 characters each),',
    '"talkativeness": a number from 0 to 1 for how often they speak in the group,',
    '}',
  )
  if (adult) {
    lines.push(
      'For each explicit line: in their own voice, name a sex act. Talk about their own body and the player\'s mouth, hands and fingers. Never assume anything about the player\'s body. Write the line as something they say, not as narration.',
    )
  }
  lines.push(
    'A voice line never names its own speaker. Do not return a name, an age, a starting bond or an id; the server sets those.',
    'Stay within every character limit. Keep every written line on a single line.',
  )
  return lines.join('\n')
}

function readGroupWords(parsed: unknown, form: GroupDraftInput): GroupWords {
  if (!isRecord(parsed)) shape()
  const description = prose(parsed.description, 600)
  const global_lore = prose(parsed.global_lore, 3000)
  const seed_prompt = prose(parsed.seed_prompt, 2500)
  if (!description || !global_lore || !seed_prompt || Array.from(seed_prompt).length < 10) shape()

  const rawTopics = parsed.topics
  if (!Array.isArray(rawTopics) || rawTopics.length !== 10) shape()
  const topics = rawTopics.map((topic) => line(topic, 1000))
  if (topics.some((topic) => topic === null)) shape()

  const rawOpening = parsed.opening_lines
  if (!Array.isArray(rawOpening)) shape()
  const peopleByName = new Map(form.people.map((person) => [person.name.trim().toLowerCase(), person.name]))
  const opening: NamedLine[] = []
  for (const entry of rawOpening) {
    if (!isRecord(entry)) shape()
    const name = typeof entry.name === 'string' ? peopleByName.get(entry.name.trim().toLowerCase()) : undefined
    // A line for someone outside the group is not this group's conversation.
    if (name === undefined) continue
    const text = line(entry.text, 1000)
    if (text === null) shape()
    opening.push({ name, text })
  }
  if (opening.length < 3 || opening.length > 6) shape()

  return {
    description: description!,
    global_lore: global_lore!,
    seed_prompt: seed_prompt!,
    topics: topics as string[],
    opening_lines: opening,
  }
}

function readPersonWords(parsed: unknown, form: GroupDraftInput, person: GroupDraftPerson): PersonWords {
  if (!isRecord(parsed)) shape()
  const role = prose(parsed.role, 400)
  const appearance = prose(parsed.appearance, 1000)
  const persona = prose(parsed.persona, 2500)
  const speech = prose(parsed.speech, 2000)
  const wants = prose(parsed.wants, 2500)
  if (!role || !appearance || !persona || !speech || !wants) shape()

  // The look opens with the age the form set, in digits: a different number is
  // a shape miss and is redrafted once, never rewritten here.
  const ageDigits = /^(\d+)(?!\d)/.exec(appearance)
  if (!ageDigits || Number(ageDigits[1]) !== person.age) shape()

  // Intimacy is only part of an adult group: a non-adult draft drops it even
  // when the model returns it.
  const intimacy = form.adult ? prose(parsed.intimacy) : undefined
  if (form.adult && !intimacy) shape()

  const rawFirst = parsed.first_texts
  if (!Array.isArray(rawFirst) || rawFirst.length !== 3) shape()
  const first_texts = rawFirst.map((text) => line(text, 120))
  if (first_texts.some((text) => text === null)) shape()

  const rawStatuses = parsed.statuses
  if (!isRecord(rawStatuses)) shape()
  if (Object.keys(rawStatuses).sort().join(',') !== [...PERIODS].sort().join(',')) shape()
  const statuses = {} as GroupStatusLines
  for (const period of PERIODS) {
    const text = line(rawStatuses[period], 120)
    if (text === null) shape()
    statuses[period] = text!
  }

  const rawTalk = parsed.talkativeness
  const talkativeness =
    typeof rawTalk === 'number' && Number.isFinite(rawTalk)
      ? Math.min(1, Math.max(0, rawTalk))
      : 0.5

  const rawVoice = parsed.voice
  if (!isRecord(rawVoice)) shape()
  const rawPlain = rawVoice.plain
  if (!Array.isArray(rawPlain) || rawPlain.length < 2 || rawPlain.length > 4) shape()
  const plain = rawPlain.map((text) => line(text))
  if (plain.some((text) => text === null)) shape()

  let explicit: string[] = []
  if (form.adult) {
    const rawExplicit = rawVoice.explicit
    if (!Array.isArray(rawExplicit) || rawExplicit.length !== 3) shape()
    const lines = rawExplicit.map((text) => line(text))
    if (lines.some((text) => text === null)) shape()
    explicit = lines as string[]
  }

  for (const text of [...(plain as string[]), ...explicit]) {
    if (namesSelf(text, person.name)) shape()
  }

  return {
    role: role!,
    appearance: appearance!,
    persona: persona!,
    speech: speech!,
    wants: wants!,
    intimacy: intimacy ?? undefined,
    first_texts: first_texts as string[],
    statuses,
    talkativeness,
    plain: plain as string[],
    explicit,
  }
}

async function readCall(request: Parameters<typeof callLLM>[0]): Promise<unknown> {
  let answer: unknown
  try {
    answer = await draftEffects.call(request)
  } catch {
    // A provider failure is an outage, never the player's words: say so and let
    // them try again. No redraft: the retry would spend another paid call on the
    // same failure.
    throw new HttpError(503, 'Try again in a moment.')
  }
  // A reply that does not parse is a shape miss, redrafted like any other.
  return parseJson(answer)
}

async function draftGroupWords(form: GroupDraftInput, attempts: number): Promise<GroupWords> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const parsed = await readCall({
      model: AI_MODELS.authoring,
      temperature: 0.9,
      maxTokens: 2000,
      responseFormat: { type: 'json_object' },
      purpose: 'group_draft',
      messages: [
        { role: 'system', content: GROUP_DRAFT_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            title: form.title,
            setting: form.setting,
            people: form.people.map((person) => ({
              name: person.name,
              age: person.age,
              personality: person.personality,
              knows_player: person.knows_player,
            })),
          }),
        },
      ],
    })
    try {
      return readGroupWords(parsed, form)
    } catch (error) {
      if (!(error instanceof ShapeFailure)) throw error
    }
  }
  return failed()
}

async function draftPersonWords(
  form: GroupDraftInput,
  person: GroupDraftPerson,
  group: GroupWords,
  attempts: number,
): Promise<PersonWords> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const parsed = await readCall({
      model: AI_MODELS.authoring,
      temperature: 0.9,
      maxTokens: 1500,
      responseFormat: { type: 'json_object' },
      purpose: 'group_draft_person',
      messages: [
        { role: 'system', content: personDraftPrompt(form.adult) },
        {
          role: 'user',
          content: JSON.stringify({
            group: { title: form.title, setting: form.setting, global_lore: group.global_lore },
            person: {
              name: person.name,
              age: person.age,
              look: person.look,
              personality: person.personality,
              knows_player: person.knows_player,
              closeness: CLOSENESS_WORDS[person.closeness],
            },
            others: form.people
              .filter((other) => other !== person)
              .map((other) => ({ name: other.name, personality: other.personality })),
          }),
        },
      ],
    })
    try {
      return readPersonWords(parsed, form, person)
    } catch (error) {
      if (!(error instanceof ShapeFailure)) throw error
    }
  }
  return failed()
}

function assemble(form: GroupDraftInput, group: GroupWords, people: PersonWords[]): GroupDraft {
  return {
    title: form.title,
    description: group.description,
    kind: 'group',
    is_sentient: false,
    is_nsfw_capable: form.adult,
    seed_prompt: group.seed_prompt,
    global_lore: group.global_lore,
    topics: [...group.topics],
    opening_lines: group.opening_lines.map((opening) => ({ name: opening.name, text: opening.text })),
    // Every field below is minted from the form; nothing the model returned for
    // a name, an age, a bond or an id is read.
    seed_cast: form.people.map((person, index) => {
      const words = people[index]!
      const voice = [...words.plain, ...(form.adult ? words.explicit : [])]
      return {
        name: person.name,
        role: words.role,
        appearance: words.appearance,
        persona: words.persona,
        identity_kind: 'human',
        aliases: [],
        first_texts: [...words.first_texts],
        statuses: { ...words.statuses },
        group: {
          age: person.age,
          talkativeness: words.talkativeness,
          speech: words.speech,
          wants: words.wants,
          start_bond: person.closeness as RelationshipInitializationKind,
          ...(form.adult ? { intimacy: words.intimacy! } : {}),
          voice,
        },
      }
    }),
  }
}

/** `seed_cast.<i>.…` is a person's line; everything else is the group's. */
function refusedPerson(path: string): number | null {
  const match = /^seed_cast\.(\d+)(?:\.|$)/.exec(path)
  return match ? Number(match[1]) : null
}

async function gate(draft: GroupDraft): Promise<{ ok: true } | { ok: false; paths: string[] }> {
  try {
    validateGroup(draft as unknown as WorldTemplateDoc)
  } catch {
    failed()
  }
  return checkGroupText(groupTextLines(draft as unknown as Partial<WorldTemplateDoc>))
}

export async function draftGroup(form: GroupDraftInput): Promise<GroupDraft> {
  let group = await draftGroupWords(form, MAX_ATTEMPTS)
  const people = await Promise.all(
    form.people.map((person) => draftPersonWords(form, person, group, MAX_ATTEMPTS)),
  )

  let draft = assemble(form, group, people)
  let verdict = await gate(draft)
  if (verdict.ok) return draft

  const refused = new Set(
    verdict.paths.map(refusedPerson).filter((index): index is number => index !== null),
  )
  const groupRefused = verdict.paths.some((path) => refusedPerson(path) === null)

  // One more call per refused side, never a second round: still refused, the
  // draft fails. The group's new words are what any redrafted person sees.
  if (groupRefused) group = await draftGroupWords(form, 1)
  if (refused.size > 0) {
    const replacements = await Promise.all(
      form.people.map((person, index) =>
        refused.has(index) ? draftPersonWords(form, person, group, 1) : Promise.resolve(people[index]!),
      ),
    )
    people.splice(0, people.length, ...replacements)
  }

  draft = assemble(form, group, people)
  verdict = await gate(draft)
  if (!verdict.ok) failed()
  return draft
}
