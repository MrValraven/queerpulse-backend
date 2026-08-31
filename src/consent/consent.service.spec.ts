import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConsentDto } from './dto/consent.dto';
import { ConsentService } from './consent.service';
import {
  ConsentAction,
  ConsentRecord,
  ConsentSource,
} from './entities/consent-record.entity';
import { CURRENT_PRIVACY_POLICY_VERSION } from './policy-versions';

describe('ConsentService', () => {
  let service: ConsentService;
  let repo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };

  const now = new Date('2026-07-15T12:00:00.000Z');

  // Every DTO here carries a policy version that is NOT the one in effect. That
  // is deliberate: since ENG-23 the body's `policyVersion` is accepted by the
  // DTO and then ignored by the service, so a spec that sent the current value
  // could not tell a server stamp from an echo of the request.
  const STALE_CLIENT_POLICY_VERSION = '3.3';

  // The revision on a member's existing row when they are BEHIND the one in
  // effect, which is what makes a re-affirmation a fresh decision.
  const OLDER_STORED_POLICY_VERSION = '3.2';

  const dtoWith = (
    analytics: boolean,
    monitoring: boolean,
    overrides: Partial<ConsentDto> = {},
  ): ConsentDto => ({
    categories: { necessary: true, analytics, monitoring },
    policyVersion: STALE_CLIENT_POLICY_VERSION,
    source: ConsentSource.Banner,
    ...overrides,
  });

  const priorRecord = (
    analytics: boolean,
    monitoring: boolean,
    policyVersion: string = OLDER_STORED_POLICY_VERSION,
  ): ConsentRecord => ({
    id: 'prior',
    userId: 'u1',
    anonId: null,
    analytics,
    monitoring,
    policyVersion,
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
          policyVersion: CURRENT_PRIVACY_POLICY_VERSION,
          source: ConsentSource.PreferenceCenter,
        }),
      );
      // `necessary` is synthesised, not persisted, but always returned true.
      expect(result).toEqual({
        categories: { necessary: true, analytics: true, monitoring: false },
        policyVersion: CURRENT_PRIVACY_POLICY_VERSION,
        action: ConsentAction.Granted,
        createdAt: now.toISOString(),
      });
    });

    // ENG-23. The consent table is the GDPR evidence trail, so the revision on
    // the row has to be the one the platform published, never a string the
    // caller sent. The DTO still carries the field (removing it would 400 every
    // client that still sends it, under `forbidNonWhitelisted`), so the guarantee
    // this case pins is that carrying it changes nothing about what is stored.
    it('stamps the SERVER policy version and ignores the one on the body', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.record(
        'u1',
        dtoWith(true, true, { policyVersion: 'not-a-real-revision' }),
      );

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          policyVersion: CURRENT_PRIVACY_POLICY_VERSION,
        }),
      );
      expect(result.policyVersion).toBe(CURRENT_PRIVACY_POLICY_VERSION);
    });

    // The anonymous path: a banner decision made before sign-in carries the
    // browser's own correlation id, which is the client's to supply and is NOT
    // touched by the version change above.
    it('still persists a client-supplied anonId alongside the server version', async () => {
      repo.findOne.mockResolvedValue(null);

      await service.record('u1', dtoWith(false, false, { anonId: 'anon-42' }));

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          anonId: 'anon-42',
          policyVersion: CURRENT_PRIVACY_POLICY_VERSION,
        }),
      );
    });

    it('defaults anonId to null when omitted', async () => {
      await service.record('u1', dtoWith(false, false));
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ anonId: null }),
      );
    });

    // "Nothing changed" is now measured against the row that WOULD be written,
    // so the prior record has to already sit at the revision in effect. The body
    // still carries a stale version, which must not make this look like a change
    // and append a duplicate.
    it('echoes the stored record instead of appending when nothing changed', async () => {
      repo.findOne.mockResolvedValue(
        priorRecord(true, false, CURRENT_PRIVACY_POLICY_VERSION),
      );

      const result = await service.record('u1', dtoWith(true, false));

      expect(repo.save).not.toHaveBeenCalled();
      expect(result).toEqual({
        categories: { necessary: true, analytics: true, monitoring: false },
        policyVersion: CURRENT_PRIVACY_POLICY_VERSION,
        action: ConsentAction.Granted,
        createdAt: now.toISOString(),
      });
    });

    // The other half of the same guarantee: a member whose newest row predates
    // the revision in effect gets a fresh row even though their categories are
    // identical, because agreeing again against a new policy is a new decision.
    // The body's version is stale in BOTH cases, so only the server constant can
    // tell these two apart.
    it('appends a new row when the stored record predates the revision in effect', async () => {
      repo.findOne.mockResolvedValue(
        priorRecord(true, false, OLDER_STORED_POLICY_VERSION),
      );

      await service.record('u1', dtoWith(true, false));

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          analytics: true,
          monitoring: false,
          policyVersion: CURRENT_PRIVACY_POLICY_VERSION,
        }),
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

      it("re-affirming the same categories against a NEW policy version → 'updated'", async () => {
        repo.findOne.mockResolvedValue(priorRecord(true, false));
        const r = await service.record('u1', dtoWith(true, false));
        expect(r.action).toBe(ConsentAction.Updated);
      });
    });
  });

  describe('myConsent', () => {
    it('returns the LATEST record categories + policyVersion', async () => {
      repo.findOne.mockResolvedValue(
        priorRecord(true, false, CURRENT_PRIVACY_POLICY_VERSION),
      );

      const result = await service.myConsent(
        'u1',
        CURRENT_PRIVACY_POLICY_VERSION,
      );

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        order: { createdAt: 'DESC' },
      });
      expect(result).toEqual({
        categories: { necessary: true, analytics: true, monitoring: false },
        policyVersion: CURRENT_PRIVACY_POLICY_VERSION,
      });
    });

    // The fallback is the published revision the controller hands in, which is
    // the same constant `record` stamps. Nothing a client sends reaches it.
    it('falls back to necessary-only default with the published policy version when none exists', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.myConsent('u1', CURRENT_PRIVACY_POLICY_VERSION),
      ).resolves.toEqual({
        categories: { necessary: true, analytics: false, monitoring: false },
        policyVersion: CURRENT_PRIVACY_POLICY_VERSION,
      });
    });
  });
});
