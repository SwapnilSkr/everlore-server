import { coll } from '../config/mongo'

export type AdminUserTier = 'free' | 'premium' | 'creator'

export const adminService = {
  async listUsers(limit: number) {
    const users = await coll('users')
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
      users: users.map((u) => ({
        id: u._id,
        username: u.username,
        email: u.email || null,
        phone: u.phone || null,
        tier: u.tier,
        created_at: u.created_at,
      })),
    }
  },

  async getUser(userId: string) {
    return coll('users').findOne(
      { _id: userId },
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
    return coll('users').findOneAndUpdate(
      { _id: userId },
      { $set: { tier, updated_at: new Date() } },
      { returnDocument: 'after', projection: { password_hash: 0 } },
    )
  },
}
