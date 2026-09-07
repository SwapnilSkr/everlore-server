/**
 * WHO IS STANDING HERE.
 *
 * The map had thirty places, four endings and a reign, and nobody in it. Twenty
 * characters were authored months ago and the client had no concept of them at
 * all — so the world could be walked, opened and ruled without ever meeting the
 * champion whose contract the whole chapter is about.
 *
 * Presence is DERIVED, exactly like standing and marks are: a character is
 * where they were authored to be, the moment the flag they were authored behind
 * has landed. Nothing about who is present is stored, so retuning a gate in the
 * cast file moves every existing save with it rather than only new ones.
 *
 * THE EXPOSURE RULE, because two fields look alike and only one is a gate:
 *
 *   — `gated_by_flag` is the gate. It is the flag that must be true before the
 *     character is anywhere the player can see. Gaunt is not in the Chainhouse
 *     until a Verdict has been witnessed; Iselle is not past the palisade until
 *     the gate is passed.
 *   — `reveals_flag` is the character's OUTPUT — the thing they can tell the
 *     player that opens a road. It is not a gate and must never be read as one:
 *     gating a character on the flag only they can grant makes them permanently
 *     unreachable, and the map simply loses a place with no error anywhere.
 *
 * So a character is spoiled by being seen early only if the author said so, in
 * the one field that means it.
 */
import type { InteractiveAssetDoc } from '../models/interactive-world.model'
import type { LoadedWorld, WorldCastMember } from './world-source'

/**
 * A character as the CLIENT receives them.
 *
 * Everything the character knows, wants and fears is absent. This is the same
 * invariant `the_truth` has on a petition and it fails the same silent way: a
 * conversation with a person whose secrets are already on the client still
 * renders a perfectly good scene, it just is not a conversation any more. One
 * mapping produces this shape — see `offer` below — so a field that must never
 * be sent cannot be sent by whichever call site was written second.
 */
export interface PresentCharacter {
  id: string
  name: string
  role: string
  faction: string
  /** The published portrait to draw. Null only while the art is unpublished. */
  portrait_url: string | null
  /** True once the player has spoken with them at least once. */
  met: boolean
  /**
   * The authored beat of the player walking into them, sent ONLY while they are
   * unmet.
   *
   * It is the one piece of a character's file that was written to be read by a
   * player rather than by narration, and without it the first meeting is a card
   * with a face on it. It is dropped once they are met because it describes an
   * arrival, and an arrival that replays every time the player looks at someone
   * reads as the world resetting.
   */
  first_met?: string
}

/** The cast of a loaded world, typed. Absent cast file means no cast, not a break. */
export const castOf = (world: LoadedWorld): WorldCastMember[] => world.cast

/**
 * Who the player can see from where they are standing.
 *
 * Read against the EFFECTIVE flags, so a gate the story loop opened counts the
 * same as one an authored choice opened — a character promised by the fiction
 * has to actually be there, or the promise is the map's old failure again.
 */
export function presentCast(
  world: LoadedWorld,
  locationId: string,
  flags: Record<string, boolean>,
): WorldCastMember[] {
  return castOf(world).filter(
    (member) =>
      member.home_location_id === locationId &&
      (!member.gated_by_flag || flags[member.gated_by_flag] === true),
  )
}

/** The published portrait for one bearing, or the default when it has none. */
export function portraitAssetId(member: WorldCastMember, bearing: string | undefined): string {
  const named = bearing ? member.portraits[bearing] : undefined
  return named ?? member.portraits.default!
}

/**
 * What a character will actually say out loud right now.
 *
 * `knows_guarded` is the whole reason this function exists. An entry there is a
 * fact the character HAS and will not volunteer until the player can put
 * something in front of them — the Duke's complicity is the answer the chapter
 * ends on, not a line he offers a stranger. Ungated, it is indistinguishable
 * from open knowledge, and the scene where he confesses on turn one looks
 * entirely normal.
 *
 * So the filter is here, at the single point where knowledge is assembled, and
 * both the prompt and anything else that ever needs it read this and never the
 * authored member. A guarded fact whose gate is off does not reach the model,
 * which is the only way it cannot reach the player.
 */
export function knowledgeFor(member: WorldCastMember, flags: Record<string, boolean>): string[] {
  const guarded = (member.knows_guarded ?? [])
    .filter((entry) => entry.requires && flags[entry.requires] === true)
    .map((entry) => entry.fact)
  return [...member.knows, ...guarded]
}

/**
 * The single mapping onto the wire.
 *
 * Portraits are resolved against the world's published assets rather than
 * carried as ids, because an id the client cannot turn into a URL renders an
 * empty card at the exact moment the player first meets someone.
 */
export function offerCast(
  members: WorldCastMember[],
  assets: (InteractiveAssetDoc & { url?: string | null })[],
  met: (id: string) => boolean,
): PresentCharacter[] {
  const urls = new Map(assets.map((asset) => [asset.id, asset.url ?? null]))
  return members.map((member) => ({
    id: member.id,
    name: member.name,
    role: member.role,
    faction: member.faction,
    portrait_url: urls.get(portraitAssetId(member, undefined)) ?? null,
    met: met(member.id),
    ...(met(member.id) ? {} : { first_met: member.first_met }),
  }))
}
