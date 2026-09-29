import { Notification, NotificationType } from './entities/notification.entity';
import {
  actorIdOf,
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

describe('toClientPayload (PRD-404 event reminder)', () => {
  it('forwards the reminder source, slug and title, and keeps the id and start time server-side', () => {
    const projected = toClientPayload(
      notificationRow(NotificationType.EventReminder, {
        eventId: 'e1',
        startAt: '2026-10-01T18:00:00.000Z',
        source: 'event',
        eventSlug: 'queer-book-club',
        eventTitle: 'Queer book club',
      }),
    );
    expect(projected).toEqual({
      source: 'event',
      eventSlug: 'queer-book-club',
      eventTitle: 'Queer book club',
    });
  });
});

describe('toClientPayload (ENG-409 lifecycle rows)', () => {
  it('forwards the role and community name on a role change, and drops the raw role pair and actor id', () => {
    const projected = toClientPayload(
      notificationRow(NotificationType.CommunityRoleChanged, {
        actorId: 'admin-1',
        source: 'community',
        communitySlug: 'trans-friends',
        communityName: 'Trans Friends',
        role: 'mod',
        fromRole: 'member',
        toRole: 'mod',
      }),
    );
    expect(projected).toEqual({
      source: 'community',
      communitySlug: 'trans-friends',
      communityName: 'Trans Friends',
      role: 'mod',
    });
  });

  it('forwards the community name on an automatic freeze', () => {
    const projected = toClientPayload(
      notificationRow(NotificationType.CommunityFrozen, {
        source: 'community',
        communitySlug: 'trans-friends',
        communityName: 'Trans Friends',
        reason: 'report_pileup',
      }),
    );
    expect(projected).toEqual({
      source: 'community',
      communitySlug: 'trans-friends',
      communityName: 'Trans Friends',
    });
  });

  it('forwards youAreNowOwner on an ownership transfer, and drops the counterpart id', () => {
    const projected = toClientPayload(
      notificationRow(NotificationType.CommunityOwnershipTransferred, {
        actorId: 'u2',
        source: 'community',
        communitySlug: 'trans-friends',
        communityName: 'Trans Friends',
        youAreNowOwner: false,
        counterpartId: 'u3',
      }),
    );
    expect(projected).toEqual({
      source: 'community',
      communitySlug: 'trans-friends',
      communityName: 'Trans Friends',
      youAreNowOwner: false,
    });
  });

  it.each([
    NotificationType.SubprofileInvite,
    NotificationType.SubprofileCoOwnerJoined,
    NotificationType.PersonaEndorsed,
    NotificationType.PersonaFollowed,
  ])('forwards the persona name on %s and drops the raw ids', (type) => {
    const projected = toClientPayload(
      notificationRow(type, {
        subprofileId: 'sp1',
        subprofileName: 'Night Cartographer',
        invitedByUserId: 'u2',
        joinedUserId: 'u3',
      }),
    );
    expect(projected).toEqual({ subprofileName: 'Night Cartographer' });
  });

  it('forwards the gathering title on an announcement and keeps the body off the wire', () => {
    const projected = toClientPayload(
      notificationRow(NotificationType.EventAnnouncement, {
        source: 'event',
        eventId: 'e1',
        eventSlug: 'queer-book-club',
        title: 'Queer book club',
        announcementId: 'a1',
        body: 'the door code is 4471',
        actorId: 'host-1',
      }),
    );
    expect(projected).toEqual({
      source: 'event',
      eventSlug: 'queer-book-club',
      title: 'Queer book club',
    });
  });

  it('forwards the motion title and the rejection note', () => {
    const projected = toClientPayload(
      notificationRow(NotificationType.GovernanceMotionRejected, {
        source: 'governance',
        proposalId: 'p1',
        title: 'Publish the budget monthly',
        note: 'This duplicates the motion already on the ballot.',
      }),
    );
    expect(projected).toEqual({
      source: 'governance',
      title: 'Publish the budget monthly',
      note: 'This duplicates the motion already on the ballot.',
    });
  });

  it.each([
    NotificationType.GovernanceMotionApproved,
    NotificationType.GovernanceMotionReadyForReview,
  ])('forwards the motion title on %s and nothing else it carries', (type) => {
    const projected = toClientPayload(
      notificationRow(type, {
        source: 'governance',
        proposalId: 'p1',
        title: 'Publish the budget monthly',
        opensAt: '2026-10-01T00:00:00.000Z',
        closesAt: '2026-10-08T00:00:00.000Z',
        cosignatureCount: 10,
      }),
    );
    expect(projected).toEqual({
      source: 'governance',
      title: 'Publish the budget monthly',
    });
  });

  it.each([
    NotificationType.ListingClaimApproved,
    NotificationType.ListingClaimDeclined,
  ])('forwards the listing name on %s', (type) => {
    const projected = toClientPayload(
      notificationRow(type, {
        source: 'listing',
        listingSlug: 'lux-cafe',
        listingName: 'Lux Café',
      }),
    );
    expect(projected).toEqual({
      source: 'listing',
      listingSlug: 'lux-cafe',
      listingName: 'Lux Café',
    });
  });
});

describe('toNotificationResponse', () => {
  const actorProfile = (photoVisible: boolean) =>
    ({
      userId: 'u2',
      slug: 'ana',
      firstName: 'Ana',
      lastName: 'Silva',
      avatarUrl: 'https://lh3.googleusercontent.com/a/ana.png',
      photoVisible,
    }) as never;

  it('serves the actor avatar when the actor shows their photo', () => {
    const response = toNotificationResponse(
      notificationRow(NotificationType.Mention, { actorId: 'u2' }),
      actorProfile(true),
    );
    expect(response.actor?.avatarUrl).toBe(
      'https://lh3.googleusercontent.com/a/ana.png',
    );
  });

  it('serves no avatar when the actor hid their photo, keeping name and link (ENG-412)', () => {
    const response = toNotificationResponse(
      notificationRow(NotificationType.Mention, { actorId: 'u2' }),
      actorProfile(false),
    );
    expect(response.actor).toEqual({
      slug: 'ana',
      firstName: 'Ana',
      lastName: 'Silva',
      avatarUrl: null,
    });
  });

  it('names a Go together chat mentioner by first name with no profile link (PRD-423)', () => {
    const response = toNotificationResponse(
      notificationRow(NotificationType.Mention, {
        actorId: 'u2',
        source: 'message',
        conversationId: 'c1',
        isGoTogetherChat: true,
      }),
      actorProfile(true),
    );
    expect(response.actor).toEqual({
      slug: '',
      firstName: 'Ana',
      lastName: '',
      avatarUrl: 'https://lh3.googleusercontent.com/a/ana.png',
    });
    expect(response.payload).not.toHaveProperty('isGoTogetherChat');
  });

  it('keeps the full name and link for a mention in an ordinary chat', () => {
    const response = toNotificationResponse(
      notificationRow(NotificationType.Mention, {
        actorId: 'u2',
        source: 'message',
        conversationId: 'c1',
      }),
      actorProfile(true),
    );
    expect(response.actor).toMatchObject({
      slug: 'ana',
      firstName: 'Ana',
      lastName: 'Silva',
    });
  });

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
  //
  // The service resolves an actor profile only through `actorIdOf`, and the
  // mapper renders whatever profile it is handed, so `actorIdOf` is the real
  // gate: the row must yield no actor id, and the response built without a
  // profile must carry no trace of the owner's user id.
  it('never resolves an actor for a persona update, so a pseudonymous persona cannot be traced to its owner', () => {
    const row = notificationRow(NotificationType.PersonaUpdate, {
      subprofileName: 'Night Cartographer',
      subprofileSlugOrHandle: 'night-cartographer',
      itemTitle: 'Three routes home',
      newItemCount: 3,
      actorId: 'owner-user-id',
    });

    expect(actorIdOf(row)).toBeNull();
    const response = toNotificationResponse(row, undefined);
    expect(response.actor).toBeNull();
    expect(response.payload).not.toHaveProperty('actorId');
    expect(JSON.stringify(response)).not.toContain('owner-user-id');
  });
});
