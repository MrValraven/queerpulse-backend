import { IdentityKind } from '../identities/entities/identity.entity';
import { ConversationsService } from './conversations.service';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { ConversationKind } from './entities/conversation.entity';

/**
 * Task 13b: `buildConversationSummaries` read three fields straight off
 * `first`, one arbitrary staff seat of a business mailbox chosen by an
 * unordered query, for a CUSTOMER's own view of the thread:
 *
 * - `otherParticipantId` handed the customer that staff member's REAL user
 *   id. Presence is keyed by user id, so this let a client ask whether that
 *   specific human is online, defeating the separate change that stops a
 *   business ever reporting presence, and gave the customer a stable handle
 *   on one human regardless.
 * - `connectedSince` looked up the connection date between the customer and
 *   that one staff member, reporting a personal connection to the customer
 *   for a thread that only ever exists with the business.
 * - `otherDeliveredAt` reported one arbitrary staff seat's delivery
 *   watermark instead of collapsing across every seat the way
 *   `otherLastReadAt` already does (`conversation-mailbox-read-receipt.spec.ts`
 *   covers that sibling collapse).
 *
 * Every case here is a customer's own view of a mailbox thread: every row in
 * `others` is a seat of the one mailbox, the unambiguous side
 * `mailboxStaffSeats` scopes to. See `ConversationsService
 * .buildConversationSummaries`'s own comments for why a staff member's own
 * view of their mailbox (the reverse side) is intentionally left alone.
 */

const CONVERSATION_ID = 'c-mailbox';
const CUSTOMER_USER_ID = 'customer-1';
const CUSTOMER_IDENTITY_ID = 'identity-customer';
const MAILBOX_IDENTITY_ID = 'identity-mailbox';
const OTHER_MEMBER_IDENTITY_ID = 'identity-other-member';

function buildService(options: {
  others: ConversationParticipant[];
  acceptedSinceByCounterpart?: Map<string, Date>;
  claimedByUserId?: string | null;
  claimantProfile?: Record<string, unknown>;
  callerParticipant?: ConversationParticipant;
  acceptedConnectionUserIds?: string[];
  /** Extra `Profile` rows, alongside `claimantProfile` when both are given,
   *  so a test can make `profileByUser` resolve a real `AuthorSummary` for
   *  someone other than the claimant, e.g. the customer, for `otherParticipant`. */
  profiles?: Record<string, unknown>[];
  initiatorUserId?: string | null;
  openedAt?: Date | null;
  /** A display description for the shared mailbox identity, so a test can
   *  positively assert a result is NOT this (the business), as distinct from
   *  merely asserting it equals something else. Absent (the default) leaves
   *  `describeIdentities` returning an empty map, matching every other test
   *  in this file. */
  mailboxIdentityDescription?: {
    displayName: string;
    handle?: string;
    avatarUrl: string | null;
  };
  /** Per-user `shareReadReceipts` rows, keyed by user id. Absent (the
   *  default) leaves `getMessagingPrivacyForUsers` returning an empty map,
   *  meaning "shares" for everyone (`?? true`), matching every other test
   *  in this file. */
  privacyByUser?: Map<string, { shareReadReceipts: boolean }>;
}) {
  const customerParticipant = {
    id: 'p-customer',
    conversationId: CONVERSATION_ID,
    userId: CUSTOMER_USER_ID,
    identityId: CUSTOMER_IDENTITY_ID,
    role: ConversationRole.Member,
    clearedAt: null,
    leftAt: null,
    removedAt: null,
    muted: false,
    mutedUntil: null,
    muteMode: 'all',
    pinnedAt: null,
    favoritedAt: null,
    archivedAt: null,
    markedUnreadAt: null,
    draft: null,
    lastReadAt: null,
    lastReadInstant: null,
    deliveredAt: null,
  } as unknown as ConversationParticipant;

  const conversationsRepo = {
    find: jest.fn().mockResolvedValue([
      {
        id: CONVERSATION_ID,
        kind: ConversationKind.Direct,
        isOfficial: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        title: null,
        avatarUrl: null,
        description: null,
        dissolvedAt: null,
        inviteToken: null,
        claimedByUserId: options.claimedByUserId ?? null,
        claimedAt: options.claimedByUserId
          ? new Date('2026-01-03T00:00:00.000Z')
          : null,
        // Defaults to both null: with both null, `replyGateFor` falls
        // through to its "no known initiator" default, `needsConnection`,
        // unless a connection makes it `'open'`. A real column value, never
        // left absent, so a test reads an actual null, never JavaScript's
        // `undefined`-is-falsy behavior.
        initiatorUserId: options.initiatorUserId ?? null,
        openedAt: options.openedAt ?? null,
      },
    ]),
  };
  const participantsRepo = {
    find: jest.fn().mockResolvedValue(options.others),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const profilesRepo = {
    find: jest
      .fn()
      .mockResolvedValue([
        ...(options.claimantProfile ? [options.claimantProfile] : []),
        ...(options.profiles ?? []),
      ]),
  };
  const core = {
    requireParticipant: jest
      .fn()
      .mockResolvedValue(options.callerParticipant ?? customerParticipant),
    lastMessagesByConversation: jest.fn().mockResolvedValue(new Map()),
    unreadCountsByConversation: jest.fn().mockResolvedValue(new Map()),
    reactionSummariesByMessage: jest.fn().mockResolvedValue(new Map()),
    hasUnreadMentionByConversation: jest.fn().mockResolvedValue(new Map()),
  };
  const blockFilter = {
    blockedUserIds: jest.fn().mockResolvedValue(new Set()),
    // Task 14: no member here has blocked a business.
    identityBlocksAmong: jest.fn().mockResolvedValue([]),
  };
  const eventEmitter = { emit: jest.fn() };
  const dataSource = {};
  const mediaCropService = { getMany: jest.fn().mockResolvedValue(new Map()) };
  const connectionsService = {
    allAcceptedConnectionUserIds: jest
      .fn()
      .mockResolvedValue(options.acceptedConnectionUserIds ?? []),
    acceptedSinceByCounterpart: jest
      .fn()
      .mockResolvedValue(options.acceptedSinceByCounterpart ?? new Map()),
  };
  const preferencesService = {
    getMessagingPrivacyForUsers: jest
      .fn()
      .mockResolvedValue(options.privacyByUser ?? new Map()),
  };
  const identities = {
    getByIds: jest.fn().mockResolvedValue([
      { id: CUSTOMER_IDENTITY_ID, kind: IdentityKind.Profile },
      { id: MAILBOX_IDENTITY_ID, kind: IdentityKind.Listing },
      { id: OTHER_MEMBER_IDENTITY_ID, kind: IdentityKind.Profile },
    ]),
    describeIdentities: jest
      .fn()
      .mockResolvedValue(
        options.mailboxIdentityDescription
          ? new Map([[MAILBOX_IDENTITY_ID, options.mailboxIdentityDescription]])
          : new Map(),
      ),
  };
  const identityAttribution = {
    buildStaffNameResolver: jest
      .fn()
      .mockResolvedValue({ resolve: () => null }),
  };

  const service = new ConversationsService(
    conversationsRepo as never,
    participantsRepo as never,
    profilesRepo as never,
    core as never,
    blockFilter as never,
    eventEmitter as never,
    dataSource as never,
    mediaCropService as never,
    connectionsService as never,
    preferencesService as never,
    identities as never,
    identityAttribution as never,
  );
  return { service };
}

function staffSeat(
  overrides: Partial<ConversationParticipant>,
): ConversationParticipant {
  return {
    id: `p-${overrides.userId}`,
    conversationId: CONVERSATION_ID,
    userId: 'staff',
    identityId: MAILBOX_IDENTITY_ID,
    role: ConversationRole.Member,
    clearedAt: null,
    leftAt: null,
    removedAt: null,
    muted: false,
    mutedUntil: null,
    muteMode: 'all',
    pinnedAt: null,
    favoritedAt: null,
    archivedAt: null,
    markedUnreadAt: null,
    draft: null,
    lastReadAt: null,
    lastReadInstant: null,
    deliveredAt: null,
    ...overrides,
  } as unknown as ConversationParticipant;
}

/** A customer's own row, for use as one of `others` in a STAFF caller's
 *  fixture: carries the ordinary member `CUSTOMER_IDENTITY_ID` (a `Profile`),
 *  never the shared mailbox identity a staff seat carries. */
function customerSeat(
  overrides: Partial<ConversationParticipant>,
): ConversationParticipant {
  return {
    id: `p-${overrides.userId}`,
    conversationId: CONVERSATION_ID,
    userId: CUSTOMER_USER_ID,
    identityId: CUSTOMER_IDENTITY_ID,
    role: ConversationRole.Member,
    clearedAt: null,
    leftAt: null,
    removedAt: null,
    muted: false,
    mutedUntil: null,
    muteMode: 'all',
    pinnedAt: null,
    favoritedAt: null,
    archivedAt: null,
    markedUnreadAt: null,
    draft: null,
    lastReadAt: null,
    lastReadInstant: null,
    deliveredAt: null,
    ...overrides,
  } as unknown as ConversationParticipant;
}

describe('ConversationsService.getConversation, mailbox identity leak (Task 13b)', () => {
  it("returns otherParticipantId null for a customer's business thread, and leaks no staff user id anywhere in the serialized summary", async () => {
    const firstReturnedStaff = staffSeat({ userId: 'staff-1' });
    const secondStaff = staffSeat({ userId: 'staff-2' });
    const { service } = buildService({
      others: [firstReturnedStaff, secondStaff],
    });

    const result = await service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(result.otherParticipantId).toBeNull();
    // Serialize, since a leak can hide in a field this test did not think to
    // assert on directly. This is the same shape a JSON HTTP response
    // actually takes.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('staff-1');
    expect(serialized).not.toContain('staff-2');
  });

  it('returns connectedSince null for a business thread even when the customer IS connected to one of its staff members as a person', async () => {
    const firstReturnedStaff = staffSeat({ userId: 'staff-1' });
    const secondStaff = staffSeat({ userId: 'staff-2' });
    const { service } = buildService({
      others: [firstReturnedStaff, secondStaff],
      // The customer really is connected to `staff-1` as a person. The
      // fixture must carry this or the test proves nothing.
      acceptedSinceByCounterpart: new Map([
        ['staff-1', new Date('2025-06-01T00:00:00.000Z')],
      ]),
    });

    const result = await service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(result.connectedSince).toBeNull();
  });

  it('reads otherDeliveredAt as delivered once ANY staff seat has delivered, even when the other has not', async () => {
    const undeliveredSeat = staffSeat({
      userId: 'staff-1',
      deliveredAt: null,
    });
    const deliveredSeat = staffSeat({
      userId: 'staff-2',
      deliveredAt: new Date('2026-01-02T09:00:00.000Z'),
    });
    const { service } = buildService({
      others: [undeliveredSeat, deliveredSeat],
    });

    const result = await service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(result.otherDeliveredAt).toBe('2026-01-02T09:00:00.000Z');
  });

  it('leaves a personal one-to-one thread unaffected: real counterpart id, connection date and delivery watermark all still show', async () => {
    const counterpartUserId = 'other-member';
    const otherMemberParticipant = {
      id: 'p-other',
      conversationId: CONVERSATION_ID,
      userId: counterpartUserId,
      identityId: OTHER_MEMBER_IDENTITY_ID,
      role: ConversationRole.Member,
      clearedAt: null,
      leftAt: null,
      removedAt: null,
      muted: false,
      mutedUntil: null,
      muteMode: 'all',
      pinnedAt: null,
      favoritedAt: null,
      archivedAt: null,
      markedUnreadAt: null,
      draft: null,
      lastReadAt: null,
      lastReadInstant: null,
      deliveredAt: new Date('2026-01-02T09:00:00.000Z'),
    } as unknown as ConversationParticipant;
    const { service } = buildService({
      others: [otherMemberParticipant],
      acceptedSinceByCounterpart: new Map([
        [counterpartUserId, new Date('2025-06-01T00:00:00.000Z')],
      ]),
      // A real personal connection, so `replyGate` below is verified to
      // still read the real connection status. Fix round 1 forces `false`
      // into this check only on a mailbox thread; this fixture has none.
      acceptedConnectionUserIds: [counterpartUserId],
    });

    const result = await service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(result.mailboxIdentityId).toBeUndefined();
    expect(result.otherParticipantId).toBe(counterpartUserId);
    expect(result.connectedSince).toBe('2025-06-01T00:00:00.000Z');
    expect(result.otherDeliveredAt).toBe('2026-01-02T09:00:00.000Z');
    expect(result.replyGate).toBe('open');
  });

  // Fix round 1 (Task 13b), Finding 1: every test above reads the summary as
  // the CUSTOMER. A suite that only proves the customer is hidden from
  // `claimedBy` would equally pass an implementation that hid it from
  // EVERYONE, which would make the claim chip vanish for the staff it exists
  // for. This pins the STAFF side.
  it("returns claimedBy as the claimant's real AuthorSummary for a STAFF caller's own view of their claimed mailbox thread", async () => {
    const callerParticipant = staffSeat({ userId: 'staff-1' });
    const colleague = staffSeat({ userId: 'staff-2' });
    const customer = customerSeat({ userId: CUSTOMER_USER_ID });
    const claimantProfile = {
      userId: 'staff-2',
      slug: 'jordan-claimant-slug',
      firstName: 'Jordan',
      lastName: 'Rivera',
      pronouns: null,
      photoVisible: false,
      avatarUrl: null,
    };
    const { service } = buildService({
      others: [colleague, customer],
      callerParticipant,
      claimedByUserId: 'staff-2',
      claimantProfile,
    });

    const result = await service.getConversation(CONVERSATION_ID, 'staff-1');

    expect(result.claimedBy).toEqual({
      handle: 'jordan-claimant-slug',
      displayName: 'Jordan Rivera',
      pronouns: null,
      avatarUrl: null,
    });
  });

  // Fix round 1 (Task 13b), Finding 2: for a STAFF caller, `convoOthers` mixes
  // the customer's row in among every colleague's row, so the naive
  // `convoOthers[0]` pick could return a colleague instead of the customer.
  // The frontend passes `otherParticipantId` straight through as the
  // report/block subject and as the presence-ring id, so that colleague pick
  // meant a staff member could block or report a colleague, or see a
  // colleague's presence dot, while believing they were acting on the
  // customer.
  it('returns the CUSTOMER user id for otherParticipantId when a STAFF caller is one of three staff, with both colleagues ordered ahead of the customer in the unordered read', async () => {
    const callerParticipant = staffSeat({ userId: 'staff-1' });
    const colleagueA = staffSeat({ userId: 'staff-2' });
    const colleagueB = staffSeat({ userId: 'staff-3' });
    const customer = customerSeat({ userId: CUSTOMER_USER_ID });
    const { service } = buildService({
      // Both colleagues ordered ahead of the customer on purpose: a naive
      // `first` pick (`convoOthers[0]`) would return a colleague's id here,
      // never the customer's, so a correct answer could not be luck.
      others: [colleagueA, colleagueB, customer],
      callerParticipant,
    });

    const result = await service.getConversation(CONVERSATION_ID, 'staff-1');

    expect(result.otherParticipantId).toBe(CUSTOMER_USER_ID);
  });

  // Fix round 1 (Task 13b), Finding 3: `replyGate` fed a personal connection
  // check keyed on the arbitrary `first` seat into `replyGateFor`, so the
  // same thread could read as `'open'` or `'needsConnection'` depending only
  // on which staff seat an unordered read happened to return, whenever the
  // customer was personally connected to exactly one staff member. Runs the
  // same fixture both seat orders and asserts they agree.
  it('gives the same replyGate answer for the same mailbox thread under two different seat orders, when the customer is personally connected to exactly one staff member', async () => {
    const connectedStaff = staffSeat({ userId: 'staff-1' });
    const unconnectedStaff = staffSeat({ userId: 'staff-2' });

    const orderA = buildService({
      others: [connectedStaff, unconnectedStaff],
      acceptedConnectionUserIds: ['staff-1'],
    });
    const orderB = buildService({
      others: [unconnectedStaff, connectedStaff],
      acceptedConnectionUserIds: ['staff-1'],
    });

    const resultA = await orderA.service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );
    const resultB = await orderB.service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(resultA.replyGate).toBe(resultB.replyGate);
  });

  // A fourth leak found beyond the plan's own three while sweeping this
  // summary field by field: `claimedBy` built a full `AuthorSummary` (real
  // display name, handle, avatar) of whichever staff member claimed the
  // mailbox thread, unconditionally, for every viewer including the
  // customer. `claim`/`release` only ever apply to a mailbox thread, so this
  // was never reachable for an ordinary member-to-member DM.
  it("returns claimedBy null for a customer's business thread even when a staff member has claimed it, and leaks none of that staff member's real name, handle or photo", async () => {
    const firstReturnedStaff = staffSeat({ userId: 'staff-1' });
    const secondStaff = staffSeat({ userId: 'staff-2' });
    const claimantProfile = {
      userId: 'staff-1',
      slug: 'jordan-claimant-slug',
      firstName: 'Jordan',
      lastName: 'Rivera',
      pronouns: null,
      photoVisible: false,
      avatarUrl: null,
    };
    const { service } = buildService({
      others: [firstReturnedStaff, secondStaff],
      claimedByUserId: 'staff-1',
      claimantProfile,
    });

    const result = await service.getConversation(
      CONVERSATION_ID,
      CUSTOMER_USER_ID,
    );

    expect(result.claimedBy).toBeNull();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('jordan-claimant-slug');
    expect(serialized).not.toContain('Jordan');
    expect(serialized).not.toContain('Rivera');
  });

  // Fix round 2 (Task 13b), Concern 2: `otherParticipant` (the header's
  // display object, distinct from `otherParticipantId`) read off the same
  // arbitrary `first` seat as the three fields fix round 1 already
  // corrected. For a STAFF caller, `first` landing on a colleague renders
  // the header as the mailbox identity itself (a colleague's identity IS
  // the caller's own mailbox identity), so a staff member opening a
  // customer's thread could see their OWN business in the header instead of
  // the customer.
  it("returns the CUSTOMER's own AuthorSummary for otherParticipant when a STAFF caller is one of three staff, with both colleagues ordered ahead of the customer in the unordered read, and never the mailbox identity", async () => {
    const callerParticipant = staffSeat({ userId: 'staff-1' });
    const colleagueA = staffSeat({ userId: 'staff-2' });
    const colleagueB = staffSeat({ userId: 'staff-3' });
    const customer = customerSeat({ userId: CUSTOMER_USER_ID });
    const customerProfile = {
      userId: CUSTOMER_USER_ID,
      slug: 'alex-customer-slug',
      firstName: 'Alex',
      lastName: 'Customer',
      pronouns: null,
      photoVisible: false,
      avatarUrl: null,
    };
    const { service } = buildService({
      // Both colleagues ordered ahead of the customer on purpose: a naive
      // `first` pick (`convoOthers[0]`) would render the header as the
      // mailbox identity itself here, never the customer's profile, so a
      // correct answer could not be luck.
      others: [colleagueA, colleagueB, customer],
      callerParticipant,
      profiles: [customerProfile],
      // A distinctive business identity description, so this test can
      // positively assert the result is NOT the mailbox identity, rather
      // than only asserting it equals the customer's summary.
      mailboxIdentityDescription: {
        displayName: 'The Business',
        handle: 'the-business-handle',
        avatarUrl: null,
      },
    });

    const result = await service.getConversation(CONVERSATION_ID, 'staff-1');

    expect(result.otherParticipant).toEqual({
      handle: 'alex-customer-slug',
      displayName: 'Alex Customer',
      pronouns: null,
      avatarUrl: null,
    });
    expect(result.otherParticipant?.handle).not.toBe('the-business-handle');
    expect(result.otherParticipant?.displayName).not.toBe('The Business');
  });

  // Fix round 2 (Task 13b), Concern 1: `replyGate` now forces the personal
  // connection input to `false` on a mailbox thread (fix round 1), and the
  // coordinator asked for this to be pinned by a real trace and a real test,
  // for the case that matters most: the business answering a customer who
  // reached out first.
  // Traced through `replyGateFor` for a STAFF caller (`viewerUserId`) on a
  // customer-initiated, not-yet-opened thread: `isConnected` is `false`
  // (forced), `convo.openedAt` is `null`, so the first check does not
  // return early; `convo.initiatorUserId` is the CUSTOMER's id, truthy, so
  // the "no known initiator" branch is skipped; `convo.initiatorUserId ===
  // viewerUserId` is false (the customer initiated, the staff member did
  // not), so the `'awaitingTheirReply'` branch is skipped too; the
  // function's own final branch, documented as "the viewer did NOT
  // initiate: their first ordinary send is what flips `openedAt`", returns
  // `'open'`. The forced-`false` connection never enters this path at all,
  // so a business can always send its own first reply to a customer who
  // reached out, with no requirement that any particular staff member be
  // personally connected to that customer.
  it("gives staff replyGate 'open' on a customer-initiated, not-yet-opened mailbox thread, even when staff and the customer are not personally connected", async () => {
    const callerParticipant = staffSeat({ userId: 'staff-1' });
    const customer = customerSeat({ userId: CUSTOMER_USER_ID });
    const { service } = buildService({
      others: [customer],
      callerParticipant,
      initiatorUserId: CUSTOMER_USER_ID,
      openedAt: null,
      // Explicitly empty: staff and the customer are NOT personally
      // connected, so a naive (un-overridden) connection check would also
      // have read `false` here. The real assertion is that `'open'` comes
      // from the initiator branch on its own, standing up even with a
      // missing connection.
      acceptedConnectionUserIds: [],
    });

    const result = await service.getConversation(CONVERSATION_ID, 'staff-1');

    expect(result.replyGate).toBe('open');
  });

  // Fix round 3 (Task 13b): the last field in `buildConversationSummaries`
  // still built from the arbitrary `first` for a STAFF caller.
  // `otherLastReadAt`/`otherLastReadInstant` now read the CUSTOMER's own
  // watermark via `mailboxCustomerSeat`, the same seat every other
  // STAFF-side field in this file already resolves.
  it("returns the CUSTOMER's own otherLastReadAt/otherLastReadInstant when a STAFF caller has three colleagues ordered ahead of the customer, each colleague reading LATER than the customer did", async () => {
    const callerParticipant = staffSeat({ userId: 'staff-1' });
    // Every colleague reads LATER than the customer, on purpose: an
    // arbitrary `first` pick (`convoOthers[0]`, a colleague here) returns a
    // clearly later, clearly wrong timestamp instead of the customer's
    // earlier, real one. Colleagues reading EARLIER would risk a false pass
    // if some other bug happened to collapse toward the latest across every
    // seat (customer included), since the customer's own timestamp would
    // then already be the max by pure coincidence, a passing result that
    // proves nothing about whether the read is genuinely customer-specific.
    const colleagueA = staffSeat({
      userId: 'staff-2',
      lastReadAt: new Date('2026-01-02T10:00:00.000Z'),
      lastReadInstant: new Date('2026-01-02T10:00:05.000Z'),
    });
    const colleagueB = staffSeat({
      userId: 'staff-3',
      lastReadAt: new Date('2026-01-02T11:00:00.000Z'),
      lastReadInstant: new Date('2026-01-02T11:00:05.000Z'),
    });
    const colleagueC = staffSeat({
      userId: 'staff-4',
      lastReadAt: new Date('2026-01-02T12:00:00.000Z'),
      lastReadInstant: new Date('2026-01-02T12:00:05.000Z'),
    });
    const customer = customerSeat({
      userId: CUSTOMER_USER_ID,
      lastReadAt: new Date('2026-01-02T08:00:00.000Z'),
      lastReadInstant: new Date('2026-01-02T08:00:05.000Z'),
    });
    const { service } = buildService({
      others: [colleagueA, colleagueB, colleagueC, customer],
      callerParticipant,
    });

    const result = await service.getConversation(CONVERSATION_ID, 'staff-1');

    expect(result.otherLastReadAt).toBe('2026-01-02T08:00:00.000Z');
    expect(result.otherLastReadInstant).toBe('2026-01-02T08:00:05.000Z');
  });

  // Fix round 4 (Task 13b): round 3 fixed WHICH seat's watermark shows for
  // a STAFF caller (the customer's) without also fixing WHICH seat's
  // privacy toggle decides whether to show it at all, still `first`. That
  // mismatch is a privacy regression round 3 introduced: a staff member
  // could see the customer's real read time even after the customer turned
  // read receipts off, gated instead by an arbitrary COLLEAGUE's own
  // sharing preference. Colleagues ordered first, as in every fixture in
  // this file.
  it('withholds otherLastReadAt and otherLastReadInstant for a STAFF caller when the CUSTOMER has read receipts OFF, even though every colleague has them ON', async () => {
    const callerParticipant = staffSeat({ userId: 'staff-1' });
    const colleagueA = staffSeat({ userId: 'staff-2' });
    const colleagueB = staffSeat({ userId: 'staff-3' });
    const colleagueC = staffSeat({ userId: 'staff-4' });
    const customer = customerSeat({
      userId: CUSTOMER_USER_ID,
      lastReadAt: new Date('2026-01-02T08:00:00.000Z'),
      lastReadInstant: new Date('2026-01-02T08:00:05.000Z'),
    });
    const { service } = buildService({
      others: [colleagueA, colleagueB, colleagueC, customer],
      callerParticipant,
      privacyByUser: new Map([
        [CUSTOMER_USER_ID, { shareReadReceipts: false }],
        ['staff-2', { shareReadReceipts: true }],
        ['staff-3', { shareReadReceipts: true }],
        ['staff-4', { shareReadReceipts: true }],
      ]),
    });

    const result = await service.getConversation(CONVERSATION_ID, 'staff-1');

    expect(result.otherLastReadAt).toBeNull();
    expect(result.otherLastReadInstant).toBeNull();
  });

  // Fix round 4 (Task 13b): the other direction of the same fix. A gate
  // that simply always hid read state from a STAFF caller would also pass
  // the test above, so this proves the gate genuinely reads the CUSTOMER's
  // own toggle: when the customer shares and every colleague does not, the
  // customer's real read time still shows.
  it('shows the CUSTOMER real otherLastReadAt/otherLastReadInstant for a STAFF caller when the CUSTOMER has read receipts ON, even though every colleague has them OFF', async () => {
    const callerParticipant = staffSeat({ userId: 'staff-1' });
    const colleagueA = staffSeat({ userId: 'staff-2' });
    const colleagueB = staffSeat({ userId: 'staff-3' });
    const colleagueC = staffSeat({ userId: 'staff-4' });
    const customer = customerSeat({
      userId: CUSTOMER_USER_ID,
      lastReadAt: new Date('2026-01-02T08:00:00.000Z'),
      lastReadInstant: new Date('2026-01-02T08:00:05.000Z'),
    });
    const { service } = buildService({
      others: [colleagueA, colleagueB, colleagueC, customer],
      callerParticipant,
      privacyByUser: new Map([
        [CUSTOMER_USER_ID, { shareReadReceipts: true }],
        ['staff-2', { shareReadReceipts: false }],
        ['staff-3', { shareReadReceipts: false }],
        ['staff-4', { shareReadReceipts: false }],
      ]),
    });

    const result = await service.getConversation(CONVERSATION_ID, 'staff-1');

    expect(result.otherLastReadAt).toBe('2026-01-02T08:00:00.000Z');
    expect(result.otherLastReadInstant).toBe('2026-01-02T08:00:05.000Z');
  });

  // Fix round 4 (Task 13b): the gate must fail CLOSED, never falling back
  // to a colleague's toggle, when the customer's own seat cannot be
  // resolved at all. Built the same way the other fields' own anomaly case
  // is: two non-mailbox seats among `others`, so `resolveMailboxCustomerSeat`
  // sees more than one candidate and reports `undefined`.
  it('withholds otherLastReadAt and otherLastReadInstant for a STAFF caller when the customer seat cannot be resolved', async () => {
    const callerParticipant = staffSeat({ userId: 'staff-1' });
    // Task 13c: colleague A, ordered first, carries real read watermarks,
    // so a regression that fell back to the first seat would surface them
    // here as a visible, wrong read time.
    const colleagueA = staffSeat({
      userId: 'staff-2',
      lastReadAt: new Date('2026-01-02T11:00:00.000Z'),
      lastReadInstant: new Date('2026-01-02T11:00:05.000Z'),
    });
    const colleagueB = staffSeat({ userId: 'staff-3' });
    const customer = customerSeat({
      userId: CUSTOMER_USER_ID,
      lastReadAt: new Date('2026-01-02T08:00:00.000Z'),
    });
    const anotherNonMailboxSeat = {
      id: 'p-other-member',
      conversationId: CONVERSATION_ID,
      userId: 'other-member',
      identityId: OTHER_MEMBER_IDENTITY_ID,
      role: ConversationRole.Member,
      clearedAt: null,
      leftAt: null,
      removedAt: null,
      muted: false,
      mutedUntil: null,
      muteMode: 'all',
      pinnedAt: null,
      favoritedAt: null,
      archivedAt: null,
      markedUnreadAt: null,
      draft: null,
      lastReadAt: new Date('2026-01-02T09:00:00.000Z'),
      lastReadInstant: null,
      deliveredAt: null,
    } as unknown as ConversationParticipant;
    const { service } = buildService({
      others: [colleagueA, colleagueB, customer, anotherNonMailboxSeat],
      callerParticipant,
      // Every share toggle left ON, on purpose: if this null came from the
      // privacy gate reading the wrong person, a generous privacy fixture
      // like this one would let a real value slip through. It does not,
      // because `mailboxCustomerSeat` is `undefined` before privacy is ever
      // consulted.
      privacyByUser: new Map([
        [CUSTOMER_USER_ID, { shareReadReceipts: true }],
        ['staff-2', { shareReadReceipts: true }],
        ['staff-3', { shareReadReceipts: true }],
        ['other-member', { shareReadReceipts: true }],
      ]),
    });

    const result = await service.getConversation(CONVERSATION_ID, 'staff-1');

    expect(result.otherLastReadAt).toBeNull();
    expect(result.otherLastReadInstant).toBeNull();
  });
  // Task 13c: the remaining STAFF-side fields of fix round 1 (Task 13b), each
  // with colleagues ordered ahead of the customer and carrying values of
  // their own, so reading the first seat would show a colleague's value.
  it("returns the CUSTOMER's own connectedSince for a STAFF caller with colleagues ordered first", async () => {
    const callerParticipant = staffSeat({ userId: 'staff-1' });
    const colleagueA = staffSeat({ userId: 'staff-2' });
    const colleagueB = staffSeat({ userId: 'staff-3' });
    const customer = customerSeat({ userId: CUSTOMER_USER_ID });
    const { service } = buildService({
      others: [colleagueA, colleagueB, customer],
      callerParticipant,
      acceptedSinceByCounterpart: new Map([
        ['staff-2', new Date('2024-01-01T00:00:00.000Z')],
        ['staff-3', new Date('2024-02-01T00:00:00.000Z')],
        [CUSTOMER_USER_ID, new Date('2025-06-01T00:00:00.000Z')],
      ]),
    });

    const result = await service.getConversation(CONVERSATION_ID, 'staff-1');

    expect(result.connectedSince).toBe('2025-06-01T00:00:00.000Z');
  });

  it("returns the CUSTOMER's own otherDeliveredAt for a STAFF caller with colleagues ordered first, each delivered LATER than the customer", async () => {
    const callerParticipant = staffSeat({ userId: 'staff-1' });
    const colleagueA = staffSeat({
      userId: 'staff-2',
      deliveredAt: new Date('2026-01-02T11:00:00.000Z'),
    });
    const colleagueB = staffSeat({
      userId: 'staff-3',
      deliveredAt: new Date('2026-01-02T12:00:00.000Z'),
    });
    const customer = customerSeat({
      userId: CUSTOMER_USER_ID,
      deliveredAt: new Date('2026-01-02T08:00:00.000Z'),
    });
    const { service } = buildService({
      others: [colleagueA, colleagueB, customer],
      callerParticipant,
    });

    const result = await service.getConversation(CONVERSATION_ID, 'staff-1');

    expect(result.otherDeliveredAt).toBe('2026-01-02T08:00:00.000Z');
  });

  it('returns a null header for a STAFF caller whose customer seat is ambiguous, with no placeholder and no colleague or member profile in it', async () => {
    const callerParticipant = staffSeat({ userId: 'staff-1' });
    const colleague = staffSeat({ userId: 'staff-2' });
    const customer = customerSeat({ userId: CUSTOMER_USER_ID });
    const anotherNonMailboxSeat = customerSeat({
      userId: 'other-member',
      identityId: OTHER_MEMBER_IDENTITY_ID,
    });
    const { service } = buildService({
      others: [colleague, anotherNonMailboxSeat, customer],
      callerParticipant,
      profiles: [
        {
          userId: 'other-member',
          slug: 'other-member-slug',
          firstName: 'Other',
          lastName: 'Member',
          pronouns: null,
          photoVisible: false,
          avatarUrl: null,
        },
      ],
      mailboxIdentityDescription: {
        displayName: 'The Business',
        handle: 'the-business-handle',
        avatarUrl: null,
      },
    });

    const result = await service.getConversation(CONVERSATION_ID, 'staff-1');

    expect(result.otherParticipant).toBeNull();
    expect(result.otherParticipantId).toBeNull();
  });
});
