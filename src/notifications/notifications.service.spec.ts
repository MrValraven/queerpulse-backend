import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Notification, NotificationType } from './entities/notification.entity';
import { NOTIFICATION_CREATED } from './notification.events';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let emit: jest.Mock;
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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: getRepositoryToken(Notification), useValue: repo },
        { provide: EventEmitter2, useValue: { emit } },
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
