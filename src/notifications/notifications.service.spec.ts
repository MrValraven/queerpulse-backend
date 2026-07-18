import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { Notification, NotificationType } from './entities/notification.entity';
import { NOTIFICATION_CREATED } from './notification.events';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let emit: jest.Mock;
  let blockFilter: {
    isBlockedEitherWay: jest.Mock;
    isMutedBy: jest.Mock;
  };
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };

  beforeEach(async () => {
    repo = {
      create: jest.fn((v) => v),
      save: jest.fn(async (v) => v),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      count: jest.fn().mockResolvedValue(0),
    };
    emit = jest.fn();
    blockFilter = {
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
      isMutedBy: jest.fn().mockResolvedValue(false),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: getRepositoryToken(Notification), useValue: repo },
        { provide: EventEmitter2, useValue: { emit } },
        { provide: BlockFilterService, useValue: blockFilter },
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

    it('announces only after the write, never before', async () => {
      const order: string[] = [];
      repo.save.mockImplementation(() => {
        order.push('save');
        return Promise.resolve({ id: 'n1', userId: 'u1' });
      });
      emit.mockImplementation(() => order.push('emit'));
      await service.create('u1', NotificationType.PromotedToMember);
      expect(order).toEqual(['save', 'emit']);
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
      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit).toHaveBeenCalledWith(NOTIFICATION_CREATED, {
        userId: 'u1',
        notification: expect.objectContaining({ id: 'n1' }) as unknown,
      });
      expect(emit).toHaveBeenCalledWith(NOTIFICATION_CREATED, {
        userId: 'u2',
        notification: expect.objectContaining({ id: 'n2' }) as unknown,
      });
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
      blockFilter.isBlockedEitherWay.mockImplementation((recipientId: string) =>
        Promise.resolve(recipientId === 'u1'),
      );
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
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('skips the write entirely when every recipient is filtered out', async () => {
      blockFilter.isBlockedEitherWay.mockResolvedValue(true);

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

  it('list filters to unread when requested', async () => {
    await service.list('u1', { unread: true });
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1', read: false } }),
    );
  });

  it('list reports a following page via the +1 probe row', async () => {
    // 21 rows for a page size of 20 → there is more.
    repo.find.mockResolvedValue(new Array(21).fill({ id: 'n' }));
    const page = await service.list('u1', { page: 1 });
    expect(page.items).toHaveLength(20);
    expect(page.hasMore).toBe(true);
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 21 }),
    );
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
