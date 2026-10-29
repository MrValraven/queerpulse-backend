import { AddStudioPurchaseNotificationTypes1838000100000 } from '../migrations/1838000100000-AddStudioPurchaseNotificationTypes';
import { Notification, NotificationType } from './entities/notification.entity';
import { bundleKeyFor } from './notification-bundling';
import {
  ALWAYS_DELIVERED_NOTIFICATION_TYPES,
  NotificationPreferenceCategory,
  categoryForType,
} from './notification-preferences';
import { ACTOR_PAYLOAD_KEY, toClientPayload } from './notification-response';

const CLAIMED_PAYLOAD = {
  purchaseId: 'purchase-1',
  subprofileId: 'persona-1',
  artistName: 'Night Shift',
  itemKind: 'release',
  itemTitle: 'Lisbon at four',
  amountCents: 700,
};

const CONFIRMED_PAYLOAD = {
  purchaseId: 'purchase-1',
  artistName: 'Night Shift',
  itemKind: 'release',
  itemTitle: 'Lisbon at four',
};

const DECLINED_PAYLOAD = {
  ...CONFIRMED_PAYLOAD,
  declineReason: 'payment_not_found',
};

const PURCHASE_TYPES = [
  NotificationType.StudioPurchaseClaimed,
  NotificationType.StudioPurchaseConfirmed,
  NotificationType.StudioPurchaseDeclined,
  NotificationType.StudioPurchaseExpired,
];

const BUYER_TYPES = [
  NotificationType.StudioPurchaseConfirmed,
  NotificationType.StudioPurchaseDeclined,
  NotificationType.StudioPurchaseExpired,
];

function notificationRow(
  type: NotificationType,
  payload: Record<string, unknown>,
): Notification {
  return {
    id: 'notification-1',
    userId: 'recipient-1',
    type,
    payload,
    read: false,
    createdAt: new Date('2026-10-28T09:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

describe('Studio purchase notification types', () => {
  it('stores the labels the migration adds', () => {
    expect(PURCHASE_TYPES).toEqual([
      'studio_purchase_claimed',
      'studio_purchase_confirmed',
      'studio_purchase_declined',
      'studio_purchase_expired',
    ]);
  });

  it('puts a claim behind the Personas switch and delivers the three buyer types always', () => {
    expect(categoryForType(NotificationType.StudioPurchaseClaimed)).toBe(
      NotificationPreferenceCategory.Personas,
    );
    expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).not.toContain(
      NotificationType.StudioPurchaseClaimed,
    );
    for (const type of BUYER_TYPES) {
      expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).toContain(type);
    }
  });

  it('bundles claims on the persona and leaves the buyer types unbundled', () => {
    expect(
      bundleKeyFor(NotificationType.StudioPurchaseClaimed, CLAIMED_PAYLOAD),
    ).toBe('studio_purchase_claimed:persona-1');
    expect(
      bundleKeyFor(NotificationType.StudioPurchaseConfirmed, CONFIRMED_PAYLOAD),
    ).toBeNull();
    expect(
      bundleKeyFor(NotificationType.StudioPurchaseDeclined, DECLINED_PAYLOAD),
    ).toBeNull();
    expect(
      bundleKeyFor(NotificationType.StudioPurchaseExpired, CONFIRMED_PAYLOAD),
    ).toBeNull();
  });

  it('names no actor for any of the four types', () => {
    for (const type of PURCHASE_TYPES) {
      expect(ACTOR_PAYLOAD_KEY[type]).toBeUndefined();
    }
  });

  it('sends a claim with the persona id, names, kind, title and amount, and drops the purchase id', () => {
    expect(
      toClientPayload(
        notificationRow(NotificationType.StudioPurchaseClaimed, {
          ...CLAIMED_PAYLOAD,
          buyerUserId: 'member-1',
        }),
      ),
    ).toEqual({
      subprofileId: 'persona-1',
      artistName: 'Night Shift',
      itemKind: 'release',
      itemTitle: 'Lisbon at four',
      amountCents: 700,
    });
  });

  it('sends the buyer types with the purchase id and names, and a decline with its reason', () => {
    const expectedConfirmed = {
      purchaseId: 'purchase-1',
      artistName: 'Night Shift',
      itemKind: 'release',
      itemTitle: 'Lisbon at four',
    };
    expect(
      toClientPayload(
        notificationRow(NotificationType.StudioPurchaseConfirmed, {
          ...CONFIRMED_PAYLOAD,
          buyerUserId: 'member-1',
        }),
      ),
    ).toEqual(expectedConfirmed);
    expect(
      toClientPayload(
        notificationRow(
          NotificationType.StudioPurchaseExpired,
          CONFIRMED_PAYLOAD,
        ),
      ),
    ).toEqual(expectedConfirmed);
    expect(
      toClientPayload(
        notificationRow(NotificationType.StudioPurchaseDeclined, {
          ...DECLINED_PAYLOAD,
          declineNote: 'Sent to the wrong account',
        }),
      ),
    ).toEqual({ ...expectedConfirmed, declineReason: 'payment_not_found' });
  });

  it('adds the four labels outside a transaction and refuses to roll back', async () => {
    const migration = new AddStudioPurchaseNotificationTypes1838000100000();
    const queries: string[] = [];
    const queryRunner = {
      query: (statement: string): Promise<void> => {
        queries.push(statement);
        return Promise.resolve();
      },
    };

    await migration.up(queryRunner as never);

    expect(migration.transaction).toBe(false);
    expect(queries).toEqual([
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_purchase_claimed'`,
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_purchase_confirmed'`,
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_purchase_declined'`,
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_purchase_expired'`,
    ]);
    await expect(migration.down()).rejects.toThrow(/Irreversible/);
  });
});
