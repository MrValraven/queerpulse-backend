import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  PURCHASE_ALERT_RECIPIENTS_SQL,
  PURCHASE_ALERT_SQL,
  StudioPurchaseAlertsListener,
} from './studio-purchase-alerts.listener';

const PURCHASE_ID = 'purchase-0000-4000-8000-000000000001';
const PERSONA_ID = 'persona-0000-4000-8000-000000000002';
const BUYER_ID = 'buyer-0000-4000-8000-000000000003';

interface AlertRowFixture {
  purchase_id: string;
  subprofile_id: string | null;
  buyer_user_id: string | null;
  artist_name: string;
  item_kind: string;
  item_title: string;
  amount_cents: number;
  decline_reason: string | null;
}

const alertRow: AlertRowFixture = {
  purchase_id: PURCHASE_ID,
  subprofile_id: PERSONA_ID,
  buyer_user_id: BUYER_ID,
  artist_name: 'Night Shift',
  item_kind: 'release',
  item_title: 'Lisbon at four',
  amount_cents: 700,
  decline_reason: null,
};

describe('StudioPurchaseAlertsListener', () => {
  let query: jest.Mock;
  let notifications: { createForRecipients: jest.Mock };
  let warnSpy: jest.SpyInstance;
  let listener: StudioPurchaseAlertsListener;

  function answerWith(row: Partial<AlertRowFixture> | null): void {
    query.mockImplementation((sql: string) => {
      if (sql === PURCHASE_ALERT_SQL) {
        return Promise.resolve(row ? [{ ...alertRow, ...row }] : []);
      }
      return Promise.resolve([
        { user_id: 'member-1' },
        { user_id: 'member-2' },
      ]);
    });
  }

  beforeEach(() => {
    query = jest.fn();
    answerWith({});
    notifications = {
      createForRecipients: jest.fn().mockResolvedValue([]),
    };
    listener = new StudioPurchaseAlertsListener(
      { query } as unknown as DataSource,
      notifications as unknown as NotificationsService,
    );
    warnSpy = jest
      .spyOn(
        (listener as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('tells every granted persona member about a claim with no actor', async () => {
    await listener.handleClaimed({ purchaseId: PURCHASE_ID });

    expect(query).toHaveBeenCalledWith(PURCHASE_ALERT_SQL, [
      PURCHASE_ID,
      'pending',
    ]);
    expect(query).toHaveBeenCalledWith(PURCHASE_ALERT_RECIPIENTS_SQL, [
      PERSONA_ID,
    ]);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['member-1', 'member-2'],
      NotificationType.StudioPurchaseClaimed,
      {
        purchaseId: PURCHASE_ID,
        subprofileId: PERSONA_ID,
        artistName: 'Night Shift',
        itemKind: 'release',
        itemTitle: 'Lisbon at four',
        amountCents: 700,
      },
    );
    expect(notifications.createForRecipients.mock.calls[0]).toHaveLength(3);
  });

  it('tells the buyer about a confirmation, a decline with its reason and an expiry', async () => {
    await listener.handleConfirmed({ purchaseId: PURCHASE_ID });
    answerWith({ decline_reason: 'amount_different' });
    await listener.handleDeclined({ purchaseId: PURCHASE_ID });
    answerWith({});
    await listener.handleExpired({ purchaseId: PURCHASE_ID });

    expect(query).toHaveBeenCalledWith(PURCHASE_ALERT_SQL, [
      PURCHASE_ID,
      'confirmed',
    ]);
    expect(query).toHaveBeenCalledWith(PURCHASE_ALERT_SQL, [
      PURCHASE_ID,
      'declined',
    ]);
    expect(query).toHaveBeenCalledWith(PURCHASE_ALERT_SQL, [
      PURCHASE_ID,
      'expired',
    ]);
    const common = {
      purchaseId: PURCHASE_ID,
      artistName: 'Night Shift',
      itemKind: 'release',
      itemTitle: 'Lisbon at four',
    };
    expect(notifications.createForRecipients.mock.calls).toEqual([
      [[BUYER_ID], NotificationType.StudioPurchaseConfirmed, common],
      [
        [BUYER_ID],
        NotificationType.StudioPurchaseDeclined,
        { ...common, declineReason: 'amount_different' },
      ],
      [[BUYER_ID], NotificationType.StudioPurchaseExpired, common],
    ]);
  });

  it('sends nothing once the purchase left the status the event names', async () => {
    answerWith(null);
    await listener.handleClaimed({ purchaseId: PURCHASE_ID });
    await listener.handleConfirmed({ purchaseId: PURCHASE_ID });
    await listener.handleDeclined({ purchaseId: PURCHASE_ID });
    await listener.handleExpired({ purchaseId: PURCHASE_ID });
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
    expect(PURCHASE_ALERT_SQL).toContain(`"purchase"."status"::text = $2`);
  });

  it('sends nothing to an erased buyer', async () => {
    answerWith({ buyer_user_id: null });
    await listener.handleConfirmed({ purchaseId: PURCHASE_ID });
    await listener.handleExpired({ purchaseId: PURCHASE_ID });
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('sends nothing for a claim whose persona is gone', async () => {
    answerWith({ subprofile_id: null });
    await listener.handleClaimed({ purchaseId: PURCHASE_ID });
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('reads every granted member with no actor filter and the live names with a snapshot fallback', () => {
    expect(PURCHASE_ALERT_RECIPIENTS_SQL).toContain('"studio_access_grants"');
    expect(PURCHASE_ALERT_RECIPIENTS_SQL).toContain(
      'ORDER BY "member"."user_id" ASC',
    );
    expect(PURCHASE_ALERT_RECIPIENTS_SQL).not.toContain('<> $');
    expect(PURCHASE_ALERT_SQL).toContain(
      `COALESCE(NULLIF(btrim("persona"."display_name"), ''), "persona"."handle", "purchase"."artist_name")`,
    );
    expect(PURCHASE_ALERT_SQL).toContain(
      `COALESCE("release"."title", "track"."title", "purchase"."item_title")`,
    );
  });

  it('logs a failed alert with the error class and code only', async () => {
    query.mockRejectedValue(
      Object.assign(
        new Error(
          'Key (reference_code)=(QP7K3F) PT50000201231234567890154 purchase-0000 Night Shift',
        ),
        { code: '23505' },
      ),
    );
    await expect(
      listener.handleClaimed({ purchaseId: PURCHASE_ID }),
    ).resolves.toBeUndefined();

    const logged = warnSpy.mock.calls.flat().join(' ');
    expect(logged).toBe('Studio purchase alert failed: Error (code 23505)');
    expect(logged).not.toMatch(/QP7K3F|PT50|purchase-|Night Shift/);
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });
});
