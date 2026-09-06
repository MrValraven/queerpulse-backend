import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsNull } from 'typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { CreateStorySubmissionDto } from './dto/create-story-submission.dto';
import {
  MagazineStorySubmission,
  SubmissionStatus,
} from './entities/magazine-story-submission.entity';
import { StorySubmissionsService } from './story-submissions.service';

describe('StorySubmissionsService', () => {
  let service: StorySubmissionsService;
  let submissions: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
  let adminQueueNotifications: { announce: jest.Mock };

  beforeEach(async () => {
    submissions = {
      create: jest.fn((input: Partial<MagazineStorySubmission>) => input),
      save: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn().mockResolvedValue(null),
      // The withdraw claim (`UPDATE ... WHERE decided_at IS NULL`). Defaults to
      // "claimed"; the race test makes it affect no rows.
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorySubmissionsService,
        {
          provide: getRepositoryToken(MagazineStorySubmission),
          useValue: submissions,
        },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
      ],
    }).compile();
    service = module.get(StorySubmissionsService);
  });

  describe('create', () => {
    it('stores deck, body and the cover key as their own fields', async () => {
      const dto: CreateStorySubmissionDto = {
        format: 'Personal essay',
        workingTitle: 'The city keeps changing around us',
        pitch: 'A short pitch about displacement.',
        deck: '  A standfirst.  ',
        body: '  The piece itself.  ',
        coverImageKey: 'story-covers/user-1/cover.webp',
      };
      const createdAt = new Date('2026-07-15T12:00:00.000Z');
      submissions.save.mockResolvedValue({
        id: 'sub-1',
        userId: 'user-1',
        format: dto.format,
        workingTitle: dto.workingTitle,
        pitch: dto.pitch,
        deck: 'A standfirst.',
        body: 'The piece itself.',
        coverImageKey: null,
        status: SubmissionStatus.Submitted,
        decision: null,
        decisionNote: null,
        decidedAt: null,
        createdAt,
      });

      const result = await service.create('user-1', dto);

      expect(submissions.create).toHaveBeenCalledWith({
        userId: 'user-1',
        format: dto.format,
        workingTitle: dto.workingTitle,
        pitch: dto.pitch,
        deck: 'A standfirst.',
        body: 'The piece itself.',
        coverImageKey: 'story-covers/user-1/cover.webp',
      });
      expect(result).toEqual({
        id: 'sub-1',
        format: 'Personal essay',
        workingTitle: 'The city keeps changing around us',
        pitch: 'A short pitch about displacement.',
        deck: 'A standfirst.',
        coverUrl: null,
        status: SubmissionStatus.Submitted,
        decision: null,
        decisionNote: null,
        decidedAt: null,
        withdrawnAt: null,
        createdAt: '2026-07-15T12:00:00.000Z',
      });
    });

    it('tells the magazine-submission queue with the saved row id', async () => {
      const dto: CreateStorySubmissionDto = {
        format: 'Personal essay',
        workingTitle: 'The city keeps changing around us',
        pitch: 'A short pitch about displacement.',
      };
      submissions.save.mockResolvedValue({
        id: 'sub-3',
        userId: 'user-1',
        format: dto.format,
        workingTitle: dto.workingTitle,
        pitch: dto.pitch,
        deck: null,
        body: null,
        coverImageKey: null,
        status: SubmissionStatus.Submitted,
        decision: null,
        decisionNote: null,
        decidedAt: null,
        createdAt: new Date('2026-07-15T12:00:00.000Z'),
      });

      await service.create('user-1', dto);

      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.MagazineSubmissions,
        'sub-3',
      );
    });

    it('tells nobody when the submission is never saved', async () => {
      submissions.save.mockRejectedValueOnce(new Error('write failed'));

      await expect(
        service.create('user-1', {
          format: 'Opinion',
          workingTitle: 'Why our archives cannot wait',
          pitch: 'An argument for funding queer memory work now.',
        }),
      ).rejects.toThrow('write failed');
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });

    it('normalises an absent deck/body/cover to null', async () => {
      const dto: CreateStorySubmissionDto = {
        format: 'Opinion',
        workingTitle: 'Why our archives cannot wait',
        pitch: 'An argument for funding queer memory work now.',
      };
      submissions.save.mockResolvedValue({
        id: 'sub-2',
        userId: 'user-1',
        format: dto.format,
        workingTitle: dto.workingTitle,
        pitch: dto.pitch,
        deck: null,
        body: null,
        coverImageKey: null,
        status: SubmissionStatus.Submitted,
        decision: null,
        decisionNote: null,
        decidedAt: null,
        createdAt: new Date('2026-07-15T12:00:00.000Z'),
      });

      await service.create('user-1', dto);

      expect(submissions.create).toHaveBeenCalledWith({
        userId: 'user-1',
        format: dto.format,
        workingTitle: dto.workingTitle,
        pitch: dto.pitch,
        deck: null,
        body: null,
        coverImageKey: null,
      });
    });
  });

  describe('listMine', () => {
    it("returns only the requesting user's submissions, newest first", async () => {
      const createdAt = new Date('2026-07-10T00:00:00.000Z');
      submissions.find.mockResolvedValue([
        {
          id: 'sub-1',
          userId: 'user-1',
          format: 'Interview',
          workingTitle: 'A conversation about staying',
          pitch: 'Pitch text.',
          deck: null,
          body: null,
          coverImageKey: null,
          status: SubmissionStatus.Rejected,
          decision: 'declined',
          decisionNote: 'Not for this issue, please send the next one.',
          decidedAt: new Date('2026-07-12T00:00:00.000Z'),
          createdAt,
        },
      ]);

      const result = await service.listMine('user-1');

      expect(submissions.find).toHaveBeenCalledWith({
        where: { userId: 'user-1', withdrawnAt: IsNull() },
        order: { createdAt: 'DESC' },
      });
      expect(result).toEqual([
        {
          id: 'sub-1',
          format: 'Interview',
          workingTitle: 'A conversation about staying',
          pitch: 'Pitch text.',
          deck: null,
          coverUrl: null,
          status: SubmissionStatus.Rejected,
          decision: 'declined',
          decisionNote: 'Not for this issue, please send the next one.',
          decidedAt: '2026-07-12T00:00:00.000Z',
          withdrawnAt: null,
          createdAt: '2026-07-10T00:00:00.000Z',
        },
      ]);
    });

    it('returns an empty array when the user has no submissions', async () => {
      submissions.find.mockResolvedValue([]);
      await expect(service.listMine('user-2')).resolves.toEqual([]);
    });
  });

  // PRD-129 — the member's own way out. Before this, "Submit for review" was
  // one-way and a member with second thoughts could only find a human to ask.
  describe('withdrawMine', () => {
    function makeOpenSubmission(
      overrides: Partial<MagazineStorySubmission> = {},
    ): MagazineStorySubmission {
      return {
        id: 'sub-1',
        userId: 'user-1',
        format: 'Personal essay',
        workingTitle: 'The city keeps changing around us',
        pitch: 'Pitch text.',
        deck: null,
        body: null,
        coverImageKey: null,
        status: SubmissionStatus.Submitted,
        decision: null,
        decisionNote: null,
        decidedBy: null,
        decidedAt: null,
        reopenedBy: null,
        reopenedAt: null,
        reopenCount: 0,
        withdrawnAt: null,
        commissionedPitchId: null,
        acceptedPieceId: null,
        createdAt: new Date('2026-07-10T00:00:00.000Z'),
        ...overrides,
      };
    }

    it('stamps `withdrawnAt` on an undecided submission and returns the row', async () => {
      submissions.findOne.mockResolvedValue(makeOpenSubmission());

      const result = await service.withdrawMine('user-1', 'sub-1');

      expect(submissions.update).toHaveBeenCalledWith(
        { id: 'sub-1', decidedAt: IsNull(), withdrawnAt: IsNull() },
        { withdrawnAt: expect.any(Date) as unknown },
      );
      expect(result.withdrawnAt).not.toBeNull();
    });

    // The row is loaded scoped to the caller, so someone else's id looks like
    // nothing rather than a 403 that would confirm it exists.
    it("404s on a submission that is not the caller's", async () => {
      submissions.findOne.mockResolvedValue(null);

      await expect(
        service.withdrawMine('user-2', 'sub-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(submissions.findOne).toHaveBeenCalledWith({
        where: { id: 'sub-1', userId: 'user-2' },
      });
      expect(submissions.update).not.toHaveBeenCalled();
    });

    it('409s once the desk has decided, so the member sees the decision', async () => {
      submissions.findOne.mockResolvedValue(
        makeOpenSubmission({
          status: SubmissionStatus.Accepted,
          decision: 'accepted',
          decidedAt: new Date('2026-07-12T00:00:00.000Z'),
        }),
      );

      await expect(
        service.withdrawMine('user-1', 'sub-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(submissions.update).not.toHaveBeenCalled();
    });

    // A decision landing between the read and the write must win.
    it('409s when the claim loses the race with a decision', async () => {
      submissions.findOne.mockResolvedValue(makeOpenSubmission());
      submissions.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.withdrawMine('user-1', 'sub-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    // A double tap asked for a state the row is already in. The frontend
    // refetches on a 409, which would make that read as a failure.
    it('is a no-op on an already withdrawn submission', async () => {
      submissions.findOne.mockResolvedValue(
        makeOpenSubmission({
          withdrawnAt: new Date('2026-07-11T00:00:00.000Z'),
        }),
      );

      const result = await service.withdrawMine('user-1', 'sub-1');

      expect(result.withdrawnAt).toBe('2026-07-11T00:00:00.000Z');
      expect(submissions.update).not.toHaveBeenCalled();
    });
  });
});
