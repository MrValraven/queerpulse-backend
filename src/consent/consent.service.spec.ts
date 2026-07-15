import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConsentDto } from './dto/consent.dto';
import { ConsentService } from './consent.service';
import {
  ConsentAction,
  ConsentRecord,
  ConsentSource,
} from './entities/consent-record.entity';

describe('ConsentService', () => {
  let service: ConsentService;
  let repo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };

  const now = new Date('2026-07-15T12:00:00.000Z');

  const dtoWith = (
    analytics: boolean,
    monitoring: boolean,
    overrides: Partial<ConsentDto> = {},
  ): ConsentDto => ({
    categories: { necessary: true, analytics, monitoring },
    policyVersion: '3.3',
    source: ConsentSource.Banner,
    ...overrides,
  });

  const priorRecord = (
    analytics: boolean,
    monitoring: boolean,
  ): ConsentRecord => ({
    id: 'prior',
    userId: 'u1',
    anonId: null,
    analytics,
    monitoring,
    policyVersion: '3.2',
    source: ConsentSource.Banner,
    action: ConsentAction.Granted,
    createdAt: now,
  });

  beforeEach(async () => {
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((v: Partial<ConsentRecord>) => v),
      save: jest.fn((v: Partial<ConsentRecord>) =>
        Promise.resolve({ id: 'new-id', createdAt: now, ...v }),
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConsentService,
        { provide: getRepositoryToken(ConsentRecord), useValue: repo },
      ],
    }).compile();
    service = module.get(ConsentService);
  });

  describe('record (append-only)', () => {
    it('inserts a NEW row on every call (no upsert / findOne-by-purpose)', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.record(
        'u1',
        dtoWith(true, false, {
          anonId: 'anon-9',
          source: ConsentSource.PreferenceCenter,
        }),
      );

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          anonId: 'anon-9',
          analytics: true,
          monitoring: false,
          policyVersion: '3.3',
          source: ConsentSource.PreferenceCenter,
        }),
      );
      // `necessary` is synthesised, not persisted, but always returned true.
      expect(result).toEqual({
        categories: { necessary: true, analytics: true, monitoring: false },
        policyVersion: '3.3',
        action: ConsentAction.Granted,
        createdAt: now.toISOString(),
      });
    });

    it('defaults anonId to null when omitted', async () => {
      await service.record('u1', dtoWith(false, false));
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ anonId: null }),
      );
    });

    describe('action derivation', () => {
      it("no prior record → 'granted'", async () => {
        repo.findOne.mockResolvedValue(null);
        const r = await service.record('u1', dtoWith(true, true));
        expect(r.action).toBe(ConsentAction.Granted);
      });

      it("analytics flips true→false → 'withdrawn'", async () => {
        repo.findOne.mockResolvedValue(priorRecord(true, true));
        const r = await service.record('u1', dtoWith(false, true));
        expect(r.action).toBe(ConsentAction.Withdrawn);
      });

      it("monitoring flips true→false → 'withdrawn'", async () => {
        repo.findOne.mockResolvedValue(priorRecord(true, true));
        const r = await service.record('u1', dtoWith(true, false));
        expect(r.action).toBe(ConsentAction.Withdrawn);
      });

      it("broadening (false→true) with nothing withdrawn → 'updated'", async () => {
        repo.findOne.mockResolvedValue(priorRecord(false, false));
        const r = await service.record('u1', dtoWith(true, true));
        expect(r.action).toBe(ConsentAction.Updated);
      });

      it("re-submitting the identical decision → 'updated'", async () => {
        repo.findOne.mockResolvedValue(priorRecord(true, false));
        const r = await service.record('u1', dtoWith(true, false));
        expect(r.action).toBe(ConsentAction.Updated);
      });
    });
  });

  describe('myConsent', () => {
    it('returns the LATEST record categories + policyVersion', async () => {
      repo.findOne.mockResolvedValue({
        ...priorRecord(true, false),
        policyVersion: '3.3',
      });

      const result = await service.myConsent('u1', '3.3');

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        order: { createdAt: 'DESC' },
      });
      expect(result).toEqual({
        categories: { necessary: true, analytics: true, monitoring: false },
        policyVersion: '3.3',
      });
    });

    it('falls back to necessary-only default with the current policy version when none exists', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.myConsent('u1', '3.3')).resolves.toEqual({
        categories: { necessary: true, analytics: false, monitoring: false },
        policyVersion: '3.3',
      });
    });
  });
});
