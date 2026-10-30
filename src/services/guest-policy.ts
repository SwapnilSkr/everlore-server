import { mongoColl } from '../config/mongo'
import { parseObjectId } from '../utils/mongo-id'
import { HttpError } from '../utils/http-error'

export const GUEST_TURN_LIMIT = 5
export function signInRequired(): HttpError {
  return new HttpError(403, 'Keep your story — sign in to continue.', { code: 'sign_in_required' })
}

export async function requireIdentity(userId: string): Promise<void> {
  const user = await mongoColl.users().findOne({ _id: parseObjectId(userId) })
  if (!user) throw new HttpError(401, 'Sign in to continue.')
  if (user.guest) throw signInRequired()
}

/** Counts admissions, across all saves, including continuations and replays.
 * Reset/rewind cannot replenish the allowance; concurrent saves share one CAS. */
export async function reserveGuestTurn(userId: string): Promise<boolean> {
  const _id = parseObjectId(userId)
  const user = await mongoColl.users().findOne({ _id })
  if (!user) throw new HttpError(401, 'Sign in to continue.')
  if (!user.guest) return false
  const result = await mongoColl.users().updateOne({
    _id, guest: true, guest_merge_target: { $exists: false }, guest_purging: { $ne: true },
    $or: [{ guest_turns: { $lt: GUEST_TURN_LIMIT } }, { guest_turns: { $exists: false } }],
  }, { $inc: { guest_turns: 1 } })
  if (!result.modifiedCount) throw signInRequired()
  return true
}

export async function releaseGuestTurn(userId: string): Promise<void> {
  await mongoColl.users().updateOne({ _id: parseObjectId(userId), guest: true, guest_turns: { $gt: 0 } }, { $inc: { guest_turns: -1 } })
}
