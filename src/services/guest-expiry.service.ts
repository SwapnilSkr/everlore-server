import { mongoColl } from '../config/mongo'
import { deletionService } from './deletion.service'
import { guestService } from './guest.service'
import { hasGuestRequests } from './guest-requests'

/** Daily maintenance, including recovery of an interrupted identity transfer. */
export async function expireGuests(now = new Date()): Promise<{ deleted: number; resumed: number }> {
  let deleted = 0, resumed = 0
  const users = mongoColl.users()
  for (const source of await users.find({ guest: true, guest_merge_target: { $exists: true } }).toArray()) {
    try {
      const target = await users.findOne({ _id: source.guest_merge_target })
      if (!target) continue
      await guestService.merge(source._id.toHexString(), target)
      resumed++
    } catch {
      console.warn('Guest expiry merge failed', source._id.toHexString(), source.guest_merge_target?.toHexString())
    }
  }
  const cutoff = new Date(now.getTime() - 30 * 86_400_000)
  for (const source of await users.find({ guest: true, created_at: { $lt: cutoff },
    guest_merge_target: { $exists: false }, email: { $exists: false }, phone: { $exists: false }, google_sub: { $exists: false },
  }).toArray()) {
    try {
      const fenced = await users.findOneAndUpdate({ _id: source._id, guest: true,
        guest_merge_target: { $exists: false }, email: { $exists: false }, phone: { $exists: false }, google_sub: { $exists: false },
      }, { $set: { guest_purging: true } }, { returnDocument: 'after' })
      if (!fenced || await hasGuestRequests(source._id.toHexString())) continue
      await deletionService.deleteAccount(source._id.toHexString())
      deleted++
    } catch {
      console.warn('Guest expiry purge failed', source._id.toHexString())
    }
  }
  return { deleted, resumed }
}
