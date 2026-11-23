import { HttpException } from '@nestjs/common';
import { DataSource, FindOperator, IsNull, Repository } from 'typeorm';
import { CommunityGovernanceLogService } from '../communities/community-governance-log.service';
import { CommunityMembershipService } from '../communities/community-membership.service';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { GovernanceLogAction } from '../communities/entities/community-governance-log.entity';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { SCRUB_GIFT_NOTE_FROM_NOTIFICATION_SQL } from './community-gift-takedown';
import {
  ALLOWANCE_SQL,
  COMMUNITY_MEMBER_GIFT_MARKS_LIMIT,
  CommunityGiftsService,
  GIFT_SENDER_LOCK_SQL,
  MEMBER_MARKS_RECIPIENT_LISTED_SQL,
} from './community-gifts.service';
import { SendCommunityGiftDto } from './dto/community-badges.dto';
import { CommunityGift } from './entities/community-gift.entity';

const GIFT_UUID = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
const SENT_AT = new Date('2026-11-20T10:00:00.000Z');

/** One profile per test member: the sender mod-1, the recipient u2 and a
 * third member u3. */
const PROFILES: Array<Partial<Profile>> = [
  { userId: 'mod-1', slug: 'sam', firstName: 'Sam', lastName: 'Reis' },
  { userId: 'u2', slug: 'robin', firstName: 'Robin', lastName: 'Lima' },
  { userId: 'u3', slug: 'alex', firstName: 'Alex', lastName: 'Sousa' },
].map((profile) => ({
  pronouns: null,
  avatarUrl: null,
  photoVisible: true,
  ...profile,
}));

/** A query builder double that records every call and resolves the rows it
 * was given. */
function queryBuilderReturning(rows: Partial<CommunityGift>[]) {
  const builder = {
    select: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    limit: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    getMany: jest.fn().mockResolvedValue(rows),
    getManyAndCount: jest.fn().mockResolvedValue([rows, rows.length]),
  };
  for (const method of [
    'select',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'limit',
    'skip',
    'take',
  ] as const) {
    builder[method].mockReturnValue(builder);
  }
  return builder;
}

function giftRow(overrides: Partial<CommunityGift> = {}): CommunityGift {
  return {
    id: GIFT_UUID,
    communityId: 'c1',
    senderId: 'mod-1',
    recipientId: 'u2',
    giftKey: 'heart',
    note: 'thank you for the door',
    sentAt: SENT_AT,
    hiddenByRecipientAt: null,
    removedAt: null,
    removedById: null,
    ...overrides,
  };
}

function giftBody(
  overrides: Partial<Record<keyof SendCommunityGiftDto, unknown>> = {},
): SendCommunityGiftDto {
  return {
    recipientSlug: 'robin',
    giftKey: 'heart',
    note: 'thank you for the door',
    ...overrides,
  };
}

/** The response body of a rejected call. */
async function responseOfRejection(
  promise: Promise<unknown>,
): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    return (error as HttpException).getResponse() as Record<string, unknown>;
  }
  throw new Error('Expected the call to reject');
}

function collapsed(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('CommunityGiftsService', () => {
  let communities: { findOne: jest.Mock };
  let members: { exists: jest.Mock };
  let gifts: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: { createQueryBuilder: jest.Mock; find: jest.Mock };
  let manager: { query: jest.Mock; getRepository: jest.Mock };
  let dataSource: { transaction: jest.Mock; query: jest.Mock };
  let membership: { effectiveRole: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };
  let governanceLog: { log: jest.Mock };
  let blockFilter: { isBlockedEitherWay: jest.Mock };
  let notifications: { create: jest.Mock };
  let service: CommunityGiftsService;

  beforeEach(() => {
    communities = {
      findOne: jest.fn().mockResolvedValue({
        id: 'c1',
        slug: 'night-swim',
        name: 'Night swim',
        parentId: null,
        archivedAt: null,
        accessTier: AccessTier.Public,
        rosterVisible: true,
      }),
    };
    members = { exists: jest.fn().mockResolvedValue(true) };
    gifts = {
      create: jest.fn((values: Partial<CommunityGift>) => ({ ...values })),
      save: jest.fn((values: Partial<CommunityGift>) =>
        Promise.resolve({ ...values, id: 'gift-1', sentAt: SENT_AT }),
      ),
      findOne: jest.fn().mockResolvedValue(giftRow()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => queryBuilderReturning([])),
    };
    let requestedSlugs: string[] = [];
    const slugQuery: {
      innerJoin: jest.Mock;
      where: jest.Mock;
      getMany: jest.Mock;
    } = {
      innerJoin: jest.fn(),
      where: jest.fn((_sql: string, params: { slugs: string[] }) => {
        requestedSlugs = params.slugs;
        return slugQuery;
      }),
      getMany: jest.fn(() =>
        Promise.resolve(
          PROFILES.filter((profile) =>
            requestedSlugs.includes(profile.slug as string),
          ),
        ),
      ),
    };
    slugQuery.innerJoin.mockReturnValue(slugQuery);
    profiles = {
      createQueryBuilder: jest.fn(() => slugQuery),
      find: jest.fn(
        (options: { where: { userId: FindOperator<string[]> } }) => {
          const userIds = options.where.userId.value;
          return Promise.resolve(
            PROFILES.filter((profile) =>
              userIds.includes(profile.userId as string),
            ),
          );
        },
      ),
    };
    manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([{ used: 0, oldest_sent_at: null }]),
      getRepository: jest.fn(() => gifts),
    };
    dataSource = {
      transaction: jest.fn(
        (work: (transactionManager: typeof manager) => Promise<unknown>) =>
          work(manager),
      ),
      query: jest
        .fn()
        .mockResolvedValue([{ used: 1, oldest_sent_at: SENT_AT }]),
    };
    membership = { effectiveRole: jest.fn().mockResolvedValue(RosterRole.Mod) };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };
    governanceLog = { log: jest.fn().mockResolvedValue(undefined) };
    blockFilter = { isBlockedEitherWay: jest.fn().mockResolvedValue(false) };
    notifications = { create: jest.fn().mockResolvedValue(null) };
    service = new CommunityGiftsService(
      communities as unknown as Repository<Community>,
      members as unknown as Repository<CommunityMember>,
      gifts as unknown as Repository<CommunityGift>,
      profiles as unknown as Repository<Profile>,
      dataSource as unknown as DataSource,
      membership as unknown as CommunityMembershipService,
      contentModeration as unknown as ContentModerationService,
      governanceLog as unknown as CommunityGovernanceLogService,
      blockFilter as unknown as BlockFilterService,
      notifications as unknown as NotificationsService,
    );
  });

  describe('allowance', () => {
    it('answers the used count and the reset time of the oldest counted gift', async () => {
      await expect(service.allowance('night-swim', 'mod-1')).resolves.toEqual({
        limit: 10,
        used: 1,
        remaining: 9,
        resetsAt: '2026-11-27T10:00:00.000Z',
      });
      expect(dataSource.query).toHaveBeenCalledWith(ALLOWANCE_SQL, [
        'c1',
        'mod-1',
      ]);
    });

    it('answers a null reset time when nothing was sent', async () => {
      dataSource.query.mockResolvedValue([{ used: 0, oldest_sent_at: null }]);
      await expect(
        service.allowance('night-swim', 'mod-1'),
      ).resolves.toMatchObject({ used: 0, remaining: 10, resetsAt: null });
    });

    it('refuses a plain member with gift_sender_not_staff', async () => {
      membership.effectiveRole.mockResolvedValue(RosterRole.Member);
      expect(
        await responseOfRejection(service.allowance('night-swim', 'u2')),
      ).toEqual(expect.objectContaining({ code: 'gift_sender_not_staff' }));
    });
  });

  describe('send', () => {
    it('sends a gift, logs it without the note and notifies with the sender as actor', async () => {
      const response = await service.send('night-swim', 'mod-1', giftBody());
      expect(gifts.save).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: 'c1',
          senderId: 'mod-1',
          recipientId: 'u2',
          giftKey: 'heart',
          note: 'thank you for the door',
        }),
      );
      expect(governanceLog.log).toHaveBeenCalledWith(
        {
          communityId: 'c1',
          actorUserId: 'mod-1',
          action: GovernanceLogAction.GiftSent,
          targetUserId: 'u2',
          metadata: { giftId: 'gift-1', giftKey: 'heart' },
        },
        manager,
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'u2',
        NotificationType.CommunityGiftReceived,
        {
          communitySlug: 'night-swim',
          communityName: 'Night swim',
          giftId: 'gift-1',
          giftKey: 'heart',
          note: 'thank you for the door',
          senderId: 'mod-1',
        },
        'mod-1',
      );
      expect(response).toEqual({
        id: 'gift-1',
        giftKey: 'heart',
        note: 'thank you for the door',
        recipient: {
          slug: 'robin',
          firstName: 'Robin',
          lastName: 'Lima',
          pronouns: null,
          avatarUrl: null,
        },
        sentAt: '2026-11-20T10:00:00.000Z',
        allowance: {
          limit: 10,
          used: 1,
          remaining: 9,
          resetsAt: '2026-11-27T10:00:00.000Z',
        },
      });
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('builds the new allowance from the count taken under the lock', async () => {
      manager.query
        .mockReset()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([
          { used: 3, oldest_sent_at: new Date('2026-11-18T09:00:00.000Z') },
        ]);
      const response = await service.send('night-swim', 'mod-1', giftBody());
      expect(response.allowance).toEqual({
        limit: 10,
        used: 4,
        remaining: 6,
        resetsAt: '2026-11-25T09:00:00.000Z',
      });
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('takes the sender lock before counting', async () => {
      await service.send('night-swim', 'mod-1', giftBody());
      const order = manager.query.mock.calls.map(([sql]: [string]) => sql);
      expect(order.indexOf(GIFT_SENDER_LOCK_SQL)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(GIFT_SENDER_LOCK_SQL)).toBeLessThan(
        order.indexOf(ALLOWANCE_SQL),
      );
      expect(manager.query).toHaveBeenCalledWith(GIFT_SENDER_LOCK_SQL, [
        'community-gift:c1:mod-1',
      ]);
      expect(manager.query).toHaveBeenCalledWith(ALLOWANCE_SQL, [
        'c1',
        'mod-1',
      ]);
    });

    it('refuses the eleventh gift in 7 days with the reset time', async () => {
      manager.query
        .mockReset()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([
          { used: 10, oldest_sent_at: new Date('2026-11-18T09:00:00.000Z') },
        ]);
      expect(
        await responseOfRejection(
          service.send('night-swim', 'mod-1', giftBody()),
        ),
      ).toEqual(
        expect.objectContaining({
          statusCode: 429,
          code: 'gift_weekly_limit_reached',
          limit: 10,
          resetsAt: '2026-11-25T09:00:00.000Z',
        }),
      );
      expect(gifts.save).not.toHaveBeenCalled();
      expect(governanceLog.log).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('counts removed gifts toward the allowance', () => {
      expect(collapsed(ALLOWANCE_SQL)).not.toContain('removed_at');
      expect(collapsed(ALLOWANCE_SQL)).toContain(
        `"sent_at" > now() - interval '7 days'`,
      );
    });

    it.each<[string, string, () => void, Partial<SendCommunityGiftDto>]>([
      [
        'a plain member',
        'gift_sender_not_staff',
        () => membership.effectiveRole.mockResolvedValue(RosterRole.Member),
        {},
      ],
      [
        'a recipient off the roster',
        'gift_recipient_not_member',
        () => members.exists.mockResolvedValue(false),
        {},
      ],
      [
        'an unknown recipient slug',
        'gift_recipient_not_member',
        () => undefined,
        { recipientSlug: 'nobody-here' },
      ],
      [
        'the sender themself',
        'gift_to_self',
        () => undefined,
        { recipientSlug: 'sam' },
      ],
      [
        'a blocked recipient',
        'gift_recipient_unavailable',
        () => blockFilter.isBlockedEitherWay.mockResolvedValue(true),
        {},
      ],
    ])('refuses %s', async (_label, code, stageRow, bodyOverrides) => {
      stageRow();
      expect(
        await responseOfRejection(
          service.send('night-swim', 'mod-1', giftBody(bodyOverrides)),
        ),
      ).toEqual(expect.objectContaining({ code }));
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(gifts.save).not.toHaveBeenCalled();
    });

    it('checks the block in either direction between sender and recipient', async () => {
      await service.send('night-swim', 'mod-1', giftBody());
      expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith(
        'mod-1',
        'u2',
      );
    });

    it('lets a mod gift another mod', async () => {
      // The roster check reads only whether a row exists, so the recipient's
      // own role (mod here) never blocks a gift.
      await expect(
        service.send('night-swim', 'mod-1', giftBody()),
      ).resolves.toMatchObject({ id: 'gift-1' });
      expect(members.exists).toHaveBeenCalledWith({
        where: { communityId: 'c1', userId: 'u2' },
      });
    });

    it('keeps the gift when the notification fails', async () => {
      notifications.create.mockRejectedValue(new Error('bell offline'));
      await expect(
        service.send('night-swim', 'mod-1', giftBody()),
      ).resolves.toMatchObject({ id: 'gift-1' });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      await expect(
        dataSource.transaction.mock.results[0]?.value,
      ).resolves.toMatchObject({
        gift: expect.objectContaining({ id: 'gift-1' }),
      });
      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: GovernanceLogAction.GiftSent }),
        manager,
      );
      expect(notifications.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('listMine', () => {
    it('lists the caller shelf newest first with hidden gifts and without removed ones', async () => {
      const builder = queryBuilderReturning([
        giftRow({ hiddenByRecipientAt: new Date('2026-11-21T00:00:00.000Z') }),
        giftRow({ id: 'gift-2', senderId: null }),
      ]);
      gifts.createQueryBuilder.mockReturnValue(builder);
      membership.effectiveRole.mockResolvedValue(RosterRole.Member);

      const page = await service.listMine('night-swim', 'u2', 'not-a-page');

      expect(builder.where).toHaveBeenCalledWith(
        'gift.communityId = :communityId',
        { communityId: 'c1' },
      );
      expect(builder.andWhere).toHaveBeenCalledWith(
        'gift.recipientId = :userId',
        { userId: 'u2' },
      );
      expect(builder.andWhere).toHaveBeenCalledWith('gift.removedAt IS NULL');
      expect(builder.andWhere).not.toHaveBeenCalledWith(
        expect.stringContaining('hiddenByRecipientAt'),
      );
      expect(builder.orderBy).toHaveBeenCalledWith('gift.sentAt', 'DESC');
      expect(builder.addOrderBy).toHaveBeenCalledWith('gift.id', 'DESC');
      expect(builder.skip).toHaveBeenCalledWith(0);
      expect(page).toMatchObject({ total: 2, page: 1, pageSize: 20 });
      expect(page.items[0]).toMatchObject({
        id: GIFT_UUID,
        isHidden: true,
        note: 'thank you for the door',
        sender: expect.objectContaining({ slug: 'sam' }),
      });
      expect(page.items[1]).toMatchObject({ id: 'gift-2', sender: null });
      expect(profiles.find).toHaveBeenCalledTimes(1);
    });

    it('answers COMMUNITY_MEMBERS_ONLY to a visitor of a public community', async () => {
      membership.effectiveRole.mockResolvedValue(null);
      members.exists.mockResolvedValue(false);
      expect(
        await responseOfRejection(service.listMine('night-swim', 'u3')),
      ).toEqual(expect.objectContaining({ code: 'COMMUNITY_MEMBERS_ONLY' }));
      expect(gifts.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('setHidden', () => {
    it('hides a gift for its recipient', async () => {
      membership.effectiveRole.mockResolvedValue(RosterRole.Member);
      const response = await service.setHidden('night-swim', 'u2', GIFT_UUID, {
        isHidden: true,
      });
      expect(gifts.findOne).toHaveBeenCalledWith({
        where: {
          id: GIFT_UUID,
          communityId: 'c1',
          recipientId: 'u2',
          removedAt: IsNull(),
        },
      });
      expect(gifts.update).toHaveBeenCalledWith(
        { id: GIFT_UUID, removedAt: IsNull() },
        { hiddenByRecipientAt: expect.any(Date) },
      );
      expect(response).toMatchObject({ id: GIFT_UUID, isHidden: true });
    });

    it('clears the stamp when unhiding and writes nothing when unchanged', async () => {
      gifts.findOne.mockResolvedValue(
        giftRow({ hiddenByRecipientAt: new Date('2026-11-21T00:00:00.000Z') }),
      );
      await expect(
        service.setHidden('night-swim', 'u2', GIFT_UUID, { isHidden: false }),
      ).resolves.toMatchObject({ isHidden: false });
      expect(gifts.update).toHaveBeenCalledWith(
        { id: GIFT_UUID, removedAt: IsNull() },
        { hiddenByRecipientAt: null },
      );

      gifts.update.mockClear();
      gifts.findOne.mockResolvedValue(giftRow());
      await service.setHidden('night-swim', 'u2', GIFT_UUID, {
        isHidden: false,
      });
      expect(gifts.update).not.toHaveBeenCalled();
    });

    it('answers gift_not_found to anyone but the recipient and for a removed gift', async () => {
      gifts.findOne.mockResolvedValue(null);
      expect(
        await responseOfRejection(
          service.setHidden('night-swim', 'u3', GIFT_UUID, { isHidden: true }),
        ),
      ).toEqual(expect.objectContaining({ code: 'gift_not_found' }));
      expect(gifts.findOne).toHaveBeenCalledWith({
        where: expect.objectContaining({
          recipientId: 'u3',
          removedAt: IsNull(),
        }),
      });
      expect(
        await responseOfRejection(
          service.setHidden('night-swim', 'u2', 'gift-1', { isHidden: true }),
        ),
      ).toEqual(expect.objectContaining({ code: 'gift_not_found' }));
    });

    it('answers gift_not_found when the gift was removed before the write', async () => {
      gifts.update.mockResolvedValue({ affected: 0 });
      expect(
        await responseOfRejection(
          service.setHidden('night-swim', 'u2', GIFT_UUID, { isHidden: true }),
        ),
      ).toEqual(expect.objectContaining({ code: 'gift_not_found' }));
      expect(gifts.update).toHaveBeenCalledWith(
        { id: GIFT_UUID, removedAt: IsNull() },
        { hiddenByRecipientAt: expect.any(Date) },
      );
    });

    it('answers gift_hidden_invalid for a flag that is no boolean', async () => {
      expect(
        await responseOfRejection(
          service.setHidden('night-swim', 'u2', GIFT_UUID, { isHidden: 'yes' }),
        ),
      ).toEqual(expect.objectContaining({ code: 'gift_hidden_invalid' }));
      expect(gifts.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('lets the sender remove while still a member and logs it', async () => {
      await expect(
        service.remove('night-swim', 'mod-1', GIFT_UUID),
      ).resolves.toEqual({ id: GIFT_UUID });
      expect(gifts.update).toHaveBeenCalledWith(
        { id: GIFT_UUID, removedAt: IsNull() },
        { removedAt: expect.any(Date), removedById: 'mod-1' },
      );
      expect(governanceLog.log).toHaveBeenCalledWith(
        {
          communityId: 'c1',
          actorUserId: 'mod-1',
          action: GovernanceLogAction.GiftRemoved,
          targetUserId: 'u2',
          metadata: { giftId: GIFT_UUID, giftKey: 'heart' },
        },
        manager,
      );
    });

    it('scrubs the note from the recipient notification on the removal transaction', async () => {
      await service.remove('night-swim', 'mod-1', GIFT_UUID);
      expect(manager.query).toHaveBeenCalledWith(
        SCRUB_GIFT_NOTE_FROM_NOTIFICATION_SQL,
        [GIFT_UUID, 'u2'],
      );
    });

    it('lets a co-owner remove another staff member gift', async () => {
      membership.effectiveRole.mockResolvedValue(RosterRole.CoOwner);
      await expect(
        service.remove('night-swim', 'u3', GIFT_UUID),
      ).resolves.toEqual({ id: GIFT_UUID });
      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({ actorUserId: 'u3', targetUserId: 'u2' }),
        manager,
      );
    });

    it('refuses a mod who did not send it with gift_remove_not_allowed', async () => {
      expect(
        await responseOfRejection(
          service.remove('night-swim', 'u3', GIFT_UUID),
        ),
      ).toEqual(expect.objectContaining({ code: 'gift_remove_not_allowed' }));
      expect(gifts.update).not.toHaveBeenCalled();
    });

    it('refuses a sender who left the community', async () => {
      membership.effectiveRole.mockResolvedValue(null);
      expect(
        await responseOfRejection(
          service.remove('night-swim', 'mod-1', GIFT_UUID),
        ),
      ).toEqual(expect.objectContaining({ code: 'gift_remove_not_allowed' }));
    });

    it('answers gift_not_found for a gift already removed', async () => {
      gifts.findOne.mockResolvedValue(null);
      expect(
        await responseOfRejection(
          service.remove('night-swim', 'mod-1', GIFT_UUID),
        ),
      ).toEqual(expect.objectContaining({ code: 'gift_not_found' }));
      expect(gifts.findOne).toHaveBeenCalledWith({
        where: { id: GIFT_UUID, communityId: 'c1', removedAt: IsNull() },
      });
    });

    it('answers gift_not_found when a parallel removal won the race', async () => {
      gifts.update.mockResolvedValue({ affected: 0 });
      expect(
        await responseOfRejection(
          service.remove('night-swim', 'mod-1', GIFT_UUID),
        ),
      ).toEqual(expect.objectContaining({ code: 'gift_not_found' }));
      expect(governanceLog.log).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalledWith(
        SCRUB_GIFT_NOTE_FROM_NOTIFICATION_SQL,
        expect.anything(),
      );
    });
  });

  describe('listMemberMarks', () => {
    let builder: ReturnType<typeof queryBuilderReturning>;

    beforeEach(() => {
      builder = queryBuilderReturning([
        { id: 'gift-1', giftKey: 'heart', sentAt: SENT_AT, senderId: 'mod-1' },
      ]);
      gifts.createQueryBuilder.mockReturnValue(builder);
      membership.effectiveRole.mockResolvedValue(RosterRole.Member);
    });

    it('lists visible marks without sender or note', async () => {
      const response = await service.listMemberMarks(
        'night-swim',
        'u3',
        'robin',
      );
      expect(response.gifts[0]).toEqual({
        id: 'gift-1',
        giftKey: 'heart',
        sentAt: '2026-11-20T10:00:00.000Z',
        canRemove: false,
      });
      expect(builder.andWhere).toHaveBeenCalledWith(
        'gift.recipientId = :memberId',
        { memberId: 'u2' },
      );
      expect(builder.andWhere).toHaveBeenCalledWith('gift.removedAt IS NULL');
      expect(builder.andWhere).toHaveBeenCalledWith(
        'gift.hiddenByRecipientAt IS NULL',
      );
      expect(builder.andWhere).toHaveBeenCalledWith(
        `"gift"."sent_at" > now() - interval '7 days'`,
      );
      expect(builder.orderBy).toHaveBeenCalledWith('gift.sentAt', 'DESC');
      expect(builder.addOrderBy).toHaveBeenCalledWith('gift.id', 'DESC');
      expect(builder.limit).toHaveBeenCalledWith(
        COMMUNITY_MEMBER_GIFT_MARKS_LIMIT,
      );
      expect(COMMUNITY_MEMBER_GIFT_MARKS_LIMIT).toBe(50);
    });

    it('marks a gift removable for its sender and for an owner-level viewer', async () => {
      membership.effectiveRole.mockResolvedValue(RosterRole.Mod);
      expect(
        (await service.listMemberMarks('night-swim', 'mod-1', 'robin')).gifts[0]
          ?.canRemove,
      ).toBe(true);
      membership.effectiveRole.mockResolvedValue(RosterRole.Owner);
      expect(
        (await service.listMemberMarks('night-swim', 'u3', 'robin')).gifts[0]
          ?.canRemove,
      ).toBe(true);
    });

    it('answers an empty list for a slug off the roster', async () => {
      await expect(
        service.listMemberMarks('night-swim', 'u3', 'nobody-here'),
      ).resolves.toEqual({ gifts: [] });
      members.exists.mockResolvedValue(false);
      await expect(
        service.listMemberMarks('night-swim', 'u3', 'robin'),
      ).resolves.toEqual({ gifts: [] });
      expect(gifts.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('answers an empty list to a viewer blocked either way below staff', async () => {
      blockFilter.isBlockedEitherWay.mockResolvedValue(true);
      await expect(
        service.listMemberMarks('night-swim', 'u3', 'robin'),
      ).resolves.toEqual({ gifts: [] });
      expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith('u3', 'u2');
      expect(gifts.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('shows the marks to staff whatever the block', async () => {
      membership.effectiveRole.mockResolvedValue(RosterRole.Mod);
      blockFilter.isBlockedEitherWay.mockResolvedValue(true);
      const response = await service.listMemberMarks(
        'night-swim',
        'u3',
        'robin',
      );
      expect(response.gifts).toHaveLength(1);
    });

    it('answers an empty list to a visitor when the roster is private to members', async () => {
      membership.effectiveRole.mockResolvedValue(null);
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'night-swim',
        name: 'Night swim',
        parentId: null,
        archivedAt: null,
        accessTier: AccessTier.Public,
        rosterVisible: false,
      });
      await expect(
        service.listMemberMarks('night-swim', 'u3', 'robin'),
      ).resolves.toEqual({ gifts: [] });
      expect(members.exists).not.toHaveBeenCalled();
      expect(gifts.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('lists the marks to a visitor of a public roster', async () => {
      membership.effectiveRole.mockResolvedValue(null);
      const response = await service.listMemberMarks(
        'night-swim',
        'u3',
        'robin',
      );
      expect(response.gifts).toHaveLength(1);
    });

    it('leaves out a paused, suspended or hidden member for every other viewer, staff included', async () => {
      membership.effectiveRole.mockResolvedValue(RosterRole.Owner);
      await service.listMemberMarks('night-swim', 'u3', 'robin');
      expect(builder.andWhere).toHaveBeenCalledWith(
        MEMBER_MARKS_RECIPIENT_LISTED_SQL,
        { markMemberActiveStatus: 'active' },
      );
      expect(collapsed(MEMBER_MARKS_RECIPIENT_LISTED_SQL)).toContain(
        `"mark_member"."status" = :markMemberActiveStatus AND ( "mark_profile"."hidden_until" IS NULL OR "mark_profile"."hidden_until" <= now() )`,
      );
      expect(collapsed(MEMBER_MARKS_RECIPIENT_LISTED_SQL)).toContain(
        `"mark_member"."id" = "gift"."recipient_id"`,
      );
    });

    it('always shows the member their own marks', async () => {
      const response = await service.listMemberMarks(
        'night-swim',
        'u2',
        'robin',
      );
      expect(response.gifts).toHaveLength(1);
      expect(builder.andWhere).not.toHaveBeenCalledWith(
        MEMBER_MARKS_RECIPIENT_LISTED_SQL,
        expect.anything(),
      );
    });

    it('offers no remove action to a sender who left the community', async () => {
      membership.effectiveRole.mockResolvedValue(null);
      expect(
        (await service.listMemberMarks('night-swim', 'mod-1', 'robin')).gifts[0]
          ?.canRemove,
      ).toBe(false);
    });
  });
});
