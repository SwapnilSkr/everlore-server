import { hasGuestRequests, closeGuestRequests, reopenGuestRequests } from './guest-requests'
import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { getRedisClient } from '../config/redis'
import type { UserDoc, UserInsertDoc } from '../models/user.model'
import { HttpError } from '../utils/http-error'
import { defaultUserPreferences } from './auth.service'

const users = () => mongoColl.users()
export const guestService = {
  async create(installId: string, sessionUserId?: string): Promise<UserDoc> {
    if (sessionUserId && ObjectId.isValid(sessionUserId)) {
      const guest = await users().findOne({ _id: new ObjectId(sessionUserId), guest: true, install_id: installId,
        guest_merge_target: { $exists: false }, guest_purging: { $ne: true } })
      if (guest && guest.account_status !== 'banned') return guest
    }
    const now = new Date()
    const doc: UserInsertDoc = {
      guest: true, install_id: installId, guest_turns: 0,
      username: `guest_${new ObjectId().toHexString()}`, password_hash: '', tier: 'free', providers: [],
      preferences: defaultUserPreferences(), token_balance: 15000, created_at: now, guest_started_at: now, updated_at: now,
    }
    try {
      const { insertedId } = await users().insertOne(doc)
      return { ...doc, _id: insertedId }
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 11000) throw error
      // An install identifier is public, so it is never enough to recover a token.
      throw new HttpError(409, 'Resume your guest session or sign in to continue.', { code: 'guest_session_required' })
    }
  },

  async eligible(userId?: string): Promise<UserDoc | null> {
    if (!userId || !ObjectId.isValid(userId)) return null
    return users().findOne({ _id: new ObjectId(userId), guest: true, account_status: { $ne: 'banned' }, guest_purging: { $ne: true } })
  },

  async claim(userId: string | undefined, identity: { email?: string; google_sub?: string; firebase_uid?: string; phone?: string }, provider: string): Promise<UserDoc | null> {
    const guest = await this.eligible(userId)
    if (!guest) return null
    return users().findOneAndUpdate({ _id: guest._id, guest: true, guest_merge_target: { $exists: false }, guest_purging: { $ne: true } }, {
      $set: { ...identity, providers: [provider], signed_up_at: guest.signed_up_at ?? new Date(), updated_at: new Date() },
      $unset: { guest: '', guest_turns: '', install_id: '' },
    }, { returnDocument: 'after' })
  },

  async merge(userId: string | undefined, target: UserDoc): Promise<UserDoc> {
    const guest = await this.eligible(userId)
    if (!guest || guest._id.equals(target._id)) return target
    if (target.guest || target.account_status === 'banned') throw new HttpError(403, 'Sign in to continue.')
    // Bind once, before moving any data. A retry can only finish this destination.
    const fenced = await users().findOneAndUpdate({ _id: guest._id, guest: true, guest_purging: { $ne: true },
      $or: [{ guest_merge_target: { $exists: false } }, { guest_merge_target: target._id }],
    }, { $set: { guest_merge_target: target._id } }, { returnDocument: 'after' })
    if (!fenced) throw new HttpError(409, 'Your story is being saved. Please try again.', { code: 'guest_transfer_pending' })
    const { getGenerationQueue, getMediaQueue, getMemoryCurationQueue, getSceneSummaryQueue, getMaintenanceQueue } = await import('../queues')
    const { moveAccountReferences, relinkJobData } = await import('./account-references')
    const { accountTransaction } = await import('../config/mongo')
    const from = guest._id.toHexString(), to = target._id.toHexString()
    if (await hasGuestRequests(from)) throw new HttpError(409, 'Your story is being saved. Please try again.', { code: 'guest_transfer_pending' })
    const instances = await mongoColl.worldInstances().find({ player_id: guest._id }).toArray()
    const queues = [getGenerationQueue(), getMediaQueue(), getMemoryCurationQueue(), getSceneSummaryQueue(), getMaintenanceQueue()]
    // Running or queued work must finish with its original owner before the move.
    // The durable fence rejects new authenticated guest work, including sockets.
    for (const queue of queues) {
      const jobs = await queue.getJobs(['active', 'waiting', 'delayed', 'paused', 'prioritized', 'waiting-children'])
      if (jobs.some(job => job && JSON.stringify(job.data) !== JSON.stringify(relinkJobData(job.data, from, to)))) {
        throw new HttpError(409, 'Your story is still settling. Please try again.', { code: 'guest_transfer_pending' })
      }
    }
    for (const instance of instances) {
      if (await getRedisClient().get(`lock:gen:${from}:${instance._id}`)) {
        throw new HttpError(409, 'Your story is still settling. Please try again.', { code: 'guest_transfer_pending' })
      }
      await getRedisClient().del(`session:${instance._id}`)
    }
    const transfer = await closeGuestRequests(from)
    if (!transfer) throw new HttpError(409, 'Your story is being saved. Please try again.', { code: 'guest_transfer_pending' })
    try {
      await accountTransaction(async session => {
        const opts = { session }
        // This write also makes concurrent transactions conflict on the source.
        const source = await users().findOneAndUpdate({ _id: guest._id, guest: true, guest_merge_target: target._id },
          { $set: { updated_at: new Date() } }, { ...opts, returnDocument: 'after' })
        if (!source) return
        if (source.age_confirmed_at) {
          await users().updateOne({ _id: target._id, age_confirmed_at: { $exists: false } },
            { $set: { age_confirmed_at: source.age_confirmed_at } }, opts)
        }
        if (source.preferences.interests?.length) {
          await users().updateOne({ _id: target._id, $or: [
            { 'preferences.interests': { $exists: false } }, { 'preferences.interests': { $size: 0 } },
          ] }, { $set: { 'preferences.interests': source.preferences.interests } }, opts)
        }
        if (source.blocked_user_ids?.length || source.blocked_template_ids?.length) {
          await users().updateOne({ _id: target._id }, { $addToSet: {
            ...(source.blocked_user_ids?.length ? { blocked_user_ids: { $each: source.blocked_user_ids.filter(id => !id.equals(target._id)) } } : {}),
            ...(source.blocked_template_ids?.length ? { blocked_template_ids: { $each: source.blocked_template_ids } } : {}),
          } }, opts)
        }
        await moveAccountReferences(guest._id, target._id, session)
        await mongoColl.guestMerges().updateOne({ _id: source._id }, { $setOnInsert: {
          guest_id: source._id, target_id: target._id,
          guest_started_at: source.guest_started_at ?? source.created_at, merged_at: new Date(),
        } }, { ...opts, upsert: true })
        await users().deleteOne({ _id: guest._id, guest: true, guest_merge_target: target._id }, opts)
      })
    } finally {
      await reopenGuestRequests(from, transfer)
    }
    return (await users().findOne({ _id: target._id }))!
  },
}
