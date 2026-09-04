/**
 * Two-phase travel against map identity — intent vs arrival.
 *
 * The citation stack only moves when LLM namers name a new place. They are told
 * to hold the prior cursor, so "*We return to the inn*" stays on the muddy yard
 * and "*I leave for my room*" never leaves the council chamber. Presence already
 * drops; the cursor does not.
 *
 * This module does not replace that stack. It answers a different question from
 * the player's own words + the map:
 *
 *   1. Intent ("let's head to the tavern") — store a pending destination ID.
 *      Do not move. Do not summon anyone from there.
 *   2. Arrival ("we return to the inn") — move only to a resolved known place
 *      (or the pending ID), never mint a bare generic.
 *   3. Owned leave ("I leave for my room") — resolve to "<player>'s room" as a
 *      sibling of the current room and move this turn.
 *
 * Bare generics ("the yard") still cannot become "the steward's yard". Two inns
 * with no person/pending to disambiguate abstain rather than guess.
 */

import {
  isBareGenericPlaceLabel,
  isVagueLocationLabel,
  normalizeLocationName,
  placesAreTheSameLocation,
  significantLocationTokens,
} from '../../src/utils/location-identity'
import { playerTextMarksIntent, playerTextSituatesViewpoint } from './location-citation'
import { extractExplicitPhysicalDestination } from './movement-signal'

export interface KnownPlaceRef {
  name: string
  aliases?: string[]
  entityId?: string | null
  lastSeenSequence?: number
  /** How many scenes this name has been the cursor. Transit hallways are 1. */
  mentionCount?: number
  /** Immediate container. Siblings under one building/settlement are local. */
  parentId?: string | null
  /** `building` | `settlement` | `region` | `world` | … */
  placeKind?: string | null
}

export interface PersonPlaceRef {
  name: string
  aliases?: string[]
  placeName: string | null
  placeEntityId?: string | null
}

export interface PendingDestination {
  name: string
  entityId?: string | null
  aliases?: string[]
}

export type TravelKind = 'none' | 'intent' | 'arrival' | 'owned_leave'

export interface TravelIntentInput {
  playerInput: string
  isContinuation: boolean
  cursorName: string | null
  cursorEntityId?: string | null
  knownPlaces: KnownPlaceRef[]
  personPlaces: PersonPlaceRef[]
  pending: PendingDestination | null
  playerName: string | null
}

export interface TravelIntentResult {
  kind: TravelKind
  /** Map-resolved destination when we are willing to name one. */
  destination: PendingDestination | null
  /** What the instance should store after this turn. */
  pendingNext: PendingDestination | null
  /** Player-facing / prompt label (may be unresolved). */
  label: string | null
}

/** Building-type nouns that may uniquely resolve to one known venue. Not hall/yard/room. */
const VENUE_NOUNS = new Set(['inn', 'tavern', 'bar', 'pub', 'hotel', 'hostel', 'cafe', 'restaurant'])
const VENUE_FAMILY: string[][] = [
  ['inn', 'tavern', 'bar', 'pub'],
  ['hotel', 'hostel'],
  ['cafe', 'restaurant'],
]

const OWNED_ROOM_NOUNS = new Set([
  'room', 'bedroom', 'chamber', 'chambers', 'study', 'quarters', 'cabin', 'den',
  'office', 'cell', 'suite', 'loft', 'dorm', 'house', 'home', 'apartment', 'flat',
  'cottage', 'hut', 'tent', 'attic', 'basement', 'workshop', 'studio', 'garret',
])

const OWNED_LEAVE =
  /\b(?:i|we)\b[\s\S]{0,64}\b(?:leave|head|go|walk|run|move|step|enter|return|retire|slip)\b[\s\S]{0,32}\b(?:for|to)\s+(?:my|our)\s+(room|bedroom|chambers?|study|quarters|cabin|den|office|cell|suite|loft|dorm|house|home|apartment|flat|cottage|hut|tent|attic|basement|workshop|studio|garret)\b/i

const OWNED_ENTRY =
  /\b(?:i|we)\b[\s\S]{0,48}\b(?:go|head|walk|run|move|step|enter|stride|return|retire|slip)\b[\s\S]{0,24}\b(?:to\s+)?(?:my|our)\s+(room|bedroom|chambers?|study|quarters|cabin|den|office|cell|suite|loft|dorm|house|home|apartment|flat|cottage|hut|tent|attic|basement|workshop|studio|garret)\b/i

const WHERE_PERSON =
  /\b(?:the\s+)?(?:one|place|tavern|inn|bar|pub|hotel|cafe|restaurant)\s+where\s+([\p{L}][\p{L}' -]{1,40}?)\s+(?:works|lives|stays|is|waits)\b/iu

const PERSON_VENUE =
  /\b([\p{L}][\p{L}'-]+(?:\s+[\p{L}][\p{L}'-]+){0,2})'s\s+(tavern|inn|bar|pub|hotel|cafe|restaurant|room|house)\b/iu

const RETURN_DESTINATION =
  /\b(?:return|returns|returned|returning|head\s+back|go\s+back|walk\s+back)\b(?:\s+\w+){0,4}?\s+(?:to|into)\s+([^,.!?;*]{2,80})/i

const ARRIVAL_VERB =
  /\b(?:return|returns|returned|returning|reach|reaches|reached|reaching|arrive|arrives|arrived|arriving|enter|enters|entered|entering|step\s+inside|walk\s+into|go\s+inside)\b/

/** "Prepare to leave" is an appointment. "In order to be prepared" is not. */
const PREPARE_TO_LEAVE = /\bprepar(?:e|es|ed|ing)\s+to\b/
const LATER = /\blater\b/
const PREPARE_OR_LATER = new RegExp(`${PREPARE_TO_LEAVE.source}|${LATER.source}`, 'i')

/** Futurity that is never a walk across the street. */
const APPOINTMENT_IRREALIS =
  /\b(?:will|'ll|shall|would|'d|should|could|might|may|gonna|about\s+to|going\s+to)\b/

const LOCOMOTION_NOW =
  /\b(?:head|heads|heading|headed|go|goes|going|gone|went|walk|walks|walking|walked|leave|leaves|leaving|left|return|returns|returning|returned|enter|enters|entering|entered|ride|rides|riding|rode|step|steps|stepping|stepped|move|moves|moving|moved)\b/

function cleanLabel(raw: string | null | undefined): string | null {
  const value = String(raw || '')
    .replace(/[\*_`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.!?,\s]+|[.!?,\s]+$/g, '')
  if (!value || value.length < 2 || value.length > 80) return null
  return value
}

function venueStem(label: string | null | undefined): string | null {
  const tokens = significantLocationTokens(normalizeLocationName(String(label || '')))
  if (tokens.length !== 1) return null
  return VENUE_NOUNS.has(tokens[0]) ? tokens[0] : null
}

function venueFamilyOf(stem: string | null): Set<string> | null {
  if (!stem) return null
  const group = VENUE_FAMILY.find((g) => g.includes(stem))
  return group ? new Set(group) : new Set([stem])
}

function sameVenueFamily(a: string | null | undefined, b: string | null | undefined): boolean {
  const sa = venueStem(a)
  const sb = venueStem(b)
  if (!sa || !sb) return false
  const family = venueFamilyOf(sa)
  return !!family && family.has(sb)
}

const FOLLOW_TOWARD =
  /\bfollow\b[\s\S]{0,48}\b(?:toward|towards|to)\s+([^,.!?;*]{2,80})/i

const STOP_AT_VENUE =
  /\bstop(?:ping|ped)?\s+at\s+(?:the|a|an)\s+(inn|tavern|bar|pub|hotel|hostel|cafe|restaurant)\b/i

const THIS_VENUE =
  /\b(?:this|that)\s+(inn|tavern|bar|pub|hotel|hostel|cafe|restaurant)\b/i

function venueStemsInText(text: string): string[] {
  const tokens = significantLocationTokens(normalizeLocationName(String(text || '')))
  const stems: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    if (!VENUE_NOUNS.has(token) || seen.has(token)) continue
    seen.add(token)
    stems.push(token)
  }
  return stems
}

function nameContainsVenueToken(name: string | null | undefined): boolean {
  return significantLocationTokens(normalizeLocationName(String(name || ''))).some((token) => VENUE_NOUNS.has(token))
}

/** A proper/qualified place the map may not have minted yet. Not "the inn". */
function isSpecificNamedDestination(name: string | null | undefined): boolean {
  const label = String(name || '').trim()
  if (!label) return false
  if (isBareGenericPlaceLabel(label) || isVagueLocationLabel(label)) return false
  if (venueStem(label) || nameContainsVenueToken(label)) return false
  return true
}

/**
 * Query is this known place? Asymmetric: a more specific query must not collapse
 * onto a shorter settlement ("the tavern in Falkreath" is not Falkreath).
 */
function labelIsThisPlace(query: string, candidate: string): boolean {
  const qNorm = normalizeLocationName(query)
  const cNorm = normalizeLocationName(candidate)
  if (!qNorm || !cNorm) return false
  if (qNorm === cNorm) return true
  if (!placesAreTheSameLocation(query, candidate)) return false
  const q = significantLocationTokens(qNorm)
  const c = significantLocationTokens(cNorm)
  if (q.length > c.length) {
    const cSet = new Set(c)
    if (q.some((token) => !cSet.has(token))) return false
  }
  return true
}

function placeNames(place: KnownPlaceRef): string[] {
  return [place.name, ...(place.aliases || [])].filter(Boolean)
}

function labelMatchesPlace(label: string, place: KnownPlaceRef): boolean {
  return placeNames(place).some((name) => labelIsThisPlace(label, name))
}

function identityMatch(label: string, places: KnownPlaceRef[]): KnownPlaceRef | null {
  const hits: KnownPlaceRef[] = []
  const seen = new Set<string>()
  for (const place of places) {
    if (!labelMatchesPlace(label, place)) continue
    const key = place.entityId || `name:${normalizeLocationName(place.name)}`
    if (seen.has(key)) continue
    seen.add(key)
    hits.push(place)
  }
  return hits.length === 1 ? hits[0] : null
}

function mostRecentlySeen(hits: KnownPlaceRef[]): KnownPlaceRef | null {
  if (hits.length === 1) return hits[0]
  if (hits.length < 2) return null
  const ranked = [...hits].sort(
    (a, b) => Number(b.lastSeenSequence || 0) - Number(a.lastSeenSequence || 0),
  )
  const top = Number(ranked[0].lastSeenSequence || 0)
  const second = Number(ranked[1].lastSeenSequence || 0)
  if (top > 0 && top > second) return ranked[0]
  return null
}

function uniqueVenueMatch(
  stem: string,
  places: KnownPlaceRef[],
  _cursorName?: string | null,
): KnownPlaceRef | null {
  const family = venueFamilyOf(stem)
  if (!family) return null
  const hits: KnownPlaceRef[] = []
  const seen = new Set<string>()
  for (const place of places) {
    const names = placeNames(place)
    const hasStem = names.some((name) =>
      significantLocationTokens(normalizeLocationName(name)).some((token) => family.has(token)),
    )
    if (!hasStem) continue
    const key = place.entityId || `name:${normalizeLocationName(place.name)}`
    if (seen.has(key)) continue
    seen.add(key)
    hits.push(place)
  }
  return mostRecentlySeen(hits)
}

function personMentioned(text: string, person: PersonPlaceRef): boolean {
  const hay = String(text || '').toLocaleLowerCase()
  for (const raw of [person.name, ...(person.aliases || [])]) {
    const name = String(raw || '').trim()
    if (name.length < 2) continue
    if (hay.includes(name.toLocaleLowerCase())) return true
    const first = name.split(/\s+/)[0]
    if (first && first.length >= 3 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(hay)) {
      return true
    }
  }
  return false
}

function ownedRoomNoun(playerInput: string): string | null {
  const owned = playerInput.match(OWNED_LEAVE) || playerInput.match(OWNED_ENTRY)
  const noun = owned?.[1]?.toLocaleLowerCase()
  if (!noun) return null
  if (noun === 'chambers' || noun === 'chamber') return 'room'
  if (noun === 'bedroom' || noun === 'dorm') return 'room'
  return OWNED_ROOM_NOUNS.has(noun) ? noun : 'room'
}

function ownedRoomName(playerName: string | null, noun: string): string | null {
  const owner = String(playerName || '').trim()
  if (!owner) return null
  return `${owner}'s ${noun}`
}

/** Same default identity `ensurePlayerEntity` uses when the viewpoint is unnamed. */
const UNNAMED_VIEWPOINT = 'The Player'

function ownedRelativeLabels(noun: string): string[] {
  const labels = [`my ${noun}`, `our ${noun}`]
  if (noun === 'room') {
    labels.push('my bedroom', 'our bedroom', 'my chamber', 'our chamber', 'my chambers', 'our chambers', 'my dorm', 'our dorm')
  }
  return labels
}

function ownedRoomsByAlias(noun: string, places: KnownPlaceRef[]): KnownPlaceRef[] {
  const needles = new Set(ownedRelativeLabels(noun).map((label) => normalizeLocationName(label)))
  const hits: KnownPlaceRef[] = []
  const seen = new Set<string>()
  for (const place of places) {
    const hit = placeNames(place).some((name) => needles.has(normalizeLocationName(name)))
    if (!hit) continue
    const key = place.entityId || `name:${normalizeLocationName(place.name)}`
    if (seen.has(key)) continue
    seen.add(key)
    hits.push(place)
  }
  return hits
}

/**
 * The viewpoint who owns "my room".
 *
 * Sentient worlds: the human (persona), never the locked AI character.
 * GM worlds: the onboarded protagonist card, then the template's authored name.
 */
export function viewpointOwnerName(params: {
  isSentient: boolean
  protagonistCardName?: string | null
  personaName?: string | null
  templateProtagonistName?: string | null
}): string | null {
  const persona = String(params.personaName || '').trim() || null
  const card = String(params.protagonistCardName || '').trim() || null
  const authored = String(params.templateProtagonistName || '').trim() || null
  if (params.isSentient) return persona
  return card || authored || persona
}

function withOwnedAliases(dest: PendingDestination, noun: string): PendingDestination {
  return {
    ...dest,
    aliases: [...new Set([...(dest.aliases || []), ...ownedRelativeLabels(noun)])],
  }
}

function resolveOwnedRoom(noun: string, input: TravelIntentInput): PendingDestination | null {
  const specific = ownedRoomName(input.playerName, noun)
  if (specific) {
    const existing = identityMatch(specific, input.knownPlaces)
    if (existing) return withOwnedAliases(asPlace(existing.name, existing.entityId, existing.aliases), noun)
  }
  const aliasHits = ownedRoomsByAlias(noun, input.knownPlaces)
  if (aliasHits.length === 1) {
    const byAlias = aliasHits[0]
    return withOwnedAliases(asPlace(byAlias.name, byAlias.entityId, byAlias.aliases), noun)
  }
  if (specific) return withOwnedAliases(asPlace(specific, null), noun)
  if (aliasHits.length > 1) return null
  // Unnamed viewpoint, no existing private room on the map. "my room" is vague
  // and must not become a node; the player-entity default is already specific.
  const unnamed = ownedRoomName(UNNAMED_VIEWPOINT, noun)
  if (!unnamed) return null
  const existingUnnamed = identityMatch(unnamed, input.knownPlaces)
  if (existingUnnamed) {
    return withOwnedAliases(asPlace(existingUnnamed.name, existingUnnamed.entityId, existingUnnamed.aliases), noun)
  }
  return withOwnedAliases(asPlace(unnamed, null), noun)
}

function destFromPlayerText(playerInput: string): string | null {
  const text = String(playerInput || '')
  const where = text.match(WHERE_PERSON)
  if (where?.[1]) return cleanLabel(`where ${where[1].trim()} works`)
  const possessive = text.match(PERSON_VENUE)
  if (possessive?.[0]) return cleanLabel(possessive[0])
  const owned = ownedRoomNoun(text)
  if (owned) return cleanLabel(`my ${owned}`)
  const follow = text.match(FOLLOW_TOWARD)?.[1]
  if (follow) return cleanLabel(follow.replace(/\s+in\s+[\p{L}][\p{L}' -]{1,40}$/u, ''))
  const returning = text.match(RETURN_DESTINATION)?.[1]
  if (returning) return cleanLabel(returning.replace(/\s+in\s+[\p{L}][\p{L}' -]{1,40}$/u, ''))
  const stop = text.match(STOP_AT_VENUE)
  if (stop?.[1]) return cleanLabel(`the ${stop[1].toLocaleLowerCase()}`)
  const extracted = extractExplicitPhysicalDestination(text)
  if (extracted) return cleanLabel(extracted.replace(/\s+in\s+[\p{L}][\p{L}' -]{1,40}$/u, ''))
  if (LOCOMOTION_NOW.test(text) || /\blet's\b/i.test(text) || STOP_AT_VENUE.test(text)) {
    const stems = venueStemsInText(text)
    if (stems.length === 1) return cleanLabel(`the ${stems[0]}`)
  }
  return null
}

function mentionedPeople(text: string, people: PersonPlaceRef[]): PersonPlaceRef[] {
  const fromWhere = text.match(WHERE_PERSON)?.[1]?.trim()
  const fromPoss = text.match(PERSON_VENUE)?.[1]?.trim()
  const hinted = [fromWhere, fromPoss].filter(Boolean) as string[]
  const hits = people.filter((person) => {
    if (personMentioned(text, person)) return true
    return hinted.some((hint) => personMentioned(hint, person) || person.name.toLocaleLowerCase().includes(hint.toLocaleLowerCase()))
  })
  const seen = new Set<string>()
  const unique: PersonPlaceRef[] = []
  for (const person of hits) {
    const key = person.placeEntityId || person.name
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(person)
  }
  return unique
}

export function lastPlacesFromPresence(
  people: Array<{ name: string; aliases?: string[] }>,
  scenes: Array<{ locationName?: string | null; locationEntityId?: string | null; present?: string[] }>,
): PersonPlaceRef[] {
  const newestFirst = [...scenes].reverse()
  const out: PersonPlaceRef[] = []
  const seen = new Set<string>()
  for (const person of people) {
    const key = normalizeLocationName(person.name)
    if (!key || seen.has(key)) continue
    const probe: PersonPlaceRef = { name: person.name, aliases: person.aliases || [], placeName: null }
    let placeName: string | null = null
    let placeEntityId: string | null = null
    for (const scene of newestFirst) {
      const present = scene.present || []
      if (!scene.locationName || present.length === 0) continue
      const here = present.some((label) => personMentioned(label, probe) || personMentioned(person.name, { name: label, aliases: [], placeName: null }))
      if (!here) continue
      placeName = scene.locationName
      placeEntityId = scene.locationEntityId || null
      break
    }
    if (!placeName) continue
    seen.add(key)
    out.push({
      name: person.name,
      aliases: person.aliases || [],
      placeName,
      placeEntityId,
    })
  }
  return out
}

export function mergePersonPlaces(fromGraph: PersonPlaceRef[], fromPresence: PersonPlaceRef[]): PersonPlaceRef[] {
  const byKey = new Map<string, PersonPlaceRef>()
  const keyOf = (person: PersonPlaceRef) => normalizeLocationName(person.name)
  for (const person of fromPresence) {
    const key = keyOf(person)
    if (key && person.placeName) byKey.set(key, person)
  }
  for (const person of fromGraph) {
    const key = keyOf(person)
    if (!key) continue
    if (person.placeName) byKey.set(key, person)
  }
  return [...byKey.values()]
}

function asPlace(name: string, entityId?: string | null, aliases?: string[]): PendingDestination {
  return {
    name,
    entityId: entityId || null,
    aliases: aliases?.filter(Boolean),
  }
}

function pendingAliases(label: string, resolvedName: string, extraText?: string): string[] {
  const out = new Set<string>()
  const add = (value: string | null | undefined) => {
    const v = cleanLabel(value)
    if (v) out.add(v)
  }
  add(label)
  add(resolvedName)
  const addVenueToken = (token: string) => {
    if (!VENUE_NOUNS.has(token)) return
    add(token)
    add(`the ${token}`)
    for (const sibling of venueFamilyOf(token) || []) {
      add(sibling)
      add(`the ${sibling}`)
    }
  }
  const stem = venueStem(label)
  if (stem) addVenueToken(stem)
  for (const source of [label, extraText]) {
    for (const token of significantLocationTokens(normalizeLocationName(String(source || '')))) {
      addVenueToken(token)
    }
  }
  out.delete(resolvedName)
  return [...out]
}

function matchesPending(label: string | null, pending: PendingDestination | null): boolean {
  if (!label || !pending?.name) return false
  if (labelIsThisPlace(label, pending.name)) return true
  if ((pending.aliases || []).some((alias) => labelIsThisPlace(label, alias) || sameVenueFamily(label, alias))) {
    return true
  }
  if (sameVenueFamily(label, pending.name)) return true
  return false
}

function uniquelyResolved(dest: PendingDestination | null, places: KnownPlaceRef[]): boolean {
  if (!dest?.name) return false
  if (dest.entityId) return true
  return !!identityMatch(dest.name, places)
}

function placeRef(places: KnownPlaceRef[], id: string | null | undefined): KnownPlaceRef | null {
  if (!id) return null
  return places.find((place) => place.entityId === id) || null
}

/**
 * Same building or settlement — a walk, not a journey. Sharing only a region
 * or world root is not local: palace → Falkreath stays pending.
 */
function isLocalDestination(input: TravelIntentInput, dest: PendingDestination): boolean {
  const destPlace =
    (dest.entityId ? placeRef(input.knownPlaces, dest.entityId) : null) ||
    identityMatch(dest.name, input.knownPlaces)
  const cursorPlace =
    placeRef(input.knownPlaces, input.cursorEntityId) ||
    (input.cursorName
      ? input.knownPlaces.find((place) => placesAreTheSameLocation(place.name, input.cursorName)) || null
      : null)
  if (!cursorPlace || !destPlace) return false
  const destId = destPlace.entityId || null
  const fromId = cursorPlace.entityId || input.cursorEntityId || null
  if (fromId && destId && fromId === destId) return false
  if (cursorPlace.parentId && destId && cursorPlace.parentId === destId) return true
  if (destPlace.parentId && fromId && destPlace.parentId === fromId) return true
  if (cursorPlace.parentId && destPlace.parentId && cursorPlace.parentId === destPlace.parentId) {
    return true
  }
  if (onContainmentSpine(cursorPlace, destPlace, input.knownPlaces)) return true
  const cursorArea = nearestBuildingOrSettlement(cursorPlace, input.knownPlaces)
  const destArea = nearestBuildingOrSettlement(destPlace, input.knownPlaces)
  return !!cursorArea && !!destArea && cursorArea === destArea
}

/**
 * They've already been the cursor at this place. Walking back is not a journey,
 * even when the map has no containment edge (steward's yard → the occupied inn).
 * Settlements and regions stay pending: "let's go to Falkreath" is still a trip.
 */
function isOccupiedKnownPlace(input: TravelIntentInput, dest: PendingDestination): boolean {
  const destPlace =
    (dest.entityId ? placeRef(input.knownPlaces, dest.entityId) : null) ||
    identityMatch(dest.name, input.knownPlaces)
  if (!destPlace) return false
  if (Number(destPlace.mentionCount || 0) < 1) return false
  const kind = String(destPlace.placeKind || '').toLowerCase()
  if (kind === 'settlement' || kind === 'region' || kind === 'world') return false
  return uniquelyResolved(dest, input.knownPlaces)
}

function nearestBuildingOrSettlement(place: KnownPlaceRef, places: KnownPlaceRef[]): string | null {
  const LOCAL_KIND = new Set(['building', 'settlement'])
  let current: KnownPlaceRef | null = place
  const seen = new Set<string>()
  for (let i = 0; i < 8 && current; i++) {
    const id = current.entityId || ''
    if (id && seen.has(id)) break
    if (id) seen.add(id)
    if (current.placeKind && LOCAL_KIND.has(current.placeKind) && current.entityId) {
      return current.entityId
    }
    current = current.parentId ? placeRef(places, current.parentId) : null
  }
  return null
}

function ancestorIds(place: KnownPlaceRef, places: KnownPlaceRef[]): Set<string> {
  const ids = new Set<string>()
  let current: KnownPlaceRef | null = place
  for (let i = 0; i < 8 && current; i++) {
    const id = current.entityId
    if (id) {
      if (ids.has(id)) break
      ids.add(id)
    }
    current = current.parentId ? placeRef(places, current.parentId) : null
  }
  return ids
}

/** Dest is inside the cursor's container, or the cursor is still inside dest. */
function onContainmentSpine(cursor: KnownPlaceRef, dest: KnownPlaceRef, places: KnownPlaceRef[]): boolean {
  const cursorId = cursor.entityId
  const destId = dest.entityId
  if (!cursorId || !destId || cursorId === destId) return false
  return ancestorIds(cursor, places).has(destId) || ancestorIds(dest, places).has(cursorId)
}

/** "Let's head to X" is a walk when X is already underfoot, not an appointment. */
function isImmediateLets(playerInput: string): boolean {
  const t = String(playerInput || '').toLocaleLowerCase()
  if (!/\blet's\b/.test(t)) return false
  if (PREPARE_OR_LATER.test(t) || APPOINTMENT_IRREALIS.test(t)) return false
  return LOCOMOTION_NOW.test(t)
}

function alreadyThere(
  dest: PendingDestination | null,
  cursorName: string | null,
  cursorEntityId?: string | null,
): boolean {
  if (!dest) return false
  if (dest.entityId && cursorEntityId && dest.entityId === cursorEntityId) return true
  if (cursorName && placesAreTheSameLocation(dest.name, cursorName)) return true
  if (cursorName && (dest.aliases || []).some((alias) => placesAreTheSameLocation(alias, cursorName))) return true
  return false
}

function destinationIsCurrentPlace(dest: PendingDestination | null, input: TravelIntentInput): boolean {
  if (!dest) return false
  if (alreadyThere(dest, input.cursorName, input.cursorEntityId)) return true
  const stems = [venueStem(dest.name), ...venueStemsInText(dest.name || '')].filter(Boolean) as string[]
  for (const stem of stems) {
    const unique = uniqueVenueMatch(stem, input.knownPlaces)
    if (unique && alreadyThere(asPlace(unique.name, unique.entityId, unique.aliases), input.cursorName, input.cursorEntityId)) {
      return true
    }
  }
  return false
}

/**
 * Grammatical classification for the narrator prompt (no map required).
 * Arrival here means the player's words claim they are going/arriving now,
 * not that the map has resolved a node.
 */
export function classifyPlayerTravel(playerInput: string): { kind: TravelKind; label: string | null } {
  const text = String(playerInput || '').trim()
  if (!text) return { kind: 'none', label: null }
  const label = destFromPlayerText(text)
  const owned = ownedRoomNoun(text)
  if (owned && !PREPARE_OR_LATER.test(text.toLocaleLowerCase())) {
    return { kind: 'owned_leave', label: label || `my ${owned}` }
  }
  if (playerTextMarksIntent(text) || PREPARE_OR_LATER.test(text.toLocaleLowerCase())) {
    return { kind: label ? 'intent' : 'none', label }
  }
  const followNow = FOLLOW_TOWARD.test(text) && !PREPARE_OR_LATER.test(text.toLocaleLowerCase())
  if (label && (ARRIVAL_VERB.test(text.toLocaleLowerCase()) || followNow || playerTextSituatesViewpoint(label, text))) {
    return { kind: 'arrival', label }
  }
  if (label) return { kind: 'intent', label }
  return { kind: 'none', label: null }
}

function resolveLabel(
  label: string,
  input: TravelIntentInput,
): PendingDestination | null {
  if (!label) return null
  if (isBareGenericPlaceLabel(label)) return null

  const owned = ownedRoomNoun(input.playerInput)
  if (owned) return resolveOwnedRoom(owned, input)

  const identity = identityMatch(label, input.knownPlaces)
  if (identity) return asPlace(identity.name, identity.entityId, identity.aliases)

  const people = mentionedPeople(input.playerInput, input.personPlaces).filter((p) => p.placeName)
  if (people.length === 1) {
    const personPlace = people[0]
    const personPlaceName = personPlace.placeName
    if (!personPlaceName) return null
    const stem = venueStem(label)
    const vague = isVagueLocationLabel(label) || /^where\s+/i.test(label)
    if (vague || stem || sameVenueFamily(label, personPlaceName) || /'s\s+(tavern|inn|bar|pub|hotel|cafe|restaurant)\b/i.test(label)) {
      const known = identityMatch(personPlaceName, input.knownPlaces)
      return asPlace(
        known?.name || personPlaceName,
        personPlace.placeEntityId || known?.entityId || null,
        pendingAliases(label, known?.name || personPlaceName, input.playerInput),
      )
    }
  }

  for (const stem of venueStemsInText(input.playerInput)) {
    const unique = uniqueVenueMatch(stem, input.knownPlaces, input.cursorName)
    if (unique) return asPlace(unique.name, unique.entityId, pendingAliases(label, unique.name, input.playerInput))
  }

  const stem = venueStem(label)
  if (stem) {
    const unique = uniqueVenueMatch(stem, input.knownPlaces, input.cursorName)
    if (unique) return asPlace(unique.name, unique.entityId, pendingAliases(label, unique.name, input.playerInput))
  }

  if (input.pending && matchesPending(label, input.pending)) {
    return {
      name: input.pending.name,
      entityId: input.pending.entityId || null,
      aliases: [...new Set([...(input.pending.aliases || []), ...pendingAliases(label, input.pending.name, input.playerInput)])],
    }
  }

  if (isVagueLocationLabel(label)) return null
  return asPlace(label, null)
}

export function occupancyVenueAliases(
  playerInput: string | null | undefined,
  placeName: string | null | undefined,
): string[] {
  const text = String(playerInput || '')
  const place = String(placeName || '').trim()
  if (!text || !place) return []
  if (isVagueLocationLabel(place) || isBareGenericPlaceLabel(place)) return []
  const here = text.match(THIS_VENUE)
  if (!here?.[1]) return []
  return pendingAliases(`the ${here[1].toLocaleLowerCase()}`, place, text)
}

export function aliasesToBindOnArrival(params: {
  destName: string
  playerInput: string
  playerLabel: string | null
  pending: PendingDestination | null
}): string[] {
  const destName = String(params.destName || '').trim()
  if (!destName) return []
  if (
    params.playerLabel &&
    isSpecificNamedDestination(params.playerLabel) &&
    !placesAreTheSameLocation(params.playerLabel, destName) &&
    !labelIsThisPlace(params.playerLabel, destName)
  ) {
    return occupancyVenueAliases(params.playerInput, destName)
  }
  const aliases = new Set(occupancyVenueAliases(params.playerInput, destName))
  for (const alias of pendingAliases(params.playerLabel || params.pending?.name || '', destName, params.playerInput)) {
    aliases.add(alias)
  }
  if (params.pending) {
    for (const alias of params.pending.aliases || []) aliases.add(alias)
    if (venueStem(params.pending.name) || nameContainsVenueToken(params.pending.name)) {
      aliases.add(params.pending.name)
      for (const alias of pendingAliases(params.pending.name, destName, params.playerInput)) aliases.add(alias)
    }
  }
  return [...aliases].filter(
    (alias) => alias && !placesAreTheSameLocation(alias, destName) && !isBareGenericPlaceLabel(alias),
  )
}

/**
 * Provisional scene names never become graph entities until authored, so the
 * inn the player just left is invisible to unique-venue resolve. Fold the
 * playthrough's own location anchors in so "the inn" can mean that stay.
 * Player venue words spoken WHILE there ("this tavern") become aliases on that
 * stay — not on the yard they later intend to leave for an inn.
 */
export function mergeSceneHistoryIntoPlaces(
  graph: KnownPlaceRef[],
  scenes: Array<{ name?: string | null; entityId?: string | null; sequence?: number; playerInput?: string | null }>,
): KnownPlaceRef[] {
  const places: KnownPlaceRef[] = graph.map((place) => ({ ...place }))
  const byId = new Map(places.filter((place) => place.entityId).map((place) => [place.entityId as string, place]))
  const byName = new Map(places.map((place) => [normalizeLocationName(place.name), place]))
  for (const scene of scenes) {
    const name = String(scene.name || '').replace(/\s+/g, ' ').trim()
    if (!name) continue
    const seq = Number(scene.sequence || 0)
    const id = scene.entityId || null
    let target =
      (id && byId.get(id)) ||
      byName.get(normalizeLocationName(name)) ||
      null
    if (!target) {
      target = { name, entityId: id, lastSeenSequence: seq, mentionCount: 0, aliases: [] }
      places.push(target)
      if (id) byId.set(id, target)
      byName.set(normalizeLocationName(name), target)
    }
    target.lastSeenSequence = Math.max(Number(target.lastSeenSequence || 0), seq)
    target.mentionCount = Number(target.mentionCount || 0) + 1
    if (id && !target.entityId) {
      target.entityId = id
      byId.set(id, target)
    }
    const occupancy = occupancyVenueAliases(scene.playerInput, name)
    if (occupancy.length) {
      target.aliases = [...new Set([...(target.aliases || []), ...occupancy])]
    }
  }
  return places
}

export function decideTravelIntent(input: TravelIntentInput): TravelIntentResult {
  const classified = classifyPlayerTravel(input.playerInput)
  const keepPending = (): PendingDestination | null => {
    if (!input.pending?.name) return null
    if (alreadyThere(input.pending, input.cursorName, input.cursorEntityId) || destinationIsCurrentPlace(input.pending, input)) return null
    return input.pending
  }

  if (input.isContinuation) {
    return { kind: 'none', destination: null, pendingNext: keepPending(), label: classified.label }
  }

  if (classified.kind === 'none') {
    return { kind: 'none', destination: null, pendingNext: keepPending(), label: null }
  }

  const resolved = classified.label ? resolveLabel(classified.label, input) : null

  if (classified.kind === 'intent') {
    if (resolved && destinationIsCurrentPlace(resolved, input)) {
      return { kind: 'none', destination: null, pendingNext: null, label: classified.label }
    }
    if (
      resolved &&
      uniquelyResolved(resolved, input.knownPlaces) &&
      isImmediateLets(input.playerInput) &&
      (isLocalDestination(input, resolved) || isOccupiedKnownPlace(input, resolved))
    ) {
      return { kind: 'arrival', destination: resolved, pendingNext: null, label: classified.label }
    }
    const strongPending =
      input.pending && uniquelyResolved(input.pending, input.knownPlaces) ? input.pending : null
    const strongResolved = resolved && uniquelyResolved(resolved, input.knownPlaces) ? resolved : null
    const pendingBase = strongResolved
      ? strongResolved
      : strongPending
        ? strongPending
        : input.pending?.name && resolved && !uniquelyResolved(resolved, input.knownPlaces)
          ? {
              ...input.pending,
              aliases: [
                ...new Set([
                  ...(input.pending.aliases || []),
                  ...(resolved.aliases || []),
                  ...pendingAliases(classified.label || input.pending.name, input.pending.name, input.playerInput),
                ]),
              ],
            }
          : resolved
    const pendingNext = pendingBase
      ? {
          ...pendingBase,
          aliases: [
            ...new Set([
              ...(pendingBase.aliases || []),
              ...(strongPending && pendingBase !== strongPending ? strongPending.aliases || [] : []),
              ...pendingAliases(classified.label || pendingBase.name, pendingBase.name, input.playerInput),
            ]),
          ],
        }
      : classified.label
        ? asPlace(classified.label, null)
        : keepPending()
    return { kind: 'intent', destination: pendingNext, pendingNext, label: classified.label }
  }

  if (classified.kind === 'owned_leave') {
    if (!resolved || isBareGenericPlaceLabel(resolved.name) || isVagueLocationLabel(resolved.name)) {
      return { kind: 'none', destination: null, pendingNext: keepPending(), label: classified.label }
    }
    if (destinationIsCurrentPlace(resolved, input)) {
      return { kind: 'none', destination: null, pendingNext: null, label: classified.label }
    }
    return { kind: 'owned_leave', destination: resolved, pendingNext: null, label: classified.label }
  }

  // Arrival. Completing pending is allowed even when the namers hold, but only
  // when the player's words name this dest or the pending place.
  const pendingHit = matchesPending(classified.label, input.pending) ? input.pending : null
  const dest =
    (resolved && uniquelyResolved(resolved, input.knownPlaces) ? resolved : null) ||
    pendingHit ||
    (resolved && !isBareGenericPlaceLabel(resolved.name) ? resolved : null)
  if (!dest?.name) {
    return { kind: 'none', destination: null, pendingNext: keepPending(), label: classified.label }
  }
  if (destinationIsCurrentPlace(dest, input)) {
    return { kind: 'none', destination: null, pendingNext: null, label: classified.label }
  }
  // An unresolved or ambiguous label is not an arrival. A proper named dest
  // the map has not minted yet still is — "the inn" is not.
  const uniquelyOnMap =
    !!dest.entityId || !!identityMatch(dest.name, input.knownPlaces)
  if (!uniquelyOnMap && !ownedRoomNoun(input.playerInput) && !isSpecificNamedDestination(dest.name)) {
    const pendingNext = { ...dest, aliases: pendingAliases(classified.label || dest.name, dest.name, input.playerInput) }
    return { kind: 'intent', destination: pendingNext, pendingNext, label: classified.label }
  }
  return { kind: 'arrival', destination: dest, pendingNext: null, label: classified.label }
}

export function travelPromptDirective(params: {
  kind: TravelKind
  label: string | null
  resolvedName?: string | null
  cursorName?: string | null
  playerInput: string
}): string | null {
  const dest = params.resolvedName || params.label
  if (params.kind === 'intent' && dest) {
    const here = params.cursorName ? ` They are still at ${params.cursorName}.` : ' They are still at the current place.'
    return `[PLAYER TRAVEL INTENT: The player intends to go to ${dest} but has not arrived.${here} Narrate only what happens here, or the start of a journey. Do not arrive this turn. Do not bring people from ${dest} into this scene — they stay there until the player arrives.]
PLAYER ACTION: ${params.playerInput}`
  }
  if (params.kind === 'owned_leave' && dest) {
    return `[PLAYER SCENE TRANSITION: The player is leaving for ${dest}. Follow their viewpoint there. Do not keep the prior room's people in this scene unless the player brought them.]
PLAYER ACTION: ${params.playerInput}`
  }
  if (params.kind === 'arrival' && dest) {
    return `[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to ${dest}. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]
PLAYER ACTION: ${params.playerInput}`
  }
  return null
}
