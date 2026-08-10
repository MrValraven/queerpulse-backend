import {
  Notification,
  NotificationType,
} from '../notifications/entities/notification.entity';
import { NotificationBatchCreatedEvent } from '../notifications/notification.events';
import { PushNotificationListener } from './push-notification.listener';
import { PushPayload } from './push.service';

const NOTIFICATION_CREATED_AT = new Date('2026-01-15T12:00:00.000Z');

function makeNotification(
  type: NotificationType,
  payload: Record<string, unknown> = {},
): Notification {
  return {
    id: 'notif-1',
    userId: 'recipient-1',
    type,
    payload,
    read: false,
    createdAt: NOTIFICATION_CREATED_AT,
  };
}

function build(opts: {
  // Which categories are DISABLED for the recipients (empty = everything on).
  pushDisabledCategories?: string[];
  // The actor profile `resolveActor` finds (undefined = no matching profile).
  actorProfile?: {
    userId: string;
    firstName: string;
    lastName: string;
    slug: string;
    avatarUrl: string | null;
  } | null;
}) {
  const profilesRepo = {
    findOne: jest.fn().mockResolvedValue(opts.actorProfile ?? null),
  };
  const push = { sendToUsers: jest.fn().mockResolvedValue(undefined) };
  // Echoes back whichever of the input userIds are still enabled — in the
  // real service this is one batched `IN (...)` query for the whole list, not
  // one call per recipient (that's exactly the N+1 this listener now avoids).
  const notificationPreferences = {
    recipientsPushEnabled: jest
      .fn()
      .mockImplementation((userIds: string[], category: string) =>
        Promise.resolve(
          (opts.pushDisabledCategories ?? []).includes(category) ? [] : userIds,
        ),
      ),
  };
  const listener = new PushNotificationListener(
    profilesRepo as never,
    push as never,
    notificationPreferences as never,
  );
  return { listener, push, notificationPreferences, profilesRepo };
}

function emit(
  notification: Notification,
  userIds: string[] = ['recipient-1'],
): NotificationBatchCreatedEvent {
  return {
    userIds,
    type: notification.type,
    payload: notification.payload,
    actorId: null,
    notification,
  };
}

const ACTOR = {
  userId: 'actor-1',
  firstName: 'Ana',
  lastName: 'Silva',
  slug: 'ana-silva',
  avatarUrl: 'https://lh3.googleusercontent.com/a/ana.png',
};

describe('PushNotificationListener', () => {
  it('pushes a ConnectionRequest: Connections-gated, correct l10n keys + data.url', async () => {
    const { listener, push, notificationPreferences } = build({
      actorProfile: ACTOR,
    });
    await listener.handleNotificationBatchCreated(
      emit(
        makeNotification(NotificationType.ConnectionRequest, {
          connectionId: 'c1',
          fromUserId: 'actor-1',
        }),
      ),
    );
    // Gated on the Connections category.
    expect(notificationPreferences.recipientsPushEnabled).toHaveBeenCalledWith(
      ['recipient-1'],
      'connections',
    );
    expect(push.sendToUsers).toHaveBeenCalledTimes(1);
    const [userIds, payload] = push.sendToUsers.mock.calls[0] as [
      string[],
      PushPayload,
    ];
    expect(userIds).toEqual(['recipient-1']);
    expect(payload.l10n).toEqual({
      titleKey: 'push:connection.request.title',
      bodyKey: 'push:connection.request.body',
      params: { name: 'Ana Silva' },
    });
    // Deep-links to the actor's profile; carries the public https avatar icon.
    expect(payload.data.url).toBe('/members/ana-silva');
    expect(payload.icon).toBe('https://lh3.googleusercontent.com/a/ana.png');
    // English fallback is always set for iOS / missing catalog.
    expect(payload.title).toBe('New connection request');
    expect(payload.body).toBe('Ana Silva wants to connect with you.');
    // The notification's own createdAt, not delivery time.
    expect(payload.timestamp).toBe(NOTIFICATION_CREATED_AT.getTime());
  });

  it('does not push a ConnectionRequest when the Connections category is off', async () => {
    const { listener, push } = build({
      actorProfile: ACTOR,
      pushDisabledCategories: ['connections'],
    });
    await listener.handleNotificationBatchCreated(
      emit(
        makeNotification(NotificationType.ConnectionRequest, {
          fromUserId: 'actor-1',
        }),
      ),
    );
    expect(push.sendToUsers).not.toHaveBeenCalled();
  });

  it('pushes a Mention gated on the Mentions category, deep-linking the thread', async () => {
    const { listener, push, notificationPreferences } = build({
      actorProfile: ACTOR,
    });
    await listener.handleNotificationBatchCreated(
      emit(
        makeNotification(NotificationType.Mention, {
          actorId: 'actor-1',
          source: 'forum',
          threadSlug: 'trans-joy',
        }),
      ),
    );
    expect(notificationPreferences.recipientsPushEnabled).toHaveBeenCalledWith(
      ['recipient-1'],
      'mentions',
    );
    const [, payload] = push.sendToUsers.mock.calls[0] as [
      string[],
      PushPayload,
    ];
    expect(payload.l10n?.titleKey).toBe('push:mention.title');
    expect(payload.data.url).toBe('/thread/trans-joy');
    expect(payload.timestamp).toBe(NOTIFICATION_CREATED_AT.getTime());
  });

  it('does not push a Mention when the Mentions category is off', async () => {
    const { listener, push } = build({
      actorProfile: ACTOR,
      pushDisabledCategories: ['mentions'],
    });
    await listener.handleNotificationBatchCreated(
      emit(
        makeNotification(NotificationType.Mention, {
          actorId: 'actor-1',
          source: 'forum',
          threadSlug: 'trans-joy',
        }),
      ),
    );
    expect(push.sendToUsers).not.toHaveBeenCalled();
  });

  it('pushes a VouchReceived gated on the Vouches category, deep-linking the voucher', async () => {
    const { listener, push, notificationPreferences } = build({
      actorProfile: { ...ACTOR, slug: 'voucher-x' },
    });
    await listener.handleNotificationBatchCreated(
      emit(
        makeNotification(NotificationType.VouchReceived, {
          voucherId: 'actor-1',
        }),
      ),
    );
    expect(notificationPreferences.recipientsPushEnabled).toHaveBeenCalledWith(
      ['recipient-1'],
      'vouches',
    );
    const [, payload] = push.sendToUsers.mock.calls[0] as [
      string[],
      PushPayload,
    ];
    expect(payload.l10n?.titleKey).toBe('push:vouch.received.title');
    expect(payload.data.url).toBe('/members/voucher-x');
    expect(payload.timestamp).toBe(NOTIFICATION_CREATED_AT.getTime());
  });

  it('pushes a SafeSpaceVouch gated on the Vouches category, naming the voucher + space and deep-linking the space', async () => {
    const { listener, push, notificationPreferences } = build({
      actorProfile: { ...ACTOR, slug: 'voucher-x' },
    });
    await listener.handleNotificationBatchCreated(
      emit(
        makeNotification(NotificationType.SafeSpaceVouch, {
          spaceId: 'space-1',
          spaceName: 'Casa Aberta',
          spaceSlug: 'casa-aberta',
          voucherId: 'actor-1',
        }),
      ),
    );
    // Shares the Vouches category with member vouches.
    expect(notificationPreferences.recipientsPushEnabled).toHaveBeenCalledWith(
      ['recipient-1'],
      'vouches',
    );
    const [userIds, payload] = push.sendToUsers.mock.calls[0] as [
      string[],
      PushPayload,
    ];
    expect(userIds).toEqual(['recipient-1']);
    expect(payload.l10n).toEqual({
      titleKey: 'push:safeSpace.vouch.title',
      bodyKey: 'push:safeSpace.vouch.body',
      params: { name: 'Ana Silva', space: 'Casa Aberta' },
    });
    // Deep-links to the space's detail page via its slug.
    expect(payload.data.url).toBe('/local/directory/casa-aberta');
    // English fallback is always set for iOS / missing catalog.
    expect(payload.title).toBe('New vouch for your safe space');
    expect(payload.body).toBe('Ana Silva vouched for Casa Aberta.');
    expect(payload.timestamp).toBe(NOTIFICATION_CREATED_AT.getTime());
  });

  it('does not push a SafeSpaceVouch when the Vouches category is off', async () => {
    const { listener, push } = build({
      actorProfile: ACTOR,
      pushDisabledCategories: ['vouches'],
    });
    await listener.handleNotificationBatchCreated(
      emit(
        makeNotification(NotificationType.SafeSpaceVouch, {
          spaceName: 'Casa Aberta',
          spaceSlug: 'casa-aberta',
          voucherId: 'actor-1',
        }),
      ),
    );
    expect(push.sendToUsers).not.toHaveBeenCalled();
  });

  it('renders an anonymous SafeSpaceVouch as "Someone" (no voucherId in payload)', async () => {
    const { listener, push } = build({ actorProfile: ACTOR });
    await listener.handleNotificationBatchCreated(
      emit(
        makeNotification(NotificationType.SafeSpaceVouch, {
          spaceName: 'Casa Aberta',
          spaceSlug: 'casa-aberta',
        }),
      ),
    );
    const [, payload] = push.sendToUsers.mock.calls[0] as [
      string[],
      PushPayload,
    ];
    expect(payload.l10n?.params).toEqual({
      name: 'Someone',
      space: 'Casa Aberta',
    });
    expect(payload.body).toBe('Someone vouched for Casa Aberta.');
    // No resolvable actor -> no avatar icon.
    expect(payload).not.toHaveProperty('icon');
  });

  it('pushes an EventCancelled with NO category gate (always-on) and the event slug/title', async () => {
    const { listener, push, notificationPreferences } = build({});
    await listener.handleNotificationBatchCreated(
      emit(
        makeNotification(NotificationType.EventCancelled, {
          eventId: 'e1',
          eventSlug: 'trivia-night',
          title: 'Trivia Night',
        }),
      ),
    );
    // Always-on: never consults the preference gate.
    expect(
      notificationPreferences.recipientsPushEnabled,
    ).not.toHaveBeenCalled();
    const [, payload] = push.sendToUsers.mock.calls[0] as [
      string[],
      PushPayload,
    ];
    expect(payload.l10n).toEqual({
      titleKey: 'push:event.cancelled.title',
      bodyKey: 'push:event.cancelled.body',
      params: { event: 'Trivia Night' },
    });
    expect(payload.data.url).toBe('/events/trivia-night');
    // No actor for event system pushes -> no icon.
    expect(payload).not.toHaveProperty('icon');
    // The notification's own createdAt, not delivery time.
    expect(payload.timestamp).toBe(NOTIFICATION_CREATED_AT.getTime());
  });

  it('omits the icon when the actor has no public https avatar (storage key)', async () => {
    const { listener, push } = build({
      actorProfile: {
        ...ACTOR,
        avatarUrl: 'avatars/11111111-1111-1111-1111-111111111111/22222222.jpg',
      },
    });
    await listener.handleNotificationBatchCreated(
      emit(
        makeNotification(NotificationType.ConnectionAccepted, {
          byUserId: 'actor-1',
        }),
      ),
    );
    const [, payload] = push.sendToUsers.mock.calls[0] as [
      string[],
      PushPayload,
    ];
    expect(payload).not.toHaveProperty('icon');
  });

  // The two load-bearing whitelist exclusions: both already push elsewhere, so
  // handling them here would double-send. They must produce NO push.
  it('does NOT push a NewMessage (already pushed by push.listener.ts)', async () => {
    const { listener, push, notificationPreferences } = build({});
    await listener.handleNotificationBatchCreated(
      emit(
        makeNotification(NotificationType.NewMessage, {
          conversationId: 'conv-1',
        }),
      ),
    );
    expect(push.sendToUsers).not.toHaveBeenCalled();
    expect(
      notificationPreferences.recipientsPushEnabled,
    ).not.toHaveBeenCalled();
  });

  it('does NOT push an EventReminder (already pushed by event-reminders.service.ts)', async () => {
    const { listener, push, notificationPreferences } = build({});
    await listener.handleNotificationBatchCreated(
      emit(
        makeNotification(NotificationType.EventReminder, {
          eventId: 'e1',
          eventSlug: 'trivia-night',
        }),
      ),
    );
    expect(push.sendToUsers).not.toHaveBeenCalled();
    expect(
      notificationPreferences.recipientsPushEnabled,
    ).not.toHaveBeenCalled();
  });

  it('never throws when a resolver fails (best-effort)', async () => {
    const { listener, push } = build({ actorProfile: ACTOR });
    push.sendToUsers.mockRejectedValueOnce(new Error('boom'));
    await expect(
      listener.handleNotificationBatchCreated(
        emit(
          makeNotification(NotificationType.ConnectionRequest, {
            fromUserId: 'actor-1',
          }),
        ),
      ),
    ).resolves.toBeUndefined();
  });

  // The B11 fix: a many-recipient fan-out (e.g. an event update fanned to
  // every RSVP + invite) must collapse to ONE preference query, ONE actor
  // lookup, and ONE `sendToUsers` call — not one of each per recipient.
  it('batches a many-recipient fan-out into one preference query, one actor lookup, and one sendToUsers call', async () => {
    const { listener, push, notificationPreferences, profilesRepo } = build({
      actorProfile: ACTOR,
    });
    const recipientUserIds = ['recipient-1', 'recipient-2', 'recipient-3'];
    await listener.handleNotificationBatchCreated(
      emit(
        makeNotification(NotificationType.Mention, {
          actorId: 'actor-1',
          source: 'forum',
          threadSlug: 'trans-joy',
        }),
        recipientUserIds,
      ),
    );
    expect(notificationPreferences.recipientsPushEnabled).toHaveBeenCalledTimes(
      1,
    );
    expect(notificationPreferences.recipientsPushEnabled).toHaveBeenCalledWith(
      recipientUserIds,
      'mentions',
    );
    expect(profilesRepo.findOne).toHaveBeenCalledTimes(1);
    expect(push.sendToUsers).toHaveBeenCalledTimes(1);
    const [userIds] = push.sendToUsers.mock.calls[0] as [string[], PushPayload];
    expect(userIds).toEqual(recipientUserIds);
  });

  it('an always-on EventUpdated fan-out sends one push to every recipient with no preference query', async () => {
    const { listener, push, notificationPreferences } = build({});
    const recipientUserIds = ['recipient-1', 'recipient-2', 'recipient-3'];
    await listener.handleNotificationBatchCreated(
      emit(
        makeNotification(NotificationType.EventUpdated, {
          eventId: 'e1',
          eventSlug: 'trivia-night',
          title: 'Trivia Night',
        }),
        recipientUserIds,
      ),
    );
    expect(
      notificationPreferences.recipientsPushEnabled,
    ).not.toHaveBeenCalled();
    expect(push.sendToUsers).toHaveBeenCalledTimes(1);
    const [userIds] = push.sendToUsers.mock.calls[0] as [string[], PushPayload];
    expect(userIds).toEqual(recipientUserIds);
  });
});
