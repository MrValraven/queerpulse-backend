import { MemberRef } from '../common/member-ref';
import {
  isModeratorNoteSentToOwner,
  resolveOwnerHistoryActor,
  toOwnerListingModerationEventDTO,
} from './dto/owner-listing-history.dto';
import {
  ListingModerationAction,
  ListingModerationEvent,
} from './entities/listing-moderation-event.entity';
import { ListingStatus } from './entities/listing.entity';

/**
 * The owner history's "who did it" rule, tested on the one pure function that
 * decides it. The service only fetches the latest transfer, the team's member
 * ids and the profiles; every privacy decision lives in
 * `resolveOwnerHistoryActor` and the mapper, so this file is where a
 * regression shows up first.
 */

const OWNER_ID = 'owner-1';
const CO_MANAGER_ID = 'co-manager-1';
const MODERATOR_ID = 'mod-1';
const ADMIN_ID = 'admin-1';
const TRANSFER_AT = new Date('2026-03-01T12:00:00.000Z');

const ownerMember: MemberRef = {
  slug: 'ana-ribeiro',
  firstName: 'Ana',
  lastName: 'Ribeiro',
  pronouns: 'she/her',
  avatarUrl: null,
};

const moderatorMember: MemberRef = {
  slug: 'staff-member',
  firstName: 'Staff',
  lastName: 'Member',
  pronouns: null,
  avatarUrl: null,
};

const coManagerMember: MemberRef = {
  slug: 'bea-costa',
  firstName: 'Bea',
  lastName: 'Costa',
  pronouns: null,
  avatarUrl: null,
};

const adminMember: MemberRef = {
  slug: 'admin-member',
  firstName: 'Admin',
  lastName: 'Member',
  pronouns: null,
  avatarUrl: null,
};

// The staff profiles are in the map on purpose: the rule must keep them
// unnamed even when a profile for them is at hand.
const membersByUserId = new Map<string, MemberRef>([
  [OWNER_ID, ownerMember],
  [CO_MANAGER_ID, coManagerMember],
  [MODERATOR_ID, moderatorMember],
  [ADMIN_ID, adminMember],
]);

// The current owner plus a current co-manager, as the service builds it.
const teamMemberIds: ReadonlySet<string> = new Set([OWNER_ID, CO_MANAGER_ID]);

// Only the columns the mapper reads need real values; the rest of the entity
// (the `actor` relation) plays no part in the rule.
const moderationEvent = (
  overrides: Partial<ListingModerationEvent>,
): ListingModerationEvent =>
  ({
    id: 'event-1',
    listingId: 'listing-1',
    actorId: OWNER_ID,
    action: ListingModerationAction.OwnerEdited,
    fromStatus: null,
    toStatus: null,
    reason: null,
    changedFields: null,
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  }) as ListingModerationEvent;

describe('resolveOwnerHistoryActor', () => {
  it('reads a staff action as moderation, even when the moderator has a profile', () => {
    const event = moderationEvent({
      action: ListingModerationAction.StatusChanged,
      actorId: MODERATOR_ID,
    });

    expect(
      resolveOwnerHistoryActor(event, null, teamMemberIds, membersByUserId),
    ).toEqual({
      kind: 'moderation',
    });
  });

  it('names the team member on a team action when the listing was never transferred', () => {
    const event = moderationEvent({});

    expect(
      resolveOwnerHistoryActor(event, null, teamMemberIds, membersByUserId),
    ).toEqual({
      kind: 'team',
      member: ownerMember,
    });
  });

  it('reads a team action from before the latest transfer as the previous team', () => {
    const event = moderationEvent({
      createdAt: new Date('2026-02-28T00:00:00.000Z'),
    });

    expect(
      resolveOwnerHistoryActor(
        event,
        TRANSFER_AT,
        teamMemberIds,
        membersByUserId,
      ),
    ).toEqual({ kind: 'previous_team' });
  });

  it('reads a team action at the exact transfer instant as the previous team', () => {
    const event = moderationEvent({
      action: ListingModerationAction.CoManagerRemoved,
      createdAt: new Date(TRANSFER_AT.getTime()),
    });

    expect(
      resolveOwnerHistoryActor(
        event,
        TRANSFER_AT,
        teamMemberIds,
        membersByUserId,
      ),
    ).toEqual({ kind: 'previous_team' });
  });

  it('names the team member on a team action after the latest transfer', () => {
    const event = moderationEvent({
      action: ListingModerationAction.DirectoryPaused,
      createdAt: new Date('2026-03-01T12:00:00.001Z'),
    });

    expect(
      resolveOwnerHistoryActor(
        event,
        TRANSFER_AT,
        teamMemberIds,
        membersByUserId,
      ),
    ).toEqual({ kind: 'team', member: ownerMember });
  });

  it('keeps an erased team actor as team with no member', () => {
    const event = moderationEvent({ actorId: null });

    expect(
      resolveOwnerHistoryActor(event, null, teamMemberIds, membersByUserId),
    ).toEqual({
      kind: 'team',
      member: null,
    });
  });

  it('reads an applied suggestion as moderation, since staff applied it', () => {
    const event = moderationEvent({
      action: ListingModerationAction.SuggestionApplied,
      actorId: MODERATOR_ID,
    });

    expect(
      resolveOwnerHistoryActor(event, null, teamMemberIds, membersByUserId),
    ).toEqual({
      kind: 'moderation',
    });
  });

  it('reads a seat revoked by an admin as moderation, keeping the admin unnamed', () => {
    // `staffRevokeCoManager` writes `co_manager_removed` with the admin as
    // the actor: a team action by someone outside the team.
    const event = moderationEvent({
      action: ListingModerationAction.CoManagerRemoved,
      actorId: ADMIN_ID,
    });

    expect(
      resolveOwnerHistoryActor(event, null, teamMemberIds, membersByUserId),
    ).toEqual({ kind: 'moderation' });
  });

  it('names a current co-manager on their own edit', () => {
    const event = moderationEvent({ actorId: CO_MANAGER_ID });

    expect(
      resolveOwnerHistoryActor(event, null, teamMemberIds, membersByUserId),
    ).toEqual({ kind: 'team', member: coManagerMember });
  });
});

describe('toOwnerListingModerationEventDTO', () => {
  it('drops the reason on a previous_team row and flags no moderator note', () => {
    const olderSeatEvent = moderationEvent({
      action: ListingModerationAction.CoManagerAdded,
      actorId: 'previous-co-manager',
      reason: 'Rui Alves accepted an invitation to co-manage this listing.',
    });

    const row = toOwnerListingModerationEventDTO(olderSeatEvent, {
      kind: 'previous_team',
    });

    expect(row.reason).toBeNull();
    expect(row.hasModeratorNote).toBe(false);
    expect(row.actor).toEqual({ kind: 'previous_team' });
    expect(JSON.stringify(row)).not.toContain('Rui');
  });

  it('shows the platform-composed suggestion_applied reason and withholds a status_changed note', () => {
    const suggestionEvent = moderationEvent({
      action: ListingModerationAction.SuggestionApplied,
      actorId: MODERATOR_ID,
      reason: 'A suggested change to the address was applied.',
      changedFields: ['address'],
    });
    const statusEvent = moderationEvent({
      action: ListingModerationAction.StatusChanged,
      actorId: MODERATOR_ID,
      fromStatus: ListingStatus.Live,
      toStatus: ListingStatus.Review,
      reason: 'Internal note for the moderation team.',
    });

    const suggestionRow = toOwnerListingModerationEventDTO(suggestionEvent, {
      kind: 'moderation',
    });
    const statusRow = toOwnerListingModerationEventDTO(statusEvent, {
      kind: 'moderation',
    });

    expect(suggestionRow.reason).toBe(
      'A suggested change to the address was applied.',
    );
    expect(suggestionRow.hasModeratorNote).toBe(false);
    expect(suggestionRow.changedFields).toEqual(['address']);
    expect(suggestionRow.actor).toEqual({ kind: 'moderation' });
    expect(statusRow.reason).toBeNull();
    expect(statusRow.hasModeratorNote).toBe(true);
    expect(statusRow.changedFields).toBeNull();
  });

  it('shows the fixed staff_created sentence and flags no moderator note', () => {
    const staffCreatedEvent = moderationEvent({
      action: ListingModerationAction.StaffCreated,
      actorId: ADMIN_ID,
      toStatus: ListingStatus.Live,
      reason: 'Authored by staff and published straight away.',
    });

    const row = toOwnerListingModerationEventDTO(staffCreatedEvent, {
      kind: 'moderation',
    });

    expect(row.reason).toBe('Authored by staff and published straight away.');
    expect(row.hasModeratorNote).toBe(false);
  });

  it('withholds an ownership transfer note and flags no moderator note, since no message carried it', () => {
    const transferEvent = moderationEvent({
      action: ListingModerationAction.OwnershipTransferred,
      actorId: MODERATOR_ID,
      reason: 'Ownership accepted from a staff offer.',
    });

    const row = toOwnerListingModerationEventDTO(transferEvent, {
      kind: 'moderation',
    });

    expect(row.reason).toBeNull();
    expect(row.hasModeratorNote).toBe(false);
  });
});

describe('isModeratorNoteSentToOwner', () => {
  it('is true for a status_changed send-back with a note, which setStatus DMs', () => {
    expect(
      isModeratorNoteSentToOwner(
        moderationEvent({
          action: ListingModerationAction.StatusChanged,
          toStatus: ListingStatus.Review,
          reason: 'Please add your opening hours.',
        }),
      ),
    ).toBe(true);
  });

  it('is false for a status_changed approval into live, which sends a notification without the note', () => {
    expect(
      isModeratorNoteSentToOwner(
        moderationEvent({
          action: ListingModerationAction.StatusChanged,
          toStatus: ListingStatus.Live,
          reason: 'Checked the address by phone.',
        }),
      ),
    ).toBe(false);
  });

  it('is true for a bulk_status move to question with a note, which bulkSetStatus DMs', () => {
    expect(
      isModeratorNoteSentToOwner(
        moderationEvent({
          action: ListingModerationAction.BulkStatus,
          toStatus: ListingStatus.Question,
          reason: 'Batch follow-up on missing photos.',
        }),
      ),
    ).toBe(true);
  });

  it('is false for a bulk_status approval into live', () => {
    expect(
      isModeratorNoteSentToOwner(
        moderationEvent({
          action: ListingModerationAction.BulkStatus,
          toStatus: ListingStatus.Live,
          reason: 'Batch approval.',
        }),
      ),
    ).toBe(false);
  });

  it('is true for a removal with a note, which the removal DM carries', () => {
    expect(
      isModeratorNoteSentToOwner(
        moderationEvent({
          action: ListingModerationAction.Removed,
          toStatus: null,
          reason: 'Duplicate of another listing.',
        }),
      ),
    ).toBe(true);
  });

  it('is false for any action whose reason is null', () => {
    expect(
      isModeratorNoteSentToOwner(
        moderationEvent({
          action: ListingModerationAction.Removed,
          toStatus: null,
          reason: null,
        }),
      ),
    ).toBe(false);
  });

  it('is false for every action outside the DM paths, even with a reason', () => {
    const actionsWithoutNoteDm = [
      ListingModerationAction.StaffCreated,
      ListingModerationAction.OwnershipTransferred,
      ListingModerationAction.QuestionAsked,
      ListingModerationAction.Answered,
      ListingModerationAction.OwnerEdited,
      ListingModerationAction.SuggestionApplied,
    ];
    for (const action of actionsWithoutNoteDm) {
      expect(
        isModeratorNoteSentToOwner(
          moderationEvent({
            action,
            toStatus: ListingStatus.Review,
            reason: 'Some text.',
          }),
        ),
      ).toBe(false);
    }
  });
});
