import { PushSubscription } from './entities/push-subscription.entity';

/**
 * One push subscription (device) as returned by `GET /push/subscriptions`.
 *
 * Deliberately excludes `endpoint`, `p256dh`, and `auth` — those are the
 * secret Web Push credentials this backend uses to send to the device, not
 * data a member needs to recognise it. Matches the frontend's
 * `PushSubscriptionResponse` in `features/push/push.api.ts`.
 */
export interface PushSubscriptionResponse {
  id: string;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export function toPushSubscriptionResponse(
  subscription: PushSubscription,
): PushSubscriptionResponse {
  return {
    id: subscription.id,
    userAgent: subscription.userAgent,
    createdAt: subscription.createdAt.toISOString(),
    lastUsedAt: subscription.lastUsedAt
      ? subscription.lastUsedAt.toISOString()
      : null,
  };
}
