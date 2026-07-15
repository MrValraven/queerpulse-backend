import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ChangemakerNomination } from './entities/changemaker-nomination.entity';
import { CreateChangemakerNominationDto } from './dto/create-changemaker-nomination.dto';
import { ChangemakerNominationsService } from './changemaker-nominations.service';

const now = new Date('2026-07-15T12:00:00.000Z');

describe('ChangemakerNominationsService', () => {
  let service: ChangemakerNominationsService;
  let repo: { create: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    repo = {
      create: jest.fn((v: Partial<ChangemakerNomination>) => v),
      save: jest.fn((v: Partial<ChangemakerNomination>) =>
        Promise.resolve({
          id: 'cn-1',
          createdAt: now,
          ...v,
        } as ChangemakerNomination),
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChangemakerNominationsService,
        { provide: getRepositoryToken(ChangemakerNomination), useValue: repo },
      ],
    }).compile();
    service = module.get(ChangemakerNominationsService);
  });

  describe('create', () => {
    const dto: CreateChangemakerNominationDto = {
      nomineeName: '  Inês Tavares  ',
    };

    it('scopes the nomination to the calling nominator and trims the name', async () => {
      const result = await service.create('u1', dto);

      expect(repo.create).toHaveBeenCalledWith({
        nominatorId: 'u1',
        nomineeName: 'Inês Tavares',
      });
      expect(result).toEqual({
        id: 'cn-1',
        nomineeName: 'Inês Tavares',
        createdAt: now.toISOString(),
      });
    });
  });
});
