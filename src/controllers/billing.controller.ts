import type { AuthUser } from '../middleware/auth'
import { HttpError } from '../utils/http-error'
import { billingService } from '../services/billing.service'

export const billingController = {
  catalog: () => billingService.catalog(),
  me: async ({ user }: { user: AuthUser | null }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return billingService.wallet(user.id, user.tier)
  },
  verifyGoogle: async ({
    user,
    body,
  }: {
    user: AuthUser | null
    body: { product_id: string; purchase_token: string; kind: 'subscription' | 'consumable' }
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return billingService.verifyGooglePurchase(user.id, body)
  },
  simulatePurchase: async ({
    user,
    body,
  }: {
    user: AuthUser | null
    body: { product_id: string; idempotency_key: string }
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return billingService.simulatePurchase(user.id, {
      productId: body.product_id,
      idempotencyKey: body.idempotency_key,
    })
  },
  googleRtdn: async ({ headers, body }: { headers: Record<string, string | undefined>; body: { message?: { data?: string } } }) => {
    await (await import('../services/google-play.service')).googlePlayService.verifyRtdnBearer(headers.authorization)
    const encoded = body.message?.data
    if (!encoded) throw new HttpError(400, 'RTDN message data is required')
    let event: any
    try {
      event = JSON.parse(Buffer.from(encoded, 'base64').toString())
    } catch {
      throw new HttpError(400, 'RTDN message data is invalid')
    }
    const subscription = event.subscriptionNotification
    const oneTime = event.oneTimeProductNotification
    if (subscription?.purchaseToken && subscription.subscriptionId) {
      return billingService.syncGoogleNotification({ product_id: subscription.subscriptionId, purchase_token: subscription.purchaseToken, kind: 'subscription' })
    }
    if (oneTime?.purchaseToken && oneTime.sku) {
      return billingService.syncGoogleNotification({ product_id: oneTime.sku, purchase_token: oneTime.purchaseToken, kind: 'consumable' })
    }
    const voided = event.voidedPurchaseNotification
    if (voided?.purchaseToken) {
      return billingService.voidGooglePurchase(voided.purchaseToken)
    }
    return { accepted: true, linked: false }
  },
}
