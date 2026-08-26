import { Notification, NotificationType } from './entities/notification.entity';
import {
  toClientPayload,
  toNotificationResponse,
} from './notification-response';

// Builds a Notification-shaped row for the mappers under test; only the fields
// the mappers read need to be present.
function notificationRow(
  type: NotificationType,
  payload: Record<string, unknown>,
): Notification {
  return {
    id: 'n1',
    userId: 'u1',
    type,
    payload,
    read: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

describe('toClientPayload (M6 allowlist)', () => {
  it('strips the content-bearing excerpt (and raw actor id) from a mention payload', () => {
    const projected = toClientPayload(
      notificationRow(NotificationType.Mention, {
        actorId: 'u2',
        source: 'community',
        communitySlug: 'private-support',
        postId: 'post-1',
        entityKind: 'member',
        entityRef: 'alice',
        excerpt: 'a private thing said inside a private community',
      }),
    );

    // The gated-space body must never reach the client.
    expect(projected).not.toHaveProperty('excerpt');
    // Raw acting-member ids are not forwarded (the actor is resolved separately).
    expect(projected).not.toHaveProperty('actorId');
    // The fields the client actually renders/deep-links from survive.
    expect(projected).toEqual({
      source: 'community',
      communitySlug: 'private-support',
      postId: 'post-1',
      entityKind: 'member',
      entityRef: 'alice',
    });
  });

  it('forwards only the common structural keys for a type with no allowlist entry', () => {
    const projected = toClientPayload(
      notificationRow(NotificationType.VouchReceived, {
        voucherId: 'u2',
        secret: 'should not leak',
      }),
    );
    expect(projected).toEqual({});
  });

  it('keeps a type-specific display field while dropping anything unlisted', () => {
    const projected = toClientPayload(
      notificationRow(NotificationType.BadgeEarned, {
        badgeName: 'Trailblazer',
        internalNote: 'do not ship',
      }),
    );
    expect(projected).toEqual({ badgeName: 'Trailblazer' });
  });
});

describe('toNotificationResponse', () => {
  it('serves the allowlisted payload, not the raw jsonb', () => {
    const response = toNotificationResponse(
      notificationRow(NotificationType.Mention, {
        source: 'community',
        communitySlug: 'private-support',
        excerpt: 'private body',
      }),
      undefined,
    );
    expect(response.payload).not.toHaveProperty('excerpt');
    expect(response.payload).toEqual({
      source: 'community',
      communitySlug: 'private-support',
    });
    expect(response.actor).toBeNull();
  });
});
