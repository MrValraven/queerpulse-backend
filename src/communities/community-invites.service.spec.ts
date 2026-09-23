import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { CommunitiesService } from './communities.service';
import { CommunityInviteSkipReason } from './community-invites-response';
import { CommunityInvitesService } from './community-invites.service';
import { CommunityBan } from './entities/community-ban.entity';
import { CommunityInvite } from './entities/community-invite.entity';
import { CommunityJoinRequest } from './entities/community-join-request.entity';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { Community } from './entities/community.entity';

const INVITER_ID = 'inviter';
const PARENT_ID = 'parent-1';
const SPACE = {
  id: 'space-1',
  slug: 'parents-circle',
  name: 'Parents circle',
  parentId: PARENT_ID,
  archivedAt: null,
};

// The profile slugs named in the invite, and whose account each one is.
const PROFILE_ROWS = [
  { slug: 'in-parent', userId: 'user-in-parent' },
  { slug: 'outsider', userId: 'user-outsider' },
  { slug: 'banned-in-parent', userId: 'user-banned-in-parent' },
];

type WhereClause = { communityId?: unknown; userId?: unknown };

function chainStub(
  terminal: Record<string, jest.Mock>,
): Record<string, jest.Mock> {
  const chain: Record<string, jest.Mock> = { ...terminal };
  for (const method of [
    'innerJoin',
    'where',
    'insert',
    'into',
    'values',
    'orIgnore',
    'returning',
  ]) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  return chain;
}

describe('CommunityInvitesService.invite on a space', () => {
  let service: CommunityInvitesService;
  let members: { findOne: jest.Mock; find: jest.Mock };
  let bans: { find: jest.Mock };
  let insertChain: Record<string, jest.Mock>;
  let notifications: { createForRecipients: jest.Mock };

  beforeEach(async () => {
    members = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn((options: { where: WhereClause }) => {
        const { communityId } = options.where;
        // The staff check reads the space row and the parent row in one
        // `In([...])` lookup: the inviter moderates the parent.
        if (typeof communityId !== 'string') {
          return Promise.resolve([
            {
              communityId: PARENT_ID,
              userId: INVITER_ID,
              role: RosterRole.Mod,
            },
          ]);
        }
        if (communityId === PARENT_ID) {
          return Promise.resolve([
            { userId: 'user-in-parent' },
            { userId: 'user-banned-in-parent' },
          ]);
        }
        return Promise.resolve([]);
      }),
    };
    bans = {
      find: jest.fn((options: { where: WhereClause[] }) =>
        Promise.resolve(
          options.where[0]?.communityId === PARENT_ID
            ? [{ userId: 'user-banned-in-parent' }]
            : [],
        ),
      ),
    };
    insertChain = chainStub({
      execute: jest.fn().mockResolvedValue({
        raw: [{ id: 'invite-1', invited_user_id: 'user-in-parent' }],
      }),
    });
    notifications = {
      createForRecipients: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityInvitesService,
        {
          provide: getRepositoryToken(Community),
          useValue: { findOne: jest.fn().mockResolvedValue(SPACE) },
        },
        { provide: getRepositoryToken(CommunityMember), useValue: members },
        {
          provide: getRepositoryToken(CommunityJoinRequest),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: getRepositoryToken(CommunityBan), useValue: bans },
        {
          provide: getRepositoryToken(CommunityInvite),
          useValue: {
            find: jest.fn().mockResolvedValue([]),
            createQueryBuilder: jest.fn(() => insertChain),
          },
        },
        {
          provide: getRepositoryToken(Profile),
          useValue: {
            createQueryBuilder: jest.fn(() =>
              chainStub({ getMany: jest.fn().mockResolvedValue(PROFILE_ROWS) }),
            ),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: NotificationsService, useValue: notifications },
        { provide: ContentModerationService, useValue: {} },
        { provide: CommunitiesService, useValue: {} },
      ],
    }).compile();
    service = module.get(CommunityInvitesService);
  });

  it('invites parent members only and passes over outsiders and parent bans', async () => {
    const result = await service.invite(SPACE.slug, INVITER_ID, {
      memberSlugs: ['in-parent', 'outsider', 'banned-in-parent'],
    });

    expect(result.invited).toEqual(['in-parent']);
    expect(result.skipped).toEqual([
      {
        slug: 'outsider',
        reason: CommunityInviteSkipReason.NotParentMember,
      },
      { slug: 'banned-in-parent', reason: CommunityInviteSkipReason.Banned },
    ]);
  });

  it('writes no invitation row and sends no bell to anyone outside the parent', async () => {
    await service.invite(SPACE.slug, INVITER_ID, {
      memberSlugs: ['in-parent', 'outsider', 'banned-in-parent'],
    });

    expect(insertChain.values).toHaveBeenCalledWith([
      expect.objectContaining({ invitedUserId: 'user-in-parent' }),
    ]);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['user-in-parent'],
      NotificationType.CommunityInviteReceived,
      expect.objectContaining({ communitySlug: SPACE.slug }),
      INVITER_ID,
    );
  });
});
