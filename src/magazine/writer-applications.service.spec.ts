import { BadRequestException, ConflictException } from '@nestjs/common';
import { WriterApplicationsService } from './writer-applications.service';
import {
  MagazineWriterApplication,
  WriterApplicationStatus,
} from './entities/magazine-writer-application.entity';

function makeApplicationsRepo(overrides: Record<string, jest.Mock> = {}) {
  return {
    create: jest.fn((input) => input),
    save: jest.fn(async (input) => ({
      id: 'app-1',
      status: WriterApplicationStatus.Pending,
      reviewedBy: null,
      reviewNote: null,
      createdAt: new Date('2026-08-18T00:00:00.000Z'),
      reviewedAt: null,
      ...input,
    })),
    findOne: jest.fn(async () => null),
    ...overrides,
  };
}

function makeStaffRolesRepo(alreadyWriter = false) {
  return { exists: jest.fn(async () => alreadyWriter) };
}

describe('WriterApplicationsService', () => {
  describe('create', () => {
    it('rejects when neither sampleText nor sampleLink is given', async () => {
      const service = new WriterApplicationsService(
        makeApplicationsRepo() as any,
        makeStaffRolesRepo() as any,
      );
      await expect(
        service.create('user-1', { pitchNote: 'Hi' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when the user already holds magazine_writer', async () => {
      const service = new WriterApplicationsService(
        makeApplicationsRepo() as any,
        makeStaffRolesRepo(true) as any,
      );
      await expect(
        service.create('user-1', { sampleText: 'A paragraph.' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a duplicate pending application (unique violation)', async () => {
      const applications = makeApplicationsRepo({
        save: jest.fn(async () => {
          throw { code: '23505' };
        }),
      });
      const service = new WriterApplicationsService(
        applications as any,
        makeStaffRolesRepo() as any,
      );
      await expect(
        service.create('user-1', { sampleText: 'A paragraph.' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('saves and returns the application on success', async () => {
      const applications = makeApplicationsRepo();
      const service = new WriterApplicationsService(
        applications as any,
        makeStaffRolesRepo() as any,
      );
      const dto = await service.create('user-1', {
        pitchNote: '  Why I want to write  ',
        sampleText: '  A paragraph.  ',
      });
      expect(applications.save).toHaveBeenCalledWith(
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
        makeApplicationsRepo() as any,
        makeStaffRolesRepo() as any,
      );
      expect(await service.getMine('user-1')).toBeNull();
    });

    it('returns the latest application, mapped', async () => {
      const applications = makeApplicationsRepo({
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
        applications as any,
        makeStaffRolesRepo() as any,
      );
      const dto = await service.getMine('user-1');
      expect(dto?.id).toBe('app-1');
      expect(applications.findOne).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        order: { createdAt: 'DESC' },
      });
    });
  });
});
