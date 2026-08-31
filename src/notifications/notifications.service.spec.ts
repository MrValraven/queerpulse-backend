import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { Mute } from '../social/entities/mute.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { Notification, NotificationType } from './entities/notification.entity';
import { NotificationPreferencesService } from './notification-preferences.service';
import {
  NOTIFICATION_BATCH_CREATED,
  NOTIFICATION_CREATED,
} from './notification.events';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let emit: jest.Mock;
  let blockFilter: {
    isBlockedEitherWay: jest.Mock;
    isMutedBy: jest.Mock;
    blockedUserIds: jest.Mock;
  };
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
  let profileRepo: { find: jest.Mock };
  let muteRepo: { find: jest.Mock };
  let userRepo: { find: jest.Mock };
  let communityRepo: { findOne: jest.Mock };
  let communityMemberRepo: { find: jest.Mock };
  let notificationPreferences: {
    isInAppEnabled: jest.Mock;
    recipientsInAppEnabled: jest.Mock;
  };

  beforeEach(async () => {
    repo = {
      create: jest.fn((value: unknown) => value),
      save: jest.fn((value: unknown) => value),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      count: jest.fn().mockResolvedValue(0),
    };
    profileRepo = { find: jest.fn().mockResolvedValue([]) };
    muteRepo = { find: jest.fn().mockResolvedValue([]) };
    // Only consulted on the fan-out's dangling-recipient recovery path, so the
    // default is "never asked".
    userRepo = { find: jest.fn().mockResolvedValue([]) };
    // Community volume gating short-circuits for every type outside
    // COMMUNITY_LEVELS_WANTING, so these exist for injection more than for
    // behaviour.
    communityRepo = { findOne: jest.fn().mockResolvedValue(null) };
    communityMemberRepo = { find: jest.fn().mockResolvedValue([]) };
    emit = jest.fn();
    blockFilter = {
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
      isMutedBy: jest.fn().mockResolvedValue(false),
      // Batched, either-way block lookup used by the fan-out path.
      blockedUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    };
    // Default: every category is on (no stored override) — the single-create
    // gate lets everything through, and the fan-out gate echoes its input back.
    notificationPreferences = {
      isInAppEnabled: jest.fn().mockResolvedValue(true),
      recipientsInAppEnabled: jest
        .fn()
        .mockImplementation((userIds: string[]) => Promise.resolve(userIds)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: getRepositoryToken(Notification), useValue: repo },
        { provide: getRepositoryToken(Profile), useValue: profileRepo },
        { provide: getRepositoryToken(Mute), useValue: muteRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(Community), useValue: communityRepo },
        {
          provide: getRepositoryToken(CommunityMember),
          useValue: communityMemberRepo,
        },
        { provide: EventEmitter2, useValue: { emit } },
        { provide: BlockFilterService, useValue: blockFilter },
        {
          provide: NotificationPreferencesService,
          useValue: notificationPreferences,
        },
      ],
    }).compile();
    service = module.get(NotificationsService);
  });

  describe('NOTIFICATION_CREATED announcements', () => {
    it('announces the persisted row so the gateway can push it', async () => {
      repo.save.mockResolvedValue({
        id: 'n1',
        userId: 'u1',
        type: NotificationType.VouchReceived,
        payload: { voucherId: 'u2' },
        read: false,
      });
      await service.create('u1', NotificationType.VouchReceived, {
        voucherId: 'u2',
      });
      expect(emit).toHaveBeenCalledWith(NOTIFICATION_CREATED, {
        userId: 'u1',
        notification: expect.objectContaining({
          id: 'n1',
          userId: 'u1',
        }) as unknown,
      });
    });

    it('also fires ONE NOTIFICATION_BATCH_CREATED per write, for the push listener', async () => {
      repo.save.mockResolvedValue({
        id: 'n1',
        userId: 'u1',
        type: NotificationType.VouchReceived,
        payload: { voucherId: 'u2' },
        read: false,
      });
      await service.create(
        'u1',
        NotificationType.VouchReceived,
        { voucherId: 'u2' },
        'u2',
      );
      expect(emit).toHaveBeenCalledWith(NOTIFICATION_BATCH_CREATED, {
        userIds: ['u1'],
        type: NotificationType.VouchReceived,
        payload: { voucherId: 'u2' },
        actorId: 'u2',
        notification: expect.objectContaining({ id: 'n1' }) as unknown,
      });
    });

    it('announces only after the write, never before', async () => {
      const order: string[] = [];
      repo.save.mockImplementation(() => {
        order.push('save');
        return Promise.resolve({ id: 'n1', userId: 'u1' });
      });
      emit.mockImplementation(() => order.push('emit'));
      await service.create('u1', NotificationType.PromotedToMember);
      // One NOTIFICATION_CREATED (socket) + one NOTIFICATION_BATCH_CREATED
      // (push) — both only after the save.
      expect(order).toEqual(['save', 'emit', 'emit']);
    });

    it('announces once per recipient with that recipient as the target', async () => {
      repo.save.mockResolvedValue([
        { id: 'n1', userId: 'u1' },
        { id: 'n2', userId: 'u2' },
      ]);
      await service.createForRecipients(
        ['u1', 'u2'],
        NotificationType.NewMessage,
        { conversationId: 'c1' },
      );
      expect(emit).toHaveBeenCalledWith(NOTIFICATION_CREATED, {
        userId: 'u1',
        notification: expect.objectContaining({ id: 'n1' }) as unknown,
      });
      expect(emit).toHaveBeenCalledWith(NOTIFICATION_CREATED, {
        userId: 'u2',
        notification: expect.objectContaining({ id: 'n2' }) as unknown,
      });
    });

    it('fires exactly ONE NOTIFICATION_BATCH_CREATED for a whole fan-out, carrying every recipient — the fix for the push N+1', async () => {
      repo.save.mockResolvedValue([
        { id: 'n1', userId: 'u1' },
        { id: 'n2', userId: 'u2' },
        { id: 'n3', userId: 'u3' },
      ]);
      await service.createForRecipients(
        ['u1', 'u2', 'u3'],
        NotificationType.EventUpdated,
        { title: 'Trivia Night', eventSlug: 'trivia-night' },
        'organizer-1',
      );
      // 3 per-row NOTIFICATION_CREATED (socket) + exactly 1
      // NOTIFICATION_BATCH_CREATED (push) — not 3.
      expect(emit).toHaveBeenCalledTimes(4);
      const batchCalls = emit.mock.calls.filter(
        (call: [string, unknown]) => call[0] === NOTIFICATION_BATCH_CREATED,
      ) as [string, unknown][];
      expect(batchCalls).toHaveLength(1);
      const [, batchEventPayload] = batchCalls[0] as [string, unknown];
      expect(batchEventPayload).toEqual({
        userIds: ['u1', 'u2', 'u3'],
        type: NotificationType.EventUpdated,
        payload: { title: 'Trivia Night', eventSlug: 'trivia-night' },
        actorId: 'organizer-1',
        notification: expect.objectContaining({ id: 'n1' }) as unknown,
      });
    });
  });

  // `save([...])` is one multi-row statement in one transaction, so before the
  // recovery path below a single recipient id that no longer named a user took
  // the whole fan-out down with it: every other matching member silently lost
  // their notification, on every new listing, until someone hand-deleted the
  // dangling row.
  describe('dangling recipient recovery', () => {
    const foreignKeyViolation = Object.assign(new Error('insert failed'), {
      code: '23503',
      constraint: 'FK_notifications_user_id',
    });

    it('keeps the rest of the batch when one recipient no longer names a user', async () => {
      repo.save
        .mockRejectedValueOnce(foreignKeyViolation)
        .mockResolvedValueOnce([
          { id: 'n1', userId: 'u1' },
          { id: 'n3', userId: 'u3' },
        ]);
      // `u2` was erased; its saved-search row outlived it.
      userRepo.find.mockResolvedValue([{ id: 'u1' }, { id: 'u3' }]);

      const saved = await service.createForRecipients(
        ['u1', 'u2', 'u3'],
        NotificationType.HousingListingMatch,
        { slug: 'sunny-room' },
      );

      expect(saved).toEqual(['u1', 'u3']);
      // The retry carries only the recipients that still exist.
      const saveCalls = repo.save.mock.calls as [{ userId: string }[]][];
      const [retriedRows] = saveCalls[1] ?? [[]];
      expect((retriedRows ?? []).map((row) => row.userId)).toEqual([
        'u1',
        'u3',
      ]);
    });

    it('announces only the recipients that actually hold a row', async () => {
      repo.save
        .mockRejectedValueOnce(foreignKeyViolation)
        .mockResolvedValueOnce([{ id: 'n1', userId: 'u1' }]);
      userRepo.find.mockResolvedValue([{ id: 'u1' }]);

      await service.createForRecipients(
        ['u1', 'u2'],
        NotificationType.HousingListingMatch,
        { slug: 'sunny-room' },
      );

      const batchCalls = emit.mock.calls.filter(
        (call: [string, unknown]) => call[0] === NOTIFICATION_BATCH_CREATED,
      ) as [string, { userIds: string[] }][];
      expect(batchCalls).toHaveLength(1);
      const [, batchEventPayload] = batchCalls[0] ?? ['', { userIds: [] }];
      expect(batchEventPayload.userIds).toEqual(['u1']);
    });

    it('writes nothing and announces nothing when every recipient is dangling', async () => {
      repo.save.mockRejectedValueOnce(foreignKeyViolation);
      userRepo.find.mockResolvedValue([]);

      const saved = await service.createForRecipients(
        ['u1'],
        NotificationType.HousingListingMatch,
        { slug: 'sunny-room' },
      );

      expect(saved).toEqual([]);
      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(emit).not.toHaveBeenCalled();
    });

    it('rethrows anything that is not a violation of the recipient foreign key', async () => {
      const deadlock = Object.assign(new Error('deadlock detected'), {
        code: '40P01',
      });
      repo.save.mockRejectedValueOnce(deadlock);

      await expect(
        service.createForRecipients(
          ['u1', 'u2'],
          NotificationType.HousingListingMatch,
          { slug: 'sunny-room' },
        ),
      ).rejects.toBe(deadlock);
      // No speculative retry, and no pointless existence lookup.
      expect(userRepo.find).not.toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalledTimes(1);
    });
  });

  // Block/mute enforcement is at WRITE time: suppressing the row also
  // suppresses the `NOTIFICATION_CREATED` push, which a read-time filter in
  // `list()` could never have taken back. See `NotificationsService.create`.
  describe('block/mute suppression', () => {
    it('writes nothing and pushes nothing when the actor is blocked either way', async () => {
      blockFilter.isBlockedEitherWay.mockResolvedValue(true);

      const result = await service.create(
        'u1',
        NotificationType.VouchReceived,
        { voucherId: 'u2' },
        'u2',
      );

      expect(result).toBeNull();
      expect(repo.save).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('writes nothing when the recipient has muted the actor', async () => {
      blockFilter.isMutedBy.mockResolvedValue(true);

      const result = await service.create(
        'u1',
        NotificationType.VouchReceived,
        { voucherId: 'u2' },
        'u2',
      );

      expect(result).toBeNull();
      expect(repo.save).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('checks the relationship from the recipient toward the actor', async () => {
      await service.create(
        'u1',
        NotificationType.VouchReceived,
        { voucherId: 'u2' },
        'u2',
      );

      expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith('u1', 'u2');
      expect(blockFilter.isMutedBy).toHaveBeenCalledWith('u1', 'u2');
    });

    it('leaves actorless (system) notifications unfiltered', async () => {
      blockFilter.isBlockedEitherWay.mockResolvedValue(true);
      repo.save.mockResolvedValue({ id: 'n1', userId: 'u1' });

      await service.create('u1', NotificationType.PromotedToMember);

      expect(blockFilter.isBlockedEitherWay).not.toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalled();
    });

    it('suppresses only the recipients who blocked the actor, not the whole fan-out', async () => {
      blockFilter.blockedUserIds.mockResolvedValue(new Set(['u1']));
      repo.save.mockResolvedValue([{ id: 'n2', userId: 'u2' }]);

      await service.createForRecipients(
        ['u1', 'u2'],
        NotificationType.NewMessage,
        { conversationId: 'c1' },
        'sender-1',
      );

      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u2' }),
      );
      // One per-row NOTIFICATION_CREATED (socket) + one NOTIFICATION_BATCH_CREATED
      // (push) for the single surviving recipient.
      expect(emit).toHaveBeenCalledTimes(2);
    });

    it('drops a fan-out recipient who has muted the actor', async () => {
      // One batched `mutes` lookup: `u1` muted the actor, `u2` did not.
      muteRepo.find.mockResolvedValue([{ muterId: 'u1' }]);
      repo.save.mockResolvedValue([{ id: 'n2', userId: 'u2' }]);

      await service.createForRecipients(
        ['u1', 'u2'],
        NotificationType.NewMessage,
        { conversationId: 'c1' },
        'sender-1',
      );

      expect(muteRepo.find).toHaveBeenCalledTimes(1);
      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u2' }),
      );
      // One per-row NOTIFICATION_CREATED (socket) + one NOTIFICATION_BATCH_CREATED
      // (push) for the single surviving recipient.
      expect(emit).toHaveBeenCalledTimes(2);
    });

    it('skips the write entirely when every recipient is filtered out', async () => {
      blockFilter.blockedUserIds.mockResolvedValue(new Set(['u1', 'u2']));

      await service.createForRecipients(
        ['u1', 'u2'],
        NotificationType.NewMessage,
        { conversationId: 'c1' },
        'sender-1',
      );

      expect(repo.save).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('announces nothing when there are no recipients', async () => {
      await service.createForRecipients([], NotificationType.NewMessage);
      expect(repo.save).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });
  });

  // The member's own per-category switch, gated at the same write time as
  // block/mute (so a suppressed row also suppresses its push).
  describe('per-category preference suppression', () => {
    it('writes nothing when the recipient disabled the category', async () => {
      notificationPreferences.isInAppEnabled.mockResolvedValue(false);

      const result = await service.create(
        'u1',
        NotificationType.EventInvite,
        { inviterId: 'u2' },
        'u2',
      );

      expect(result).toBeNull();
      expect(repo.save).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('drops only the fan-out recipients who disabled the category', async () => {
      notificationPreferences.recipientsInAppEnabled.mockResolvedValue(['u2']);
      repo.save.mockResolvedValue([{ id: 'n2', userId: 'u2' }]);

      await service.createForRecipients(
        ['u1', 'u2'],
        NotificationType.CommunityReply,
        { actorId: 'sender-1' },
        'sender-1',
      );

      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u2' }),
      );
      // One per-row NOTIFICATION_CREATED (socket) + one NOTIFICATION_BATCH_CREATED
      // (push) for the single surviving recipient.
      expect(emit).toHaveBeenCalledTimes(2);
    });
  });

  it('list filters to unread when requested', async () => {
    await service.list('u1', { unread: true });
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1', read: false } }),
    );
  });

  it('returns the canonical offset envelope with an authoritative total', async () => {
    // A full page of 20 rows, with the count reporting 21 in total → the client
    // derives "there is a next page" from `page * pageSize < total`.
    repo.find.mockResolvedValue(new Array(20).fill({ id: 'n' }));
    repo.count.mockResolvedValue(21);
    const page = await service.list('u1', { page: 1 });
    expect(page.items).toHaveLength(20);
    expect(page.total).toBe(21);
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(20);
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 20 }),
    );
  });

  it('enriches list rows with the acting member (name, slug, avatar)', async () => {
    repo.find.mockResolvedValue([
      {
        id: 'n1',
        userId: 'u1',
        type: NotificationType.ConnectionAccepted,
        payload: { byUserId: 'u2', connectionId: 'c1' },
        read: false,
        createdAt: new Date('2026-07-20T00:00:00.000Z'),
      },
    ]);
    profileRepo.find.mockResolvedValue([
      {
        userId: 'u2',
        slug: 'ines',
        firstName: 'Inês',
        lastName: 'Tavares',
        avatarUrl: null,
      },
    ]);

    const page = await service.list('u1');

    expect(profileRepo.find).toHaveBeenCalledTimes(1);
    expect(page.items[0]!.actor).toEqual(
      expect.objectContaining({ slug: 'ines', firstName: 'Inês' }),
    );
  });

  it('leaves system notifications with a null actor and skips the profile lookup', async () => {
    repo.find.mockResolvedValue([
      {
        id: 'n1',
        userId: 'u1',
        type: NotificationType.WaitlistPromoted,
        payload: { eventId: 'e1' },
        read: false,
        createdAt: new Date('2026-07-20T00:00:00.000Z'),
      },
    ]);

    const page = await service.list('u1');

    expect(page.items[0]!.actor).toBeNull();
    expect(profileRepo.find).not.toHaveBeenCalled();
  });

  it('unreadCount counts unread notifications for the owner', async () => {
    repo.count.mockResolvedValue(4);
    await expect(service.unreadCount('u1')).resolves.toBe(4);
    expect(repo.count).toHaveBeenCalledWith({
      where: { userId: 'u1', read: false },
    });
  });

  it('markRead 404s when nothing was updated', async () => {
    repo.update.mockResolvedValue({ affected: 0 });
    await expect(service.markRead('n1', 'u1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('markRead scopes to the owner', async () => {
    await service.markRead('n1', 'u1');
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'n1', userId: 'u1' },
      { read: true },
    );
  });
});
