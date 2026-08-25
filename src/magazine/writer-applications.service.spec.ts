import { BadRequestException, ConflictException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { WriterApplicationsService } from './writer-applications.service';
import {
  MagazineWriterApplication,
  WriterApplicationStatus,
} from './entities/magazine-writer-application.entity';

type ApplicationsRepoOverrides = Partial<{
  create: jest.Mock;
  save: jest.Mock;
  findOne: jest.Mock;
}>;

/**
 * A minimal `Repository` double: only the members `create`/`getMine`
 * actually call. `repository` is cast once here, via `unknown`, so call
 * sites never repeat their own `as any` — the service still sees a
 * precisely-typed `Repository`. The individual mocks are also returned
 * un-cast so assertions can reference them directly, instead of reading a
 * method off the `Repository`-typed object (which `unbound-method` flags).
 */
function makeApplicationsRepo(overrides: ApplicationsRepoOverrides = {}) {
  const create =
    overrides.create ??
    jest.fn((input: Partial<MagazineWriterApplication>) => input);
  const save =
    overrides.save ??
    jest.fn(async (input: Partial<MagazineWriterApplication>) => ({
      id: 'app-1',
      status: WriterApplicationStatus.Pending,
      reviewedBy: null,
      reviewNote: null,
      createdAt: new Date('2026-08-18T00:00:00.000Z'),
      reviewedAt: null,
      ...input,
    }));
  const findOne = overrides.findOne ?? jest.fn(async () => null);
  const repository = {
    create,
    save,
    findOne,
  } as unknown as Repository<MagazineWriterApplication>;
  return { repository, create, save, findOne };
}

function makeStaffRolesRepo(alreadyWriter = false): Repository<UserStaffRole> {
  return {
    exists: jest.fn(async () => alreadyWriter),
  } as unknown as Repository<UserStaffRole>;
}

describe('WriterApplicationsService', () => {
  describe('create', () => {
    it('rejects when neither sampleText nor sampleLink is given', async () => {
      const service = new WriterApplicationsService(
        makeApplicationsRepo().repository,
        makeStaffRolesRepo(),
      );
      await expect(
        service.create('user-1', { pitchNote: 'Hi' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when the user already holds magazine_writer', async () => {
      const service = new WriterApplicationsService(
        makeApplicationsRepo().repository,
        makeStaffRolesRepo(true),
      );
      await expect(
        service.create('user-1', { sampleText: 'A paragraph.' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a duplicate pending application (unique violation)', async () => {
      const { repository } = makeApplicationsRepo({
        save: jest.fn(async () => {
          // Mirrors the driver's unique-violation error, which the service maps
          // to 409. Thrown as an Error so the mock cannot be mistaken for a
          // deliberate non-Error throw.
          throw Object.assign(new Error('duplicate key value'), {
            code: '23505',
          });
        }),
      });
      const service = new WriterApplicationsService(
        repository,
        makeStaffRolesRepo(),
      );
      await expect(
        service.create('user-1', { sampleText: 'A paragraph.' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('saves and returns the application on success', async () => {
      const { repository, save } = makeApplicationsRepo();
      const service = new WriterApplicationsService(
        repository,
        makeStaffRolesRepo(),
      );
      const dto = await service.create('user-1', {
        pitchNote: '  Why I want to write  ',
        sampleText: '  A paragraph.  ',
      });
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          pitchNote: 'Why I want to write',
          sampleText: 'A paragraph.',
          sampleLink: null,
        }),
      );
      expect(dto.status).toBe('pending');
    });
  });

  describe('getMine', () => {
    it('returns null when no application exists', async () => {
      const service = new WriterApplicationsService(
        makeApplicationsRepo().repository,
        makeStaffRolesRepo(),
      );
      expect(await service.getMine('user-1')).toBeNull();
    });

    it('returns the latest application, mapped', async () => {
      const { repository, findOne } = makeApplicationsRepo({
        findOne: jest.fn(async () => ({
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
        })),
      });
      const service = new WriterApplicationsService(
        repository,
        makeStaffRolesRepo(),
      );
      const dto = await service.getMine('user-1');
      expect(dto?.id).toBe('app-1');
      expect(findOne).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        order: { createdAt: 'DESC' },
      });
    });
  });
});
