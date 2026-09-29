import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { LegalRequestAmendment } from './entities/legal-request-amendment.entity';
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
  let amendments: { find: jest.Mock };
  let profiles: { findOne: jest.Mock };
  // The transaction's entity manager: `update` writes the record and its
  // amendment row through it, together.
  let transactionManager: { save: jest.Mock; insert: jest.Mock };
  let dataSource: { transaction: jest.Mock };

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
    amendments = { find: jest.fn() };
    profiles = { findOne: jest.fn() };
    transactionManager = {
      save: jest.fn((_target: unknown, record: Partial<LegalRequest>) => ({
        ...record,
      })),
      insert: jest.fn(),
    };
    dataSource = {
      transaction: jest.fn(
        (work: (manager: typeof transactionManager) => Promise<unknown>) =>
          work(transactionManager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LegalRequestsService,
        { provide: getRepositoryToken(LegalRequest), useValue: legalRequests },
        {
          provide: getRepositoryToken(LegalRequestAmendment),
          useValue: amendments,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
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
    beforeEach(() => {
      profiles.findOne.mockResolvedValue({
        userId: 'admin-2',
        firstName: 'Grace',
        lastName: 'Hopper',
      });
    });

    it('writes only the keys present and leaves the rest on file', async () => {
      legalRequests.findOne.mockResolvedValue(buildRecord());

      const result = await service.update('request-1', 'admin-2', {
        outcome: LegalRequestOutcome.Refused,
      });

      expect(result.outcome).toBe(LegalRequestOutcome.Refused);
      expect(result.requestingBody).toBe('District Court of Lisbon');
    });

    it('records the acting admin and only the fields that moved, in the same transaction as the record', async () => {
      const record = buildRecord({ dataDisclosed: ['account_identifiers'] });
      legalRequests.findOne.mockResolvedValue(record);

      await service.update('request-1', 'admin-2', {
        outcome: LegalRequestOutcome.Refused,
        // Sent again unchanged: on file already, so it is no amendment.
        jurisdiction: 'Portugal',
        dataDisclosed: ['account_identifiers'],
        internalNote: 'Refused on scope',
      });

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(transactionManager.save).toHaveBeenCalledWith(
        LegalRequest,
        record,
      );
      expect(transactionManager.insert).toHaveBeenCalledWith(
        LegalRequestAmendment,
        {
          legalRequestId: 'request-1',
          actorUserId: 'admin-2',
          actorName: 'Grace Hopper',
          changes: {
            outcome: {
              from: LegalRequestOutcome.Pending,
              to: LegalRequestOutcome.Refused,
            },
            internalNote: { from: null, to: 'Refused on scope' },
          },
        },
      );
    });

    it('compares disclosed categories as a set, so a reordered list is no amendment', async () => {
      legalRequests.findOne.mockResolvedValue(
        buildRecord({
          outcome: LegalRequestOutcome.CompliedInFull,
          dataDisclosed: ['account_identifiers', 'private_messages'],
        }),
      );

      await service.update('request-1', 'admin-2', {
        dataDisclosed: ['private_messages', 'account_identifiers'],
      });

      expect(transactionManager.insert).not.toHaveBeenCalled();
    });

    it('writes no amendment row for a PATCH that changes nothing', async () => {
      legalRequests.findOne.mockResolvedValue(buildRecord());

      const result = await service.update('request-1', 'admin-2', {
        jurisdiction: 'Portugal',
        outcome: LegalRequestOutcome.Pending,
      });

      expect(result.jurisdiction).toBe('Portugal');
      expect(transactionManager.insert).not.toHaveBeenCalled();
      // No history row means no snapshot of the actor's name is needed.
      expect(profiles.findOne).not.toHaveBeenCalled();
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
        service.update('request-1', 'admin-2', { jurisdiction: 'Spain' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(transactionManager.insert).not.toHaveBeenCalled();
    });

    it('judges the invariants on the merged record rather than on the keys sent', async () => {
      legalRequests.findOne.mockResolvedValue(
        buildRecord({ accountsAffected: 2 }),
      );

      await expect(
        service.update('request-1', 'admin-2', {
          accountsNotified: 5,
          memberNotifiedOn: '2026-08-05',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(transactionManager.insert).not.toHaveBeenCalled();
    });
  });

  describe('listAmendments', () => {
    it('returns the history newest first with no actor id on the wire', async () => {
      legalRequests.findOne.mockResolvedValue(buildRecord());
      amendments.find.mockResolvedValue([
        {
          id: 'amendment-1',
          legalRequestId: 'request-1',
          actorUserId: 'admin-2',
          actorName: 'Grace Hopper',
          changes: { outcome: { from: 'pending', to: 'refused' } },
          createdAt: new Date('2026-08-05T09:00:00.000Z'),
        },
      ]);

      const result = await service.listAmendments('request-1');

      expect(amendments.find).toHaveBeenCalledWith({
        where: { legalRequestId: 'request-1' },
        order: { createdAt: 'DESC', id: 'DESC' },
      });
      expect(result).toEqual([
        {
          id: 'amendment-1',
          actorName: 'Grace Hopper',
          changes: { outcome: { from: 'pending', to: 'refused' } },
          createdAt: '2026-08-05T09:00:00.000Z',
        },
      ]);
      expect(JSON.stringify(result)).not.toContain('admin-2');
    });

    it('is a 404 for an unknown record', async () => {
      legalRequests.findOne.mockResolvedValue(null);

      await expect(service.listAmendments('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(amendments.find).not.toHaveBeenCalled();
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
