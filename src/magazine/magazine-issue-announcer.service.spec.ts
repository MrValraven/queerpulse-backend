import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, IsNull } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { MagazineIssue } from './entities/magazine-issue.entity';
import { MagazinePiece } from './entities/magazine-piece.entity';
import { MagazineIssueAnnouncerService } from './magazine-issue-announcer.service';

type UsersRepositoryMock = { find: jest.Mock };
type IssuesRepositoryMock = { update: jest.Mock };
type PiecesRepositoryMock = { count: jest.Mock };
type NotificationsMock = { createForRecipients: jest.Mock };

// 10:00 in Lisbon (UTC+1) on the issue date, an hour after it went live.
const NOW = new Date('2026-09-29T09:00:00.000Z');

function makeIssue(overrides: Partial<MagazineIssue> = {}): MagazineIssue {
  return {
    id: 'issue-1',
    number: '42',
    title: 'The long table',
    publishedOn: '2026-09-29',
    digestSendOnPublish: true,
    digestSentAt: null,
    lastShip: {
      shippedAt: '2026-09-29T08:30:00.000Z',
      publishAt: '2026-09-29T08:30:00.000Z',
      publishedPieceIds: ['piece-1', 'piece-2'],
      held: [],
    },
    ...overrides,
  } as MagazineIssue;
}

describe('MagazineIssueAnnouncerService', () => {
  let service: MagazineIssueAnnouncerService;
  let users: UsersRepositoryMock;
  let issues: IssuesRepositoryMock;
  let pieces: PiecesRepositoryMock;
  let notifications: NotificationsMock;

  beforeEach(async () => {
    users = {
      find: jest
        .fn()
        .mockResolvedValue([{ id: 'member-1' }, { id: 'member-2' }]),
    };
    issues = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    pieces = { count: jest.fn().mockResolvedValue(2) };
    notifications = {
      createForRecipients: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MagazineIssueAnnouncerService,
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(MagazineIssue), useValue: issues },
        { provide: getRepositoryToken(MagazinePiece), useValue: pieces },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get(MagazineIssueAnnouncerService);
  });

  function expectNoWrite(): void {
    expect(issues.update).not.toHaveBeenCalled();
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  }

  describe('announceIssueIfDue: conditions that keep the bell quiet', () => {
    it('returns false when the desk left the toggle off', async () => {
      const issue = makeIssue({ digestSendOnPublish: false });

      await expect(service.announceIssueIfDue(issue, NOW)).resolves.toBe(false);
      expectNoWrite();
    });

    it('returns false when the issue was already announced', async () => {
      const issue = makeIssue({
        digestSentAt: new Date('2026-09-28T09:00:00.000Z'),
      });

      await expect(service.announceIssueIfDue(issue, NOW)).resolves.toBe(false);
      expectNoWrite();
    });

    it('returns false for an issue with no date', async () => {
      const issue = makeIssue({ publishedOn: null });

      await expect(service.announceIssueIfDue(issue, NOW)).resolves.toBe(false);
      expectNoWrite();
    });

    it('returns false before 09:00 Lisbon on the issue date', async () => {
      const issue = makeIssue({
        lastShip: {
          shippedAt: '2026-09-29T06:00:00.000Z',
          publishAt: '2026-09-29T06:00:00.000Z',
          publishedPieceIds: ['piece-1'],
          held: [],
        },
      });

      // 07:59 UTC is 08:59 in Lisbon (UTC+1).
      await expect(
        service.announceIssueIfDue(issue, new Date('2026-09-29T07:59:00.000Z')),
      ).resolves.toBe(false);
      expectNoWrite();
    });

    it('returns false for a future-dated issue', async () => {
      const issue = makeIssue({ publishedOn: '2026-10-05' });

      await expect(service.announceIssueIfDue(issue, NOW)).resolves.toBe(false);
      expectNoWrite();
    });

    it('returns false when the issue was never shipped', async () => {
      const issue = makeIssue({ lastShip: null });

      await expect(service.announceIssueIfDue(issue, NOW)).resolves.toBe(false);
      expectNoWrite();
    });

    it('returns false while the last ship is still scheduled', async () => {
      const issue = makeIssue({
        lastShip: {
          shippedAt: '2026-09-25T10:00:00.000Z',
          publishAt: '2026-09-29T09:00:01.000Z',
          publishedPieceIds: ['piece-1'],
          held: [],
        },
      });

      await expect(service.announceIssueIfDue(issue, NOW)).resolves.toBe(false);
      expectNoWrite();
    });

    it('returns false when the last ship published no pieces', async () => {
      const issue = makeIssue({
        lastShip: {
          shippedAt: '2026-09-29T08:30:00.000Z',
          publishAt: '2026-09-29T08:30:00.000Z',
          publishedPieceIds: [],
          held: [],
        },
      });

      await expect(service.announceIssueIfDue(issue, NOW)).resolves.toBe(false);
      expect(pieces.count).not.toHaveBeenCalled();
      expectNoWrite();
    });

    it('returns false when none of the shipped pieces is still published', async () => {
      pieces.count.mockResolvedValue(0);

      await expect(service.announceIssueIfDue(makeIssue(), NOW)).resolves.toBe(
        false,
      );
      expect(pieces.count).toHaveBeenCalledWith({
        where: { id: In(['piece-1', 'piece-2']), stage: 'published' },
      });
      expectNoWrite();
    });
  });

  it('returns false without a fan-out when another ship won the claim', async () => {
    issues.update.mockResolvedValue({ affected: 0 });
    const issue = makeIssue();

    await expect(service.announceIssueIfDue(issue, NOW)).resolves.toBe(false);

    expect(issues.update).toHaveBeenCalledTimes(1);
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
    expect(issue.digestSentAt).toBeNull();
  });

  it('claims the issue, rings every active member once, and stamps it', async () => {
    const issue = makeIssue();

    await expect(service.announceIssueIfDue(issue, NOW)).resolves.toBe(true);

    expect(issues.update).toHaveBeenCalledWith(
      { id: 'issue-1', digestSentAt: IsNull() },
      { digestSentAt: NOW },
    );
    expect(users.find).toHaveBeenCalledWith({
      where: { status: UserStatus.Active, isSystem: false },
      select: { id: true },
    });
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['member-1', 'member-2'],
      NotificationType.MagazineIssuePublished,
      { source: 'magazine', issueNumber: '42', issueTitle: 'The long table' },
    );
    expect(issue.digestSentAt).toBe(NOW);
  });

  it('chunks a large membership into batches of 500', async () => {
    users.find.mockResolvedValue(
      Array.from({ length: 1201 }, (_value, index) => ({
        id: `member-${index}`,
      })),
    );

    await expect(service.announceIssueIfDue(makeIssue(), NOW)).resolves.toBe(
      true,
    );

    const batchSizes = notifications.createForRecipients.mock.calls.map(
      (call: unknown[]) => (call[0] as string[]).length,
    );
    expect(batchSizes).toEqual([500, 500, 201]);
  });

  it('releases the claim and returns false when the fan-out fails', async () => {
    notifications.createForRecipients.mockRejectedValue(
      new Error('database down'),
    );
    const issue = makeIssue();

    await expect(service.announceIssueIfDue(issue, NOW)).resolves.toBe(false);

    expect(issues.update).toHaveBeenNthCalledWith(
      2,
      { id: 'issue-1' },
      { digestSentAt: null },
    );
    expect(issue.digestSentAt).toBeNull();
  });

  it('never throws, even when releasing the claim fails too', async () => {
    notifications.createForRecipients.mockRejectedValue(
      new Error('database down'),
    );
    issues.update
      .mockResolvedValueOnce({ affected: 1 })
      .mockRejectedValueOnce(new Error('still down'));

    await expect(service.announceIssueIfDue(makeIssue(), NOW)).resolves.toBe(
      false,
    );
  });
});
