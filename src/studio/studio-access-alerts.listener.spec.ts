import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ACCESS_GRANTED_ALERT_SQL,
  StudioAccessAlertsListener,
} from './studio-access-alerts.listener';

const MEMBER = 'fa000000-0000-4000-8000-000000000001';

describe('StudioAccessAlertsListener', () => {
  let query: jest.Mock;
  let notifications: { createForRecipients: jest.Mock };
  let listener: StudioAccessAlertsListener;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([{ user_id: MEMBER }]);
    notifications = {
      createForRecipients: jest.fn().mockResolvedValue([]),
    };
    listener = new StudioAccessAlertsListener(
      { query } as unknown as DataSource,
      notifications as unknown as NotificationsService,
    );
  });

  it('sends the grant notice to the member while the grant stands, with an empty payload', async () => {
    await listener.onAccessGranted({ userId: MEMBER });

    expect(query).toHaveBeenCalledWith(ACCESS_GRANTED_ALERT_SQL, [MEMBER]);
    expect(notifications.createForRecipients.mock.calls).toEqual([
      [[MEMBER], NotificationType.StudioAccessGranted, {}],
    ]);
  });

  it('sends nothing for a revoked grant or an inactive member', async () => {
    query.mockResolvedValue([]);

    await listener.onAccessGranted({ userId: MEMBER });

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
    expect(ACCESS_GRANTED_ALERT_SQL).toContain('"studio_access_grants"');
    expect(ACCESS_GRANTED_ALERT_SQL).toContain(
      `"member_account"."status" = 'active'`,
    );
  });

  it('logs and swallows a failed send', async () => {
    notifications.createForRecipients.mockRejectedValue(
      new Error('connection reset'),
    );

    await expect(
      listener.onAccessGranted({ userId: MEMBER }),
    ).resolves.toBeUndefined();
  });
});
