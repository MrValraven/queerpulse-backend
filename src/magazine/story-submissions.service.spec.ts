import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CreateStorySubmissionDto } from './dto/create-story-submission.dto';
import {
  MagazineStorySubmission,
  SubmissionStatus,
} from './entities/magazine-story-submission.entity';
import { StorySubmissionsService } from './story-submissions.service';

describe('StorySubmissionsService', () => {
  let service: StorySubmissionsService;
  let submissions: { create: jest.Mock; save: jest.Mock; find: jest.Mock };

  beforeEach(async () => {
    submissions = {
      create: jest.fn((input: Partial<MagazineStorySubmission>) => input),
      save: jest.fn(),
      find: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorySubmissionsService,
        {
          provide: getRepositoryToken(MagazineStorySubmission),
          useValue: submissions,
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
        createdAt: '2026-07-15T12:00:00.000Z',
      });
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
        where: { userId: 'user-1' },
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
          createdAt: '2026-07-10T00:00:00.000Z',
        },
      ]);
    });

    it('returns an empty array when the user has no submissions', async () => {
      submissions.find.mockResolvedValue([]);
      await expect(service.listMine('user-2')).resolves.toEqual([]);
    });
  });
});
