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

  it("forwards a message mention's conversation and message ids, never its excerpt", () => {
    const projected = toClientPayload(
      notificationRow(NotificationType.Mention, {
        actorId: 'u2',
        source: 'message',
        conversationId: 'conv-1',
        messageId: 'msg-9',
        entityKind: 'member',
        entityRef: 'alice',
        excerpt: 'something said in a private thread',
      }),
    );

    // PRD-221: the two ids the bell row needs to link the message itself.
    expect(projected).toEqual({
      source: 'message',
      conversationId: 'conv-1',
      messageId: 'msg-9',
      entityKind: 'member',
      entityRef: 'alice',
    });
    // The private message body still never reaches the client.
    expect(projected).not.toHaveProperty('excerpt');
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
        badgeKey: 'first-gathering',
        badgeName: 'Trailblazer',
        internalNote: 'do not ship',
      }),
    );
    // `badgeKey` rides along so the client can translate the badge's name
    // itself; `badgeName` stays as the fallback for an unmapped id.
    expect(projected).toEqual({
      badgeKey: 'first-gathering',
      badgeName: 'Trailblazer',
    });
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

  // A persona is PSEUDONYMOUS, and PRD-208 gave followers a notification when
  // a persona they follow publishes. That notification must never name the
  // human behind it. Today the property rests on three separate absences in
  // three separate files: no `ACTOR_PAYLOAD_KEY` entry here, no user id in the
  // allowlist entry, and no `resolveActor` call in the push handler. Nothing
  // fails if a future contributor adds the missing entry for an unrelated
  // reason, so this test is the tripwire that turns the convention into a
  // rule. If it fails, do not "fix" it by updating the expectation.
  it('never resolves an actor for a persona update, so a pseudonymous persona cannot be traced to its owner', () => {
    const response = toNotificationResponse(
      notificationRow(NotificationType.PersonaUpdate, {
        subprofileName: 'Night Cartographer',
        subprofileSlugOrHandle: 'night-cartographer',
        itemTitle: 'Three routes home',
        newItemCount: 3,
        actorId: 'u2',
      }),
      { id: 'u2', firstName: 'Ana', lastName: 'Silva' } as never,
    );
    expect(response.actor).toBeNull();
    expect(response.payload).not.toHaveProperty('actorId');
    expect(JSON.stringify(response)).not.toContain('Ana');
  });
});
