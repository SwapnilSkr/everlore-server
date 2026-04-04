import { mongoColl } from '../config/mongo'
import type { UserTier } from '../models/user.model'
import { idString, parseObjectId } from '../utils/mongo-id'

export type AdminUserTier = 'free' | 'premium' | 'creator'

const users = () => mongoColl.users()

export const adminService = {
  async listUsers(limit: number) {
    const rows = await users()
      .find(
        {},
        {
          projection: {
            _id: 1,
            username: 1,
            email: 1,
            phone: 1,
            tier: 1,
            created_at: 1,
          },
        },
      )
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray()

    return {
      users: rows.map((u) => ({
        id: idString(u._id),
        username: u.username,
        email: u.email || null,
        phone: u.phone || null,
        tier: u.tier,
        created_at: u.created_at,
      })),
    }
  },

  async getUser(userId: string) {
    return users().findOne(
      { _id: parseObjectId(userId) },
      {
        projection: {
          _id: 1,
          username: 1,
          email: 1,
          phone: 1,
          tier: 1,
          token_balance: 1,
          created_at: 1,
          updated_at: 1,
        },
      },
    )
  },

  async setUserTier(userId: string, tier: AdminUserTier) {
    return users().findOneAndUpdate(
      { _id: parseObjectId(userId) },
      { $set: { tier: tier as UserTier, updated_at: new Date() } },
      { returnDocument: 'after', projection: { password_hash: 0 } },
    )
  },
}
