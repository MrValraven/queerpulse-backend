import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminWriterApplicationsService } from './admin-writer-applications.service';
import { WriterApplicationStatus } from './entities/magazine-writer-application.entity';

function makeApplication(
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    id: 'app-1',
    userId: 'user-1',
    pitchNote: null,
    sampleText: 'A paragraph.',
    sampleLink: null,
    status: WriterApplicationStatus.Pending,
    reviewedBy: null,
    reviewNote: null,
    createdAt: new Date('2026-08-18T00:00:00.000Z'),
    reviewedAt: null,
    ...overrides,
  };
}

function makeApplicationsRepo(findOneResult: unknown, claimAffected = 1) {
  const execute = jest.fn(async () => ({ affected: claimAffected }));
  const where = jest.fn(() => ({ execute }));
  const set = jest.fn(() => ({ where }));
  const update = jest.fn(() => ({ set }));
  return {
    findOne: jest.fn(async () => findOneResult),
    findAndCount: jest.fn(async () => [[], 0]),
    createQueryBuilder: jest.fn(() => ({ update })),
    _execute: execute,
  };
}

function makeProfilesRepo() {
  return { find: jest.fn(async () => []) };
}

describe('AdminWriterApplicationsService', () => {
  describe('triage', () => {
    it('throws NotFoundException when the application does not exist', async () => {
      const adminMembers = { grantStaffRole: jest.fn() };
      const notifications = { create: jest.fn() };
      const service = new AdminWriterApplicationsService(
        makeApplicationsRepo(null) as any,
        makeProfilesRepo() as any,
        adminMembers as any,
        notifications as any,
      );
      await expect(
        service.triage('admin-1', 'missing', { status: 'approved' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ConflictException when already resolved', async () => {
      const adminMembers = { grantStaffRole: jest.fn() };
      const notifications = { create: jest.fn() };
      const service = new AdminWriterApplicationsService(
        makeApplicationsRepo(
          makeApplication({ status: WriterApplicationStatus.Approved }),
        ) as any,
        makeProfilesRepo() as any,
        adminMembers as any,
        notifications as any,
      );
      await expect(
        service.triage('admin-1', 'app-1', { status: 'declined' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('grants magazine_writer and notifies on approve', async () => {
      const adminMembers = { grantStaffRole: jest.fn(async () => ({})) };
      const notifications = { create: jest.fn(async () => null) };
      const applicationsRepo = makeApplicationsRepo(makeApplication());
      const service = new AdminWriterApplicationsService(
        applicationsRepo as any,
        makeProfilesRepo() as any,
        adminMembers as any,
        notifications as any,
      );
      const dto = await service.triage('admin-1', 'app-1', {
        status: 'approved',
      });
      expect(adminMembers.grantStaffRole).toHaveBeenCalledWith(
        'admin-1',
        'user-1',
        'magazine_writer',
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'user-1',
        'writer_application_approved',
        { reviewNote: null },
      );
      expect(dto.status).toBe('approved');
    });

    it('sets the review note and notifies on decline, without granting a role', async () => {
      const adminMembers = { grantStaffRole: jest.fn() };
      const notifications = { create: jest.fn(async () => null) };
      const applicationsRepo = makeApplicationsRepo(makeApplication());
      const service = new AdminWriterApplicationsService(
        applicationsRepo as any,
        makeProfilesRepo() as any,
        adminMembers as any,
        notifications as any,
      );
      const dto = await service.triage('admin-1', 'app-1', {
        status: 'declined',
        reviewNote: 'Not a fit right now.',
      });
      expect(adminMembers.grantStaffRole).not.toHaveBeenCalled();
      expect(notifications.create).toHaveBeenCalledWith(
        'user-1',
        'writer_application_declined',
        { reviewNote: 'Not a fit right now.' },
      );
      expect(dto.status).toBe('declined');
      expect(dto.reviewNote).toBe('Not a fit right now.');
    });

    it('throws ConflictException when the row was already claimed concurrently', async () => {
      const adminMembers = { grantStaffRole: jest.fn(async () => ({})) };
      const notifications = { create: jest.fn() };
      const applicationsRepo = makeApplicationsRepo(makeApplication(), 0);
      const service = new AdminWriterApplicationsService(
        applicationsRepo as any,
        makeProfilesRepo() as any,
        adminMembers as any,
        notifications as any,
      );
      await expect(
        service.triage('admin-1', 'app-1', { status: 'approved' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
