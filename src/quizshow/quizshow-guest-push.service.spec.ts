import type { DataSource } from 'typeorm';
import { QuizshowGuestPushService } from './quizshow-guest-push.service';
import { NotificationPreferenceCategory } from '../notifications/notification-preferences';

const INPUT = {
  eventId: 'event-1',
  eventTitle: 'Drag Bingo',
  hostUserId: 'host-1',
  sessionId: 'session-1',
  joinCode: 'ABC234',
  startedAt: new Date('2026-10-19T20:00:00.000Z'),
};

function build() {
  const dataSource = { query: jest.fn() };
  const notificationPreferences = { recipientsPushEnabled: jest.fn() };
  const notificationDelivery = { recipientsOutsideQuietHours: jest.fn() };
  const previewPrivacy = { sendSplitByPreviewPreference: jest.fn() };
  notificationPreferences.recipientsPushEnabled.mockImplementation(
    (userIds: string[]) => Promise.resolve(userIds),
  );
  notificationDelivery.recipientsOutsideQuietHours.mockImplementation(
    (userIds: string[]) => Promise.resolve(userIds),
  );
  previewPrivacy.sendSplitByPreviewPreference.mockResolvedValue(undefined);
  const service = new QuizshowGuestPushService(
    dataSource as unknown as DataSource,
    notificationPreferences as never,
    notificationDelivery as never,
    previewPrivacy as never,
  );
  return {
    service,
    dataSource,
    notificationPreferences,
    notificationDelivery,
    previewPrivacy,
  };
}

describe('QuizshowGuestPushService', () => {
  it('pushes going guests with the code and the play link', async () => {
    const { service, dataSource, previewPrivacy } = build();
    dataSource.query.mockResolvedValue([
      { user_id: 'guest-1' },
      { user_id: 'guest-2' },
    ]);

    await service.sendLobbyOpened(INPUT);

    expect(previewPrivacy.sendSplitByPreviewPreference).toHaveBeenCalledWith(
      ['guest-1', 'guest-2'],
      {
        title: 'Pulse Live is starting',
        body: 'Drag Bingo live game is starting, join with code ABC234',
        tag: 'quizshow:session-1',
        data: { url: '/play/ABC234' },
        timestamp: INPUT.startedAt.getTime(),
        l10n: {
          titleKey: 'push:quizshow.starting.title',
          bodyKey: 'push:quizshow.starting.body',
          params: { event: 'Drag Bingo', code: 'ABC234' },
        },
      },
    );
  });

  it('leaves out organisers, barred members and blocked members', async () => {
    const { service, dataSource, previewPrivacy } = build();
    dataSource.query.mockResolvedValue([{ user_id: 'guest-1' }]);

    await service.sendLobbyOpened(INPUT);

    const [sql, parameters] = dataSource.query.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(parameters).toEqual(['event-1', 'host-1']);
    expect(sql).toContain('"event_rsvps"');
    expect(sql).toContain(`"rsvp"."status" = 'going'`);
    expect(sql).toContain('"event_cohosts"');
    expect(sql).toContain('"event_bans"');
    expect(sql).toContain('"blocks"');
    expect(sql).toContain('"block"."blocker_id" = $2::uuid');
    expect(sql).toContain('"block"."blocked_id" = $2::uuid');
    const sentUserIds = previewPrivacy.sendSplitByPreviewPreference.mock
      .calls[0][0] as string[];
    expect(sentUserIds).toEqual(['guest-1']);
    expect(sentUserIds).not.toContain('host-1');
  });

  it('honours the push switch and quiet hours', async () => {
    const {
      service,
      dataSource,
      notificationPreferences,
      notificationDelivery,
      previewPrivacy,
    } = build();
    dataSource.query.mockResolvedValue([
      { user_id: 'guest-1' },
      { user_id: 'guest-2' },
      { user_id: 'guest-3' },
    ]);
    notificationPreferences.recipientsPushEnabled.mockResolvedValue([
      'guest-1',
      'guest-2',
    ]);
    notificationDelivery.recipientsOutsideQuietHours.mockResolvedValue([
      'guest-2',
    ]);

    await service.sendLobbyOpened(INPUT);

    expect(notificationPreferences.recipientsPushEnabled).toHaveBeenCalledWith(
      ['guest-1', 'guest-2', 'guest-3'],
      NotificationPreferenceCategory.Quizshow,
    );
    expect(
      notificationDelivery.recipientsOutsideQuietHours,
    ).toHaveBeenCalledWith(['guest-1', 'guest-2']);
    expect(previewPrivacy.sendSplitByPreviewPreference).toHaveBeenCalledWith(
      ['guest-2'],
      expect.objectContaining({ tag: 'quizshow:session-1' }),
    );

    previewPrivacy.sendSplitByPreviewPreference.mockClear();
    notificationDelivery.recipientsOutsideQuietHours.mockResolvedValue([]);
    await service.sendLobbyOpened(INPUT);
    expect(previewPrivacy.sendSplitByPreviewPreference).not.toHaveBeenCalled();
  });

  it('sends nothing and throws nothing when the lookups fail', async () => {
    const { service, dataSource, previewPrivacy } = build();
    dataSource.query.mockRejectedValue(new Error('database down'));

    await expect(service.sendLobbyOpened(INPUT)).resolves.toBeUndefined();

    expect(previewPrivacy.sendSplitByPreviewPreference).not.toHaveBeenCalled();
  });

  it('reports the cooldown over when no push went out for the event in two hours', async () => {
    const { service, dataSource } = build();
    const now = new Date('2026-10-19T20:00:00.000Z');
    dataSource.query.mockResolvedValueOnce([{ has_recent_push: false }]);

    await expect(service.isCooldownOver('event-1', now)).resolves.toBe(true);

    const [, parameters] = dataSource.query.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(parameters).toEqual([
      'event-1',
      new Date('2026-10-19T18:00:00.000Z'),
    ]);

    dataSource.query.mockResolvedValueOnce([{ has_recent_push: true }]);
    await expect(service.isCooldownOver('event-1', now)).resolves.toBe(false);
  });
});
