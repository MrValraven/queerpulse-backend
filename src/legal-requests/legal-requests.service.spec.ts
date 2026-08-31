import { BadRequestException, ConflictException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { Profile } from '../users/entities/profile.entity';
import { LegalRequest } from './entities/legal-request.entity';
import { toAdminLegalRequestDTO } from './legal-request-response';
import {
  LegalRequestOutcome,
  LegalRequestType,
} from './legal-request-vocabulary';
import { LegalRequestsService } from './legal-requests.service';

function buildRecord(overrides: Partial<LegalRequest> = {}): LegalRequest {
  return {
    id: 'request-1',
    requestingBody: 'District Court of Lisbon',
    jurisdiction: 'Portugal',
    requestType: LegalRequestType.CourtOrder,
    receivedOn: '2026-08-04',
    accountsAffected: 0,
    outcome: LegalRequestOutcome.Pending,
    dataDisclosed: [],
    memberNotifiedOn: null,
    accountsNotified: 0,
    notificationWithheldReason: null,
    isUnderGagOrder: false,
    internalNote: null,
    recordedByUserId: 'admin-1',
    recordedByName: 'Ada Lovelace',
    voidedAt: null,
    voidedByUserId: null,
    voidReason: null,
    createdAt: new Date('2026-08-04T09:00:00.000Z'),
    updatedAt: new Date('2026-08-04T09:00:00.000Z'),
    ...overrides,
  };
}

describe('LegalRequestsService', () => {
  let service: LegalRequestsService;
  let legalRequests: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let profiles: { findOne: jest.Mock };

  beforeEach(async () => {
    legalRequests = {
      createQueryBuilder: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((partial: Partial<LegalRequest>) => ({ ...partial })),
      // Mirrors what TypeORM hands back: the caller's own object, with the
      // generated columns filled in only where the insert produced them.
      save: jest.fn((record: Partial<LegalRequest>) => ({
        ...record,
        id: record.id ?? 'request-1',
        createdAt: record.createdAt ?? new Date('2026-08-04T09:00:00.000Z'),
        updatedAt: record.updatedAt ?? new Date('2026-08-04T09:00:00.000Z'),
      })),
    };
    profiles = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LegalRequestsService,
        { provide: getRepositoryToken(LegalRequest), useValue: legalRequests },
        { provide: getRepositoryToken(Profile), useValue: profiles },
      ],
    }).compile();
    service = module.get(LegalRequestsService);
  });

  describe('create', () => {
    beforeEach(() => {
      profiles.findOne.mockResolvedValue({
        userId: 'admin-1',
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
    });

    it('strips markup at the write boundary and snapshots the recording admin', async () => {
      const result = await service.create('admin-1', {
        requestingBody: '<b>District Court</b> of Lisbon',
        jurisdiction: 'Portugal',
        requestType: LegalRequestType.CourtOrder,
        receivedOn: '2026-08-04',
      });

      expect(result.requestingBody).toBe('District Court of Lisbon');
      expect(result.recordedByName).toBe('Ada Lovelace');
    });

    it('defaults an unanswered demand to pending so it can be recorded the hour it lands', async () => {
      const result = await service.create('admin-1', {
        requestingBody: 'Polícia Judiciária',
        jurisdiction: 'Portugal',
        requestType: LegalRequestType.PoliceRequest,
        receivedOn: '2026-08-04',
      });

      expect(result.outcome).toBe(LegalRequestOutcome.Pending);
    });

    it('refuses more accounts notified than affected', async () => {
      await expect(
        service.create('admin-1', {
          requestingBody: 'Polícia Judiciária',
          jurisdiction: 'Portugal',
          requestType: LegalRequestType.PoliceRequest,
          receivedOn: '2026-08-04',
          accountsAffected: 1,
          accountsNotified: 2,
          memberNotifiedOn: '2026-08-05',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a notified count with no day behind it', async () => {
      await expect(
        service.create('admin-1', {
          requestingBody: 'Polícia Judiciária',
          jurisdiction: 'Portugal',
          requestType: LegalRequestType.PoliceRequest,
          receivedOn: '2026-08-04',
          accountsAffected: 3,
          accountsNotified: 3,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a disclosure where nobody was told and no reason is on file', async () => {
      await expect(
        service.create('admin-1', {
          requestingBody: 'Polícia Judiciária',
          jurisdiction: 'Portugal',
          requestType: LegalRequestType.PoliceRequest,
          receivedOn: '2026-08-04',
          accountsAffected: 3,
          outcome: LegalRequestOutcome.CompliedInFull,
          dataDisclosed: ['account_identifiers'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts that same disclosure once the reason is recorded', async () => {
      const result = await service.create('admin-1', {
        requestingBody: 'Polícia Judiciária',
        jurisdiction: 'Portugal',
        requestType: LegalRequestType.PoliceRequest,
        receivedOn: '2026-08-04',
        accountsAffected: 3,
        outcome: LegalRequestOutcome.CompliedInFull,
        dataDisclosed: ['account_identifiers'],
        notificationWithheldReason: 'Under a gag order until 2027-01-01',
      });

      expect(result.accountsNotified).toBe(0);
      expect(result.notificationWithheldReason).toBe(
        'Under a gag order until 2027-01-01',
      );
    });

    it('records a gag-ordered demand in full', async () => {
      const result = await service.create('admin-1', {
        requestingBody: 'Polícia Judiciária',
        jurisdiction: 'Portugal',
        requestType: LegalRequestType.EmergencyDisclosureRequest,
        receivedOn: '2026-08-04',
        isUnderGagOrder: true,
      });

      expect(result.isUnderGagOrder).toBe(true);
    });
  });

  describe('update', () => {
    it('writes only the keys present and leaves the rest on file', async () => {
      legalRequests.findOne.mockResolvedValue(buildRecord());

      const result = await service.update('request-1', {
        outcome: LegalRequestOutcome.Refused,
      });

      expect(result.outcome).toBe(LegalRequestOutcome.Refused);
      expect(result.requestingBody).toBe('District Court of Lisbon');
    });

    it('freezes a voided record rather than letting it be rewritten', async () => {
      legalRequests.findOne.mockResolvedValue(
        buildRecord({
          voidedAt: new Date('2026-08-10T09:00:00.000Z'),
          voidedByUserId: 'admin-1',
          voidReason: 'Duplicate of request-2',
        }),
      );

      await expect(
        service.update('request-1', { jurisdiction: 'Spain' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(legalRequests.save).not.toHaveBeenCalled();
    });

    it('judges the invariants on the merged record rather than on the keys sent', async () => {
      legalRequests.findOne.mockResolvedValue(
        buildRecord({ accountsAffected: 2 }),
      );

      await expect(
        service.update('request-1', {
          accountsNotified: 5,
          memberNotifiedOn: '2026-08-05',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('voidRecord', () => {
    it('stamps the actor, the moment and the reason, and keeps the row', async () => {
      const record = buildRecord();
      legalRequests.findOne.mockResolvedValue(record);

      const result = await service.voidRecord('request-1', 'admin-2', {
        reason: 'Entered against the wrong row',
      });

      expect(result.isVoided).toBe(true);
      expect(result.voidReason).toBe('Entered against the wrong row');
      expect(record.voidedByUserId).toBe('admin-2');
      // Voiding never removes anything: the same row is saved back.
      expect(legalRequests.save).toHaveBeenCalledWith(record);
    });

    it('refuses to re-void, so the register keeps the moment it was struck', async () => {
      legalRequests.findOne.mockResolvedValue(
        buildRecord({
          voidedAt: new Date('2026-08-10T09:00:00.000Z'),
          voidedByUserId: 'admin-1',
          voidReason: 'Duplicate of request-2',
        }),
      );

      await expect(
        service.voidRecord('request-1', 'admin-2', { reason: 'Again' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  it('offers no way to delete a record', () => {
    const methodNames = Object.getOwnPropertyNames(
      LegalRequestsService.prototype,
    );
    expect(methodNames).not.toContain('remove');
    expect(methodNames).not.toContain('delete');
    expect(methodNames).not.toContain('destroy');
    expect(methodNames).toContain('voidRecord');
  });

  describe('toAdminLegalRequestDTO', () => {
    it('never puts an actor id on the wire', () => {
      const dto = toAdminLegalRequestDTO(
        buildRecord({
          voidedAt: new Date('2026-08-10T09:00:00.000Z'),
          voidedByUserId: 'admin-9',
          voidReason: 'Duplicate of request-2',
        }),
      );

      expect(dto).not.toHaveProperty('recordedByUserId');
      expect(dto).not.toHaveProperty('voidedByUserId');
      expect(JSON.stringify(dto)).not.toContain('admin-1');
      expect(JSON.stringify(dto)).not.toContain('admin-9');
    });
  });
});
