import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ModAuditService } from '../moderation/mod-audit.service';
import { User } from '../users/entities/user.entity';
import { StudioAccessGrant } from './entities/studio-access-grant.entity';
import { StudioAccessService } from './studio-access.service';

const STAFF_ID = '7c000000-0000-4000-8000-000000000001';
const MEMBER_ID = '7c000000-0000-4000-8000-000000000002';
const GRANTED_AT = new Date('2026-10-08T10:00:00.000Z');

describe('StudioAccessService', () => {
  let insertExecute: jest.Mock;
  let manager: { createQueryBuilder: jest.Mock; delete: jest.Mock };
  let grants: {
    exists: jest.Mock;
    findOne: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let users: { exists: jest.Mock };
  let modAudit: { writeAuditLog: jest.Mock; nameForUserId: jest.Mock };
  let service: StudioAccessService;

  const storedGrant = (grantedById: string | null): StudioAccessGrant => ({
    id: 'grant-1',
    userId: MEMBER_ID,
    grantedById,
    createdAt: GRANTED_AT,
  });

  beforeEach(() => {
    insertExecute = jest.fn().mockResolvedValue({ raw: [{ id: 'grant-1' }] });
    const insertBuilder = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: insertExecute,
    };
    manager = {
      createQueryBuilder: jest.fn().mockReturnValue(insertBuilder),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    grants = {
      exists: jest.fn().mockResolvedValue(true),
      findOne: jest.fn().mockResolvedValue(storedGrant(STAFF_ID)),
      manager: {
        transaction: jest.fn((work: (inner: typeof manager) => unknown) =>
          Promise.resolve(work(manager)),
        ),
      },
    };
    users = { exists: jest.fn().mockResolvedValue(true) };
    modAudit = {
      writeAuditLog: jest.fn().mockResolvedValue('audit-1'),
      nameForUserId: jest.fn().mockResolvedValue('Rita Lobo'),
    };
    service = new StudioAccessService(
      grants as unknown as Repository<StudioAccessGrant>,
      users as unknown as Repository<User>,
      modAudit as unknown as ModAuditService,
    );
  });

  it('reads a grant row as access', async () => {
    expect(await service.hasAccess(MEMBER_ID)).toBe(true);
    expect(grants.exists).toHaveBeenCalledWith({
      where: { userId: MEMBER_ID },
    });
  });

  it('answers the grant with the granting staff member named', async () => {
    expect(await service.getGrant(MEMBER_ID)).toEqual({
      userId: MEMBER_ID,
      grantedAt: GRANTED_AT.toISOString(),
      grantedBy: { id: STAFF_ID, displayName: 'Rita Lobo' },
    });
  });

  it('answers null for a member with no grant, and a null granter once that account is gone', async () => {
    grants.findOne.mockResolvedValueOnce(null);
    expect(await service.getGrant(MEMBER_ID)).toBeNull();
    grants.findOne.mockResolvedValueOnce(storedGrant(null));
    expect((await service.getGrant(MEMBER_ID))?.grantedBy).toBeNull();
  });

  it('grants and audits in one transaction, naming the member', async () => {
    await service.grant(STAFF_ID, MEMBER_ID);
    expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
      null,
      STAFF_ID,
      'studio_access_granted',
      undefined,
      undefined,
      undefined,
      manager,
      MEMBER_ID,
    );
  });

  it('grants idempotently and audits only the first time', async () => {
    insertExecute.mockResolvedValue({ raw: [] });
    const response = await service.grant(STAFF_ID, MEMBER_ID);
    expect(response.userId).toBe(MEMBER_ID);
    expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
  });

  it('revokes idempotently and audits only a removed row', async () => {
    await service.revoke(STAFF_ID, MEMBER_ID);
    expect(manager.delete).toHaveBeenCalledWith(StudioAccessGrant, {
      userId: MEMBER_ID,
    });
    expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
      null,
      STAFF_ID,
      'studio_access_revoked',
      undefined,
      undefined,
      undefined,
      manager,
      MEMBER_ID,
    );
    modAudit.writeAuditLog.mockClear();
    manager.delete.mockResolvedValue({ affected: 0 });
    await service.revoke(STAFF_ID, MEMBER_ID);
    expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown member on every route', async () => {
    users.exists.mockResolvedValue(false);
    await expect(service.getGrant(MEMBER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.grant(STAFF_ID, MEMBER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.revoke(STAFF_ID, MEMBER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
