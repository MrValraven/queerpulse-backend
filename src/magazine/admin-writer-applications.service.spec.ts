import { ConflictException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AdminMembersService } from '../admin-members/admin-members.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { AdminWriterApplicationsService } from './admin-writer-applications.service';
import {
  MagazineWriterApplication,
  WriterApplicationStatus,
} from './entities/magazine-writer-application.entity';

function makeApplication(
  overrides: Partial<MagazineWriterApplication> = {},
): MagazineWriterApplication {
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

/**
 * A minimal `Repository` double: only the members `triage`/`list` actually
 * call. Cast once here, via `unknown`, so call sites never repeat their own
 * `as any` — the service still sees a precisely-typed `Repository`.
 */
function makeApplicationsRepo(
  findOneResult: MagazineWriterApplication | null,
  claimAffected = 1,
): Repository<MagazineWriterApplication> & { _execute: jest.Mock } {
  const execute = jest.fn(async () => ({ affected: claimAffected }));
  const where = jest.fn(() => ({ execute }));
  const set = jest.fn(() => ({ where }));
  const update = jest.fn(() => ({ set }));
  return {
    findOne: jest.fn(async () => findOneResult),
    findAndCount: jest.fn(async () => [[], 0]),
    createQueryBuilder: jest.fn(() => ({ update })),
    _execute: execute,
  } as unknown as Repository<MagazineWriterApplication> & {
    _execute: jest.Mock;
  };
}

function makeProfilesRepo(): Repository<Profile> {
  return {
    find: jest.fn(async () => []),
  } as unknown as Repository<Profile>;
}

function makeAdminMembers(
  grantStaffRole: jest.Mock = jest.fn(),
): AdminMembersService {
  return { grantStaffRole } as unknown as AdminMembersService;
}

function makeNotifications(
  create: jest.Mock = jest.fn(),
): NotificationsService {
  return { create } as unknown as NotificationsService;
}

describe('AdminWriterApplicationsService', () => {
  describe('triage', () => {
    it('throws NotFoundException when the application does not exist', async () => {
      const service = new AdminWriterApplicationsService(
        makeApplicationsRepo(null),
        makeProfilesRepo(),
        makeAdminMembers(),
        makeNotifications(),
      );
      await expect(
        service.triage('admin-1', 'missing', { status: 'approved' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ConflictException when already resolved', async () => {
      const service = new AdminWriterApplicationsService(
        makeApplicationsRepo(
          makeApplication({ status: WriterApplicationStatus.Approved }),
        ),
        makeProfilesRepo(),
        makeAdminMembers(),
        makeNotifications(),
      );
      await expect(
        service.triage('admin-1', 'app-1', { status: 'declined' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('grants magazine_writer and notifies on approve', async () => {
      const grantStaffRole = jest.fn(async () => ({}));
      const create = jest.fn(async () => null);
      const applicationsRepo = makeApplicationsRepo(makeApplication());
      const service = new AdminWriterApplicationsService(
        applicationsRepo,
        makeProfilesRepo(),
        makeAdminMembers(grantStaffRole),
        makeNotifications(create),
      );
      const dto = await service.triage('admin-1', 'app-1', {
        status: 'approved',
      });
      expect(grantStaffRole).toHaveBeenCalledWith(
        'admin-1',
        'user-1',
        'magazine_writer',
      );
      expect(create).toHaveBeenCalledWith(
        'user-1',
        'writer_application_approved',
        { reviewNote: null },
      );
      expect(dto.status).toBe('approved');
    });

    it('sets the review note and notifies on decline, without granting a role', async () => {
      const grantStaffRole = jest.fn();
      const create = jest.fn(async () => null);
      const applicationsRepo = makeApplicationsRepo(makeApplication());
      const service = new AdminWriterApplicationsService(
        applicationsRepo,
        makeProfilesRepo(),
        makeAdminMembers(grantStaffRole),
        makeNotifications(create),
      );
      const dto = await service.triage('admin-1', 'app-1', {
        status: 'declined',
        reviewNote: 'Not a fit right now.',
      });
      expect(grantStaffRole).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledWith(
        'user-1',
        'writer_application_declined',
        { reviewNote: 'Not a fit right now.' },
      );
      expect(dto.status).toBe('declined');
      expect(dto.reviewNote).toBe('Not a fit right now.');
    });

    it('throws ConflictException when the row was already claimed concurrently', async () => {
      const applicationsRepo = makeApplicationsRepo(makeApplication(), 0);
      const service = new AdminWriterApplicationsService(
        applicationsRepo,
        makeProfilesRepo(),
        makeAdminMembers(jest.fn(async () => ({}))),
        makeNotifications(),
      );
      await expect(
        service.triage('admin-1', 'app-1', { status: 'approved' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
