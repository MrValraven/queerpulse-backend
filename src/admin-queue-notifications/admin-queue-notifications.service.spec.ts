import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { AdminQueueKey } from './admin-queue.registry';
import { AdminQueueNotificationsService } from './admin-queue-notifications.service';

describe('AdminQueueNotificationsService', () => {
  let service: AdminQueueNotificationsService;
  let usersFind: jest.Mock;
  let grantsFind: jest.Mock;
  let createForRecipients: jest.Mock;

  beforeEach(async () => {
    usersFind = jest.fn().mockResolvedValue([]);
    grantsFind = jest.fn().mockResolvedValue([]);
    createForRecipients = jest.fn().mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminQueueNotificationsService,
        { provide: getRepositoryToken(User), useValue: { find: usersFind } },
        {
          provide: getRepositoryToken(UserStaffRole),
          useValue: { find: grantsFind },
        },
        { provide: NotificationsService, useValue: { createForRecipients } },
      ],
    }).compile();

    service = moduleRef.get(AdminQueueNotificationsService);
  });

  it('reaches both staff tiers for a moderator-tier queue', async () => {
    usersFind.mockResolvedValueOnce([{ id: 'moderator-1' }, { id: 'admin-1' }]);

    await service.announce(AdminQueueKey.InviteRequests, 'request-1');

    const [whereClause] = usersFind.mock.calls[0];
    expect(whereClause.where.role._value).toEqual([
      UserRole.Moderator,
      UserRole.Admin,
    ]);
    expect(whereClause.where.status).toBe(UserStatus.Active);
    expect(createForRecipients).toHaveBeenCalledWith(
      ['moderator-1', 'admin-1'],
      NotificationType.AdminQueueItem,
      { source: 'admin', queue: 'invite_requests', itemId: 'request-1' },
    );
  });

  it('reaches admins only for an admin-tier queue', async () => {
    usersFind.mockResolvedValueOnce([{ id: 'admin-1' }]);

    await service.announce(AdminQueueKey.LegalRequests);

    const [whereClause] = usersFind.mock.calls[0];
    expect(whereClause.where.role._value).toEqual([UserRole.Admin]);
    expect(createForRecipients).toHaveBeenCalledWith(
      ['admin-1'],
      NotificationType.AdminQueueItem,
      { source: 'admin', queue: 'legal_requests' },
    );
  });

  it('also reaches active grant holders for a capability queue', async () => {
    usersFind
      .mockResolvedValueOnce([{ id: 'admin-1' }])
      .mockResolvedValueOnce([{ id: 'curator-1' }]);
    grantsFind.mockResolvedValueOnce([
      { userId: 'curator-1' },
      { userId: 'curator-2' },
    ]);

    await service.announce(AdminQueueKey.ResourceSuggestions);

    // The second `users.find` call is the active-status re-check on the
    // grant holders. Asserting its where-clause is what would catch a
    // regression that dropped the `status: Active` filter and let a
    // suspended grant holder keep receiving duty mail.
    const [secondWhereClause] = usersFind.mock.calls[1];
    expect(secondWhereClause.where.id._value).toEqual([
      'curator-1',
      'curator-2',
    ]);
    expect(secondWhereClause.where.status).toBe(UserStatus.Active);

    // `curator-2` is filtered out by the second users lookup, which asks only
    // for the active ones.
    expect(createForRecipients).toHaveBeenCalledWith(
      ['admin-1', 'curator-1'],
      NotificationType.AdminQueueItem,
      { source: 'admin', queue: 'resource_suggestions' },
    );
  });

  it('never reaches a grant holder for the safe-space flag queue', async () => {
    usersFind.mockResolvedValueOnce([{ id: 'admin-1' }]);

    await service.announce(AdminQueueKey.SafeSpaceFlags);

    expect(grantsFind).not.toHaveBeenCalled();
    expect(createForRecipients).toHaveBeenCalledWith(
      ['admin-1'],
      NotificationType.AdminQueueItem,
      { source: 'admin', queue: 'safe_space_flags' },
    );
  });

  it('deduplicates someone who holds both a tier and a grant', async () => {
    usersFind
      .mockResolvedValueOnce([{ id: 'admin-1' }])
      .mockResolvedValueOnce([]);
    grantsFind.mockResolvedValueOnce([{ userId: 'admin-1' }]);

    await service.announce(AdminQueueKey.MagazineSubmissions);

    expect(createForRecipients).toHaveBeenCalledWith(
      ['admin-1'],
      NotificationType.AdminQueueItem,
      { source: 'admin', queue: 'magazine_submissions' },
    );
  });

  it('writes nothing when no staff match', async () => {
    await service.announce(AdminQueueKey.InviteRequests);

    expect(createForRecipients).not.toHaveBeenCalled();
  });

  it('swallows a notification failure so the submission still succeeds', async () => {
    usersFind.mockResolvedValueOnce([{ id: 'admin-1' }]);
    createForRecipients.mockRejectedValueOnce(new Error('bell is down'));

    await expect(
      service.announce(AdminQueueKey.InviteRequests),
    ).resolves.toBeUndefined();
  });

  it('passes no actor id', async () => {
    usersFind.mockResolvedValueOnce([{ id: 'admin-1' }]);

    await service.announce(AdminQueueKey.Dsar);

    // Four arguments would mean an actor, and an actor means a block or mute
    // between the submitting member and whoever is on shift could swallow
    // duty mail.
    expect(createForRecipients.mock.calls[0]).toHaveLength(3);
  });

  it('leaves out an excluded staff member', async () => {
    usersFind.mockResolvedValueOnce([{ id: 'moderator-1' }, { id: 'admin-1' }]);

    await service.announce(AdminQueueKey.BanRatifications, 'hold-1', [
      'moderator-1',
    ]);

    expect(createForRecipients).toHaveBeenCalledWith(
      ['admin-1'],
      NotificationType.AdminQueueItem,
      { source: 'admin', queue: 'ban_ratifications', itemId: 'hold-1' },
    );
  });

  it('writes nothing when excluding everybody who would otherwise be notified', async () => {
    usersFind.mockResolvedValueOnce([{ id: 'moderator-1' }]);

    await service.announce(AdminQueueKey.BanRatifications, 'hold-1', [
      'moderator-1',
    ]);

    expect(createForRecipients).not.toHaveBeenCalled();
  });
});
