import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Notification, NotificationType } from './entities/notification.entity';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  let service: NotificationsService;
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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: getRepositoryToken(Notification), useValue: repo },
      ],
    }).compile();
    service = module.get(NotificationsService);
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
