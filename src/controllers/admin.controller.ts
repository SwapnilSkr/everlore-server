import { adminService } from '../services/admin.service'
import { idString } from '../utils/mongo-id'

export const adminController = {
  listUsers: async ({ query }: { query: { limit?: number } }) => {
    const limit = query.limit ?? 50
    return adminService.listUsers(limit)
  },

  getUser: async ({ params, set }: { params: { userId: string }; set: { status?: unknown } }) => {
    const user = await adminService.getUser(params.userId)
    if (!user) {
      set.status = 404
      return { error: 'User not found' }
    }

    return {
      id: idString(user._id),
      username: user.username,
      email: user.email || null,
      phone: user.phone || null,
      tier: user.tier,
      token_balance: user.token_balance,
      created_at: user.created_at,
      updated_at: user.updated_at,
    }
  },

  patchUserTier: async ({
    params,
    body,
    set,
  }: {
    params: { userId: string }
    body: { tier: 'free' | 'premium' | 'creator' }
    set: { status?: unknown }
  }) => {
    const res = await adminService.setUserTier(params.userId, body.tier)

    if (!res) {
      set.status = 404
      return { error: 'User not found' }
    }

    const u = res
    return {
      user: {
        id: idString(u._id),
        username: u.username,
        email: u.email || null,
        phone: u.phone || null,
        tier: u.tier,
      },
      note: 'Existing JWTs still carry the old tier until the user signs in again.',
    }
  },
}
