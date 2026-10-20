import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminListingDraftsController } from './admin-listing-drafts.controller';
import { AdminListingDraftsService } from './admin-listing-drafts.service';

describe('AdminListingDraftsController', () => {
  const modAudit = { writeAuditLog: jest.fn().mockResolvedValue('audit-1') };

  beforeEach(() => {
    modAudit.writeAuditLog.mockClear();
  });

  it('is Admin only, with no moderator tier', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      AdminListingDraftsController,
    ) as UserRole[];
    expect(roles).toEqual([UserRole.Admin]);
  });

  it('runs the active-member and roles guards on the whole class', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AdminListingDraftsController,
    ) as unknown[];
    expect(guards).toEqual([ActiveMemberGuard, RolesGuard]);
  });

  it('GET / delegates to the service with the page query', async () => {
    const page = { items: [], total: 0, page: 2, pageSize: 20 };
    const list = jest.fn().mockResolvedValue(page);
    const controller = new AdminListingDraftsController(
      { list } as unknown as AdminListingDraftsService,
      modAudit as never,
    );
    await expect(controller.list({ page: 2 })).resolves.toBe(page);
    expect(list).toHaveBeenCalledWith({ page: 2 });
    expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
  });

  it('writes a listing_drafts audit row after the read', async () => {
    const detail = { id: 'draft-1', payload: {} };
    const getOne = jest.fn().mockResolvedValue(detail);
    const controller = new AdminListingDraftsController(
      { getOne } as never,
      modAudit as never,
    );
    await expect(
      controller.getOne({ userId: 'admin-1' } as CurrentUserData, 'draft-1'),
    ).resolves.toBe(detail);
    expect(getOne).toHaveBeenCalledWith('draft-1');
    expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
      null,
      'admin-1',
      'creator_draft_viewed',
      undefined,
      '{"v":1,"kind":"listing","draftId":"draft-1","surface":"listing_drafts"}',
    );
  });

  it('writes nothing when the draft is gone', async () => {
    const controller = new AdminListingDraftsController(
      { getOne: jest.fn().mockRejectedValue(new NotFoundException()) } as never,
      modAudit as never,
    );
    await expect(
      controller.getOne({ userId: 'admin-1' } as CurrentUserData, 'draft-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
  });
});
