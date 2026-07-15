import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  ReadingGroupProposal,
  ReadingGroupProposalFormat,
} from './entities/reading-group-proposal.entity';
import { CreateReadingGroupProposalDto } from './dto/create-reading-group-proposal.dto';
import { ReadingGroupProposalsService } from './reading-group-proposals.service';

const now = new Date('2026-07-15T12:00:00.000Z');

describe('ReadingGroupProposalsService', () => {
  let service: ReadingGroupProposalsService;
  let repo: { create: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    repo = {
      create: jest.fn((v: Partial<ReadingGroupProposal>) => v),
      save: jest.fn((v: Partial<ReadingGroupProposal>) =>
        Promise.resolve({
          id: 'rgp-1',
          createdAt: now,
          ...v,
        } as ReadingGroupProposal),
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReadingGroupProposalsService,
        { provide: getRepositoryToken(ReadingGroupProposal), useValue: repo },
      ],
    }).compile();
    service = module.get(ReadingGroupProposalsService);
  });

  describe('create', () => {
    const dto: CreateReadingGroupProposalDto = {
      book: "Giovanni's Room — James Baldwin",
      why: '  Made me feel less alone.  ',
      format: ReadingGroupProposalFormat.InPerson,
      maxPeople: 6,
    };

    it('scopes the proposal to the calling member and trims the "why" field', async () => {
      const result = await service.create('u1', dto);

      expect(repo.create).toHaveBeenCalledWith({
        memberId: 'u1',
        book: dto.book,
        why: 'Made me feel less alone.',
        format: dto.format,
        maxPeople: dto.maxPeople,
      });
      expect(result).toEqual({
        id: 'rgp-1',
        book: dto.book,
        why: 'Made me feel less alone.',
        format: dto.format,
        maxPeople: dto.maxPeople,
        createdAt: now.toISOString(),
      });
    });

    it('stores a null "why" when the optional field was left blank', async () => {
      const result = await service.create('u1', { ...dto, why: '   ' });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ why: null }),
      );
      expect(result.why).toBeNull();
    });

    it('stores a null "why" when it was omitted entirely', async () => {
      const withoutWhy: CreateReadingGroupProposalDto = {
        book: dto.book,
        format: dto.format,
        maxPeople: dto.maxPeople,
      };
      const result = await service.create('u1', withoutWhy);

      expect(result.why).toBeNull();
    });
  });
});
