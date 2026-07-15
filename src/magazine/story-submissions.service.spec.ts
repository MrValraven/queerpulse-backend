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
    it('saves a submission scoped to the submitting user and maps the response', async () => {
      const dto: CreateStorySubmissionDto = {
        format: 'Personal essay',
        workingTitle: 'The city keeps changing around us',
        pitch: 'A short pitch about displacement.',
      };
      const createdAt = new Date('2026-07-15T12:00:00.000Z');
      submissions.save.mockResolvedValue({
        id: 'sub-1',
        userId: 'user-1',
        format: dto.format,
        workingTitle: dto.workingTitle,
        pitch: dto.pitch,
        status: SubmissionStatus.Submitted,
        createdAt,
      });

      const result = await service.create('user-1', dto);

      expect(submissions.create).toHaveBeenCalledWith({
        userId: 'user-1',
        format: dto.format,
        workingTitle: dto.workingTitle,
        pitch: dto.pitch,
      });
      expect(result).toEqual({
        id: 'sub-1',
        format: 'Personal essay',
        workingTitle: 'The city keeps changing around us',
        pitch: 'A short pitch about displacement.',
        status: SubmissionStatus.Submitted,
        createdAt: '2026-07-15T12:00:00.000Z',
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
          status: SubmissionStatus.InReview,
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
          status: SubmissionStatus.InReview,
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
