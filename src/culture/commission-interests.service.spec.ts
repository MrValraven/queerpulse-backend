import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CommissionInterestsService } from './commission-interests.service';
import { CreateCommissionInterestDto } from './dto/create-commission-interest.dto';
import {
  CommissionCategory,
  CommissionInterest,
} from './entities/commission-interest.entity';

const now = new Date('2026-07-15T12:00:00.000Z');

describe('CommissionInterestsService', () => {
  let service: CommissionInterestsService;
  let repo: { create: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    repo = {
      create: jest.fn((v: Partial<CommissionInterest>) => v),
      save: jest.fn((v: Partial<CommissionInterest>) =>
        Promise.resolve({
          id: 'ci-1',
          createdAt: now,
          ...v,
        } as CommissionInterest),
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommissionInterestsService,
        { provide: getRepositoryToken(CommissionInterest), useValue: repo },
      ],
    }).compile();
    service = module.get(CommissionInterestsService);
  });

  describe('create', () => {
    const dto: CreateCommissionInterestDto = {
      commissionTitle: 'Portraits of Queer Elders in Mouraria',
      commissionCategory: CommissionCategory.Photo,
      recipientName: 'Inês Tavares',
      message: '  I would love to help with the captions.  ',
    };

    it('scopes the interest to the calling member and trims the message', async () => {
      const result = await service.create('u1', dto);

      expect(repo.create).toHaveBeenCalledWith({
        memberId: 'u1',
        commissionTitle: dto.commissionTitle,
        commissionCategory: dto.commissionCategory,
        recipientName: dto.recipientName,
        message: 'I would love to help with the captions.',
      });
      expect(result).toEqual({
        id: 'ci-1',
        commissionTitle: dto.commissionTitle,
        commissionCategory: dto.commissionCategory,
        recipientName: dto.recipientName,
        message: 'I would love to help with the captions.',
        createdAt: now.toISOString(),
      });
    });

    it('stores a null message when the optional textarea was left empty', async () => {
      const result = await service.create('u1', { ...dto, message: '   ' });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ message: null }),
      );
      expect(result.message).toBeNull();
    });

    it('stores a null message when it was omitted entirely', async () => {
      const { message: _message, ...withoutMessage } = dto;
      const result = await service.create('u1', withoutMessage);

      expect(result.message).toBeNull();
    });
  });
});
