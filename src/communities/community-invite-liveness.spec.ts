import { Repository, SelectQueryBuilder } from 'typeorm';
import {
  liveInvitedUserIds,
  retireDeadPendingInvites,
  whereInviteIsLive,
} from './community-invite-liveness';
import { COMMUNITY_STAFF_ROLES } from './community-staff-access';
import {
  CommunityInvite,
  CommunityInviteStatus,
} from './entities/community-invite.entity';

const RECORDED_METHODS = [
  'select',
  'where',
  'andWhere',
  'orderBy',
  'update',
  'set',
] as const;

type RecordedMethod = (typeof RECORDED_METHODS)[number];

/** Every chain method is a present `jest.Mock`, plus the named terminals. */
type RecordingQueryBuilder<Terminal extends string = never> = Record<
  RecordedMethod | Terminal,
  jest.Mock
>;

/** A query builder whose every chain method records its call and returns the
 *  builder itself, with the terminal methods overridable per test. */
function recordingQueryBuilder<Terminal extends string = never>(
  terminals: Record<Terminal, jest.Mock> = {} as Record<Terminal, jest.Mock>,
): RecordingQueryBuilder<Terminal> {
  const queryBuilder = { ...terminals } as RecordingQueryBuilder<Terminal>;
  for (const method of RECORDED_METHODS) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  return queryBuilder;
}

/** The first argument of a mock's one and only call, narrowed for reading. */
function onlyCallArgument<Value>(mock: jest.Mock): Value {
  expect(mock).toHaveBeenCalledTimes(1);
  const [onlyCall] = mock.mock.calls as [Value][];
  if (!onlyCall) {
    throw new Error('Expected the mock to have been called once');
  }
  return onlyCall[0];
}

function andWhereClauses(queryBuilder: RecordingQueryBuilder): string[] {
  return queryBuilder.andWhere.mock.calls.map(
    (call: unknown[]) => call[0] as string,
  );
}

function asSelectQueryBuilder(
  queryBuilder: RecordingQueryBuilder,
): SelectQueryBuilder<CommunityInvite> {
  return queryBuilder as unknown as SelectQueryBuilder<CommunityInvite>;
}

describe('community-invite-liveness', () => {
  it('whereInviteIsLive adds the pending, expiry, inviter-standing and block clauses by default', () => {
    const queryBuilder = recordingQueryBuilder();

    whereInviteIsLive(asSelectQueryBuilder(queryBuilder), 'invite');

    const clauses = andWhereClauses(queryBuilder);
    expect(clauses).toHaveLength(4);
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      '"invite"."status" = :liveInvitePendingStatus',
      { liveInvitePendingStatus: CommunityInviteStatus.Pending },
    );
    expect(clauses).toContain('"invite"."expires_at" > now()');
    const standingCall = queryBuilder.andWhere.mock.calls.find(
      (call: unknown[]) => String(call[0]).includes('"inviter_member"'),
    ) as [string, { liveInviteStaffRoles: string[] }];
    expect(standingCall[0]).toContain(
      '"invite"."invited_by_user_id" IS NULL OR EXISTS',
    );
    expect(standingCall[0]).toContain('"invite_community"."parent_id"');
    expect(standingCall[1].liveInviteStaffRoles).toEqual([
      ...COMMUNITY_STAFF_ROLES,
    ]);
    const blockClause = clauses.find((clause) =>
      clause.includes('"blocks" "invite_block"'),
    );
    expect(blockClause).toContain('NOT EXISTS');
    expect(blockClause).toContain(
      '"invite_block"."blocker_id" = "invite"."invited_user_id"',
    );
    expect(blockClause).toContain(
      '"invite_block"."blocker_id" = "invite"."invited_by_user_id"',
    );
  });

  it('whereInviteIsLive leaves out the block clause when shouldHonourBlocks is false', () => {
    const queryBuilder = recordingQueryBuilder();

    whereInviteIsLive(asSelectQueryBuilder(queryBuilder), 'invite', {
      shouldHonourBlocks: false,
    });

    const clauses = andWhereClauses(queryBuilder);
    expect(clauses).toHaveLength(3);
    expect(clauses).toContain('"invite"."expires_at" > now()');
    expect(clauses.some((clause) => clause.includes('"blocks"'))).toBe(false);
  });

  it('liveInvitedUserIds answers an empty set for an empty list without querying', async () => {
    const invites = { createQueryBuilder: jest.fn() };

    const invitedUserIds = await liveInvitedUserIds(
      invites as unknown as Repository<CommunityInvite>,
      'community-1',
      [],
    );

    expect(invitedUserIds.size).toBe(0);
    expect(invites.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('liveInvitedUserIds returns the ids of people holding a live invitation', async () => {
    const queryBuilder = recordingQueryBuilder({
      getRawMany: jest
        .fn()
        .mockResolvedValue([
          { invitedUserId: 'user-a' },
          { invitedUserId: 'user-b' },
        ]),
    });
    const invites = { createQueryBuilder: jest.fn(() => queryBuilder) };

    const invitedUserIds = await liveInvitedUserIds(
      invites as unknown as Repository<CommunityInvite>,
      'community-1',
      ['user-a', 'user-b', 'user-c'],
    );

    expect(invitedUserIds).toEqual(new Set(['user-a', 'user-b']));
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      '"live_invite"."invited_user_id" IN (:...userIds)',
      { userIds: ['user-a', 'user-b', 'user-c'] },
    );
    expect(andWhereClauses(queryBuilder)).toContain(
      '"live_invite"."expires_at" > now()',
    );
  });

  it('retireDeadPendingInvites flips pending rows for the named people to revoked', async () => {
    const execute = jest.fn().mockResolvedValue({ affected: 2 });
    const queryBuilder = recordingQueryBuilder({ execute });
    const invites = { createQueryBuilder: jest.fn(() => queryBuilder) };

    await retireDeadPendingInvites(
      invites as unknown as Repository<CommunityInvite>,
      'community-1',
      ['user-a', 'user-b'],
    );

    expect(queryBuilder.update).toHaveBeenCalledWith(CommunityInvite);
    const updateValues = onlyCallArgument<{
      status: CommunityInviteStatus;
      respondedAt: () => string;
      revokedByUserId?: unknown;
    }>(queryBuilder.set);
    expect(updateValues.status).toBe(CommunityInviteStatus.Revoked);
    expect(updateValues.respondedAt()).toBe('now()');
    expect(updateValues).not.toHaveProperty('revokedByUserId');
    expect(queryBuilder.where).toHaveBeenCalledWith(
      expect.stringContaining('status = :pending'),
      {
        communityId: 'community-1',
        userIds: ['user-a', 'user-b'],
        pending: CommunityInviteStatus.Pending,
      },
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('retireDeadPendingInvites writes nothing for an empty list', async () => {
    const invites = { createQueryBuilder: jest.fn() };

    await retireDeadPendingInvites(
      invites as unknown as Repository<CommunityInvite>,
      'community-1',
      [],
    );

    expect(invites.createQueryBuilder).not.toHaveBeenCalled();
  });
});
