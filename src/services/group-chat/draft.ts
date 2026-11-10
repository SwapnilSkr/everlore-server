import { callLLM } from '../../ai/client'
import { AI_MODELS } from '../../ai/models'
import type { WorldTemplateDoc } from '../../models/world-template.model'
import { HttpError } from '../../utils/http-error'
import { log } from '../../utils/logger'
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
  acquaintance: 'they have just met you',
  friend: 'they are a friend of yours',
  unrequited_attraction: 'they have a crush on you',
  rival: 'they are a rival of yours',
}

const PERIODS = ['morning', 'afternoon', 'evening', 'night'] as const

/** A shape failure is redrafted once; a second one fails the draft. Its reason
 * is a fixed code, so a failed draft can be read in the log without any of the
 * player's words or the model's reply. */
class ShapeFailure extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

function shape(reason: string): never {
  throw new ShapeFailure(reason)
}

type DraftFailureStage = 'group_shape' | 'person_shape' | 'validate' | 'gate'

function failed(stage: DraftFailureStage, details: Record<string, unknown> = {}): never {
  log.warn('group_draft.failed', { stage, ...details })
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

/**
 * Drafted fields are read and edited by the person making the group, so they
 * address that person as "you". The prompts ask for it; this catches whatever
 * is left. It rewrites one term this code introduced, never a list that judges
 * a player's own words.
 */
export function speakToReader(text: string): string {
  return text.replace(
    /(?<![\p{L}\p{N}_])the[ \t]+player(?:['’]s(?![\p{L}\p{N}_])|(?:[ \t]+(is|was|has))(?![\p{L}\p{N}_]))?(?![\p{L}\p{N}_])/giu,
    (match: string, verb?: string) => {
      const word = verb?.toLowerCase()
      const base = /['’]s$/i.test(match) ? 'your'
        : word === 'is' ? 'you are'
          : word === 'was' ? 'you were'
            : word === 'has' ? 'you have'
              : 'you'
      const initial = match.charAt(0)
      const capitalised = initial === initial.toUpperCase() && initial !== initial.toLowerCase()
      return capitalised ? base.charAt(0).toUpperCase() + base.slice(1) : base
    },
  )
}

const SAMEY_OPENING_WORDS = 3

/** A line as the clash check reads it: lowercase letters, digits and single spaces. */
function normaliseSameyLine(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

/** A line's opening: its first three words. */
function sameyOpening(normalised: string): string {
  return normalised.split(' ').slice(0, SAMEY_OPENING_WORDS).join(' ')
}

/** How many of each person's explicit lines repeat an earlier line's text or opening. */
function sameyCounts(explicitByPerson: string[][]): number[] {
  const texts = new Set<string>()
  const openings = new Set<string>()
  return explicitByPerson.map((lines) => {
    let clashes = 0
    for (const text of lines) {
      const normalised = normaliseSameyLine(text)
      const opening = sameyOpening(normalised)
      if (texts.has(normalised) || openings.has(opening)) clashes++
      texts.add(normalised)
      openings.add(opening)
    }
    return clashes
  })
}

/** The people whose explicit lines repeat an earlier line's text or opening. */
export function sameyPeople(explicitByPerson: string[][]): Set<number> {
  const people = new Set<number>()
  sameyCounts(explicitByPerson).forEach((clashes, index) => {
    if (clashes > 0) people.add(index)
  })
  return people
}

export const GROUP_DRAFT_PROMPT = [
  'You write the shared part of a fictional group chat for an adult roleplay app. The person who reads and edits it is a member of the group.',
  'Return ONLY a JSON object (no markdown, no prose) with EXACTLY these keys:',
  '{',
  '"description": the group as it appears in the app, one short paragraph (max 600 characters),',
  '"global_lore": the shared history, place and situation every member knows, one or more paragraphs (max 3000 characters),',
  '"seed_prompt": the premise the chat runs on — who these people are, where they are and what you are doing there, in second person (10–2500 characters),',
  '"topics": EXACTLY 10 things this group would talk about, each a short sentence (max 1000 characters),',
  '"opening_lines": 3 to 6 lines of a short conversation you walk in on, each {"name": one of the people, "text": one line (max 1000 characters)}',
  '}',
  'Use only the people you are given, by the exact names given. Write each opening line in that person\'s own voice; never name the speaker inside the line.',
  'The only names you return are the speakers of the opening lines. Do not return an age, a starting bond, an id, a place, a flag or an asset key; the server sets those.',
  'Write every field to the person who will read and edit it: call them "you"; never write about them in the third person.',
  'Stay within every character limit. Be specific and lively, not generic.',
].join('\n')

/** An explicit line's shared rule, so both the person call and a re-ask say the same. */
const EXPLICIT_LINE_RULE = 'For each explicit line: in their own voice, name a sex act. Talk about their own body and your mouth, hands and fingers. Never assume anything about your body. Write the line as something they say, not as narration.'

/** The person prompt states the authoring rule only for an adult group. */
export function personDraftPrompt(adult: boolean): string {
  const lines = [
    'You write ONE member of a fictional group chat for an adult roleplay app. The person who reads and edits it is a member of the group.',
    'Return ONLY a JSON object (no markdown, no prose) with EXACTLY these keys:',
    '{',
    '"role": who they are in the group and in the world, one line (max 400 characters),',
    '"appearance": their look, built from the look you are given, opening with their age from the form in digits, e.g. "27, ..." (max 1000 characters),',
    '"persona": how they think, talk and treat you, one paragraph (max 2500 characters),',
    '"speech": how they write in a group chat — sentence length, punctuation, emoji or none (max 2000 characters),',
    '"wants": what they want from the group and from you (max 2500 characters),',
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
    '"first_texts": EXACTLY 3 first messages they might send you privately, each one line (max 120 characters),',
    '"statuses": exactly {"morning": …, "afternoon": …, "evening": …, "night": …}, one short line for each part of your day (max 120 characters each),',
    '"talkativeness": a number from 0 to 1 for how often they speak in the group,',
    '}',
  )
  if (adult) lines.push(EXPLICIT_LINE_RULE)
  lines.push(
    'The member you are writing is always in the third person, by name or "they", in "role", "appearance", "persona", "speech", "wants" and "intimacy"; those fields never say "I" or "me". The person who reads and edits the draft is always "you" in those fields, and is never the member.',
    '"persona" and "wants" each begin with the member\'s exact name. "first_texts", "statuses" and every voice line are in the member\'s own voice: "I" is the member and "you" is the reader.',
    'A voice line never names its own speaker. Do not return a name, an age, a starting bond or an id; the server sets those.',
    'Stay within every character limit. Keep every written line on a single line.',
  )
  return lines.join('\n')
}

function readGroupWords(parsed: unknown, form: GroupDraftInput): GroupWords {
  if (!isRecord(parsed)) shape('parse')
  const description = prose(parsed.description, 600)
  const global_lore = prose(parsed.global_lore, 3000)
  const seed_prompt = prose(parsed.seed_prompt, 2500)
  if (!description || !global_lore || !seed_prompt || Array.from(seed_prompt).length < 10) shape('group_prose')

  const rawTopics = parsed.topics
  if (!Array.isArray(rawTopics) || rawTopics.length !== 10) shape('group_topics')
  const topics = rawTopics.map((topic) => line(topic, 1000))
  if (topics.some((topic) => topic === null)) shape('group_topics')

  const rawOpening = parsed.opening_lines
  if (!Array.isArray(rawOpening)) shape('group_opening_lines')
  const peopleByName = new Map(form.people.map((person) => [person.name.trim().toLowerCase(), person.name]))
  const opening: NamedLine[] = []
  for (const entry of rawOpening) {
    if (!isRecord(entry)) shape('group_opening_lines')
    const name = typeof entry.name === 'string' ? peopleByName.get(entry.name.trim().toLowerCase()) : undefined
    // A line for someone outside the group is not this group's conversation.
    if (name === undefined) continue
    const text = line(entry.text, 1000)
    if (text === null) shape('group_opening_lines')
    opening.push({ name, text })
  }
  if (opening.length < 3 || opening.length > 6) shape('group_opening_count')

  return {
    description: speakToReader(description!),
    global_lore: speakToReader(global_lore!),
    seed_prompt: speakToReader(seed_prompt!),
    topics: (topics as string[]).map(speakToReader),
    opening_lines: opening.map(({ name, text }) => ({ name, text: speakToReader(text) })),
  }
}

function readPersonWords(
  parsed: unknown,
  form: GroupDraftInput,
  person: GroupDraftPerson,
  thirdPerson = true,
): PersonWords {
  if (!isRecord(parsed)) shape('parse')
  const role = prose(parsed.role, 400)
  const appearance = prose(parsed.appearance, 1000)
  const persona = prose(parsed.persona, 2500)
  const speech = prose(parsed.speech, 2000)
  const wants = prose(parsed.wants, 2500)
  if (!role || !appearance || !persona || !speech || !wants) shape('person_prose')

  // The look opens with the age the form set, in digits: a different number is
  // a shape miss and is redrafted once, never rewritten here.
  const ageDigits = /^(\d+)(?!\d)/.exec(appearance)
  if (!ageDigits || Number(ageDigits[1]) !== person.age) shape('person_appearance_age')

  // Intimacy is only part of an adult group: a non-adult draft drops it even
  // when the model returns it.
  const intimacy = form.adult ? prose(parsed.intimacy) : undefined
  if (form.adult && !intimacy) shape('person_intimacy')

  const rawFirst = parsed.first_texts
  if (!Array.isArray(rawFirst) || rawFirst.length !== 3) shape('person_first_texts')
  const first_texts = rawFirst.map((text) => line(text, 120))
  if (first_texts.some((text) => text === null)) shape('person_first_texts')

  const rawStatuses = parsed.statuses
  if (!isRecord(rawStatuses)) shape('person_statuses')
  if (Object.keys(rawStatuses).sort().join(',') !== [...PERIODS].sort().join(',')) shape('person_statuses')
  const statuses = {} as GroupStatusLines
  for (const period of PERIODS) {
    const text = line(rawStatuses[period], 120)
    if (text === null) shape('person_statuses')
    statuses[period] = speakToReader(text!)
  }

  const rawTalk = parsed.talkativeness
  const talkativeness =
    typeof rawTalk === 'number' && Number.isFinite(rawTalk)
      ? Math.min(1, Math.max(0, rawTalk))
      : 0.5

  const rawVoice = parsed.voice
  if (!isRecord(rawVoice)) shape('person_voice')
  const rawPlain = rawVoice.plain
  if (!Array.isArray(rawPlain) || rawPlain.length < 2 || rawPlain.length > 4) shape('person_voice_count')
  const plainRead = rawPlain.map((text) => line(text))
  if (plainRead.some((text) => text === null)) shape('person_voice_text')
  const plain = (plainRead as string[]).map(speakToReader)

  let explicit: string[] = []
  if (form.adult) {
    const rawExplicit = rawVoice.explicit
    if (!Array.isArray(rawExplicit) || rawExplicit.length !== 3) shape('person_voice_count')
    const lines = rawExplicit.map((text) => line(text))
    if (lines.some((text) => text === null)) shape('person_voice_text')
    explicit = (lines as string[]).map(speakToReader)
  }

  for (const text of [...plain, ...explicit]) {
    if (namesSelf(text, person.name)) shape('person_voice_names_self')
  }

  // A person's notes are about them, never written to them: the reader is "you",
  // so a note addressed to the person would be read as a note about the player.
  // The prompt asks for the name first; this is what holds it.
  const spokenPersona = speakToReader(persona!)
  const spokenWants = speakToReader(wants!)
  if (thirdPerson && (!spokenPersona.startsWith(person.name) || !spokenWants.startsWith(person.name))) {
    shape('person_third_person')
  }

  return {
    role: speakToReader(role!),
    appearance: speakToReader(appearance!),
    persona: spokenPersona,
    speech: speakToReader(speech!),
    wants: spokenWants,
    intimacy: intimacy ? speakToReader(intimacy) : undefined,
    first_texts: (first_texts as string[]).map(speakToReader),
    statuses,
    talkativeness,
    plain,
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
      log.warn('group_draft.shape_miss', { call: 'group', attempt: attempt + 1, reason: error.reason })
    }
  }
  return failed('group_shape')
}

async function draftPersonWords(
  form: GroupDraftInput,
  person: GroupDraftPerson,
  group: GroupWords,
  attempts: number,
): Promise<PersonWords> {
  const personIndex = form.people.indexOf(person)
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
      // A person's notes in the wrong voice are still usable on the last
      // attempt: the draft is whole otherwise. Nothing else is let through.
      if (error.reason === 'person_third_person' && attempt === attempts - 1) {
        log.warn('group_draft.third_person_left', { person: personIndex })
        return readPersonWords(parsed, form, person, false)
      }
      log.warn('group_draft.shape_miss', { call: 'person', person: personIndex, attempt: attempt + 1, reason: error.reason })
    }
  }
  return failed('person_shape', { person: personIndex })
}

/** One more call for a person whose explicit lines repeat an earlier line. */
const EXPLICIT_REDRAFT_PROMPT = [
  'You rewrite the explicit lines of ONE member of a fictional group chat for an adult roleplay app.',
  'Return ONLY a JSON object (no markdown, no prose) with EXACTLY this key:',
  '{"explicit": EXACTLY 3 explicit lines in that person\'s own voice}',
  EXPLICIT_LINE_RULE,
  'Each line is new: it repeats none of the openings in "taken_openings", and the three lines you return do not repeat each other.',
  'A line never names its own speaker. In each line "I" is this member and "you" is the reader.',
  'Stay within every character limit. Keep every written line on a single line.',
].join('\n')

/** A re-ask's lines pass the same line checks as a person call's. */
function readExplicitLines(parsed: unknown, person: GroupDraftPerson): string[] | null {
  if (!isRecord(parsed)) return null
  const raw = parsed.explicit
  if (!Array.isArray(raw) || raw.length !== 3) return null
  const lines = raw.map((text) => line(text))
  if (lines.some((text) => text === null)) return null
  const spoken = (lines as string[]).map(speakToReader)
  if (spoken.some((text) => namesSelf(text, person.name))) return null
  return spoken
}

/** Asks once for three new explicit lines. A failure keeps the drafted ones. */
async function draftSameyExplicitLines(
  form: GroupDraftInput,
  person: GroupDraftPerson,
  group: GroupWords,
  takenOpenings: string[],
): Promise<string[] | null> {
  let answer: unknown
  try {
    answer = await draftEffects.call({
      model: AI_MODELS.authoring,
      temperature: 0.9,
      maxTokens: 600,
      responseFormat: { type: 'json_object' },
      purpose: 'group_draft_person',
      messages: [
        { role: 'system', content: EXPLICIT_REDRAFT_PROMPT },
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
            taken_openings: takenOpenings,
          }),
        },
      ],
    })
  } catch {
    return null
  }
  return readExplicitLines(parseJson(answer), person)
}

async function replaceSameyExplicitLines(
  form: GroupDraftInput,
  group: GroupWords,
  people: PersonWords[],
): Promise<void> {
  if (!form.adult) return
  const explicit = people.map((person) => person.explicit)
  const before = sameyCounts(explicit)
  const reasked = before.flatMap((clashes, index) => (clashes > 0 ? [index] : []))
  if (!reasked.length) return

  // Only the people who keep their lines limit what a re-ask may open with.
  const asked = new Set(reasked)
  const taken = new Set<string>()
  explicit.forEach((lines, index) => {
    if (asked.has(index)) return
    for (const text of lines) taken.add(sameyOpening(normaliseSameyLine(text)))
  })

  const replacements = await Promise.all(reasked.map(async (index) => {
    const lines = await draftSameyExplicitLines(form, form.people[index]!, group, [...taken])
    if (!lines) return undefined
    const candidate = explicit.map((entry, at) => (at === index ? lines : entry))
    const after = sameyCounts(candidate)[index]!
    return after < before[index]! ? lines : undefined
  }))

  replacements.forEach((lines, at) => {
    if (lines) people[reasked[at]!]!.explicit = lines
  })

  const left = sameyCounts(people.map((person) => person.explicit)).reduce((sum, count) => sum + count, 0)
  if (left > 0) log.warn('group_draft.samey_left', { count: left })
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

async function gate(draft: GroupDraft, playerId: string): Promise<{ ok: true } | { ok: false; paths: string[] }> {
  try {
    validateGroup(draft as unknown as WorldTemplateDoc)
  } catch (error) {
    // Every validateGroup message is a fixed sentence written here, naming a
    // field at most: none carries a player value or a model reply.
    failed('validate', { message: (error as Error).message })
  }
  return checkGroupText(groupTextLines(draft as unknown as Partial<WorldTemplateDoc>), { playerId })
}

export async function draftGroup(form: GroupDraftInput, playerId: string): Promise<GroupDraft> {
  let group = await draftGroupWords(form, MAX_ATTEMPTS)
  const people = await Promise.all(
    form.people.map((person) => draftPersonWords(form, person, group, MAX_ATTEMPTS)),
  )
  // Before the first gate, so a replaced line is gated like any other.
  await replaceSameyExplicitLines(form, group, people)

  let draft = assemble(form, group, people)
  let verdict = await gate(draft, playerId)
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
  verdict = await gate(draft, playerId)
  if (!verdict.ok) failed('gate', { paths: verdict.paths })
  return draft
}
