import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';
import { ModAuditService } from '../moderation/mod-audit.service';
import { TakedownStudioReleaseDto } from './dto/takedown-studio-release.dto';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioModerationService } from './studio-moderation.service';

const STAFF_ID = 'f1000000-0000-4000-8000-000000000001';
const RELEASE_ID = 'f1000000-0000-4000-8000-000000000002';
const PUBLISHED_AT = new Date('2026-10-01T09:00:00.000Z');

describe('StudioModerationService', () => {
  let release: StudioRelease | null;
  let manager: { findOne: jest.Mock; save: jest.Mock };
  let modAudit: { writeAuditLog: jest.Mock };
  let catalog: { getReleaseForStaff: jest.Mock };
  let service: StudioModerationService;

  beforeEach(() => {
    release = {
      id: RELEASE_ID,
      status: StudioReleaseStatus.Published,
      publishedAt: PUBLISHED_AT,
      takenDownAt: null,
      takenDownById: null,
      takedownReason: null,
    } as StudioRelease;
    manager = {
      findOne: jest.fn(() => Promise.resolve(release)),
      save: jest.fn((row: object) => Promise.resolve(row)),
    };
    modAudit = { writeAuditLog: jest.fn().mockResolvedValue('audit-1') };
    catalog = {
      getReleaseForStaff: jest.fn().mockResolvedValue({ id: RELEASE_ID }),
    };
    const dataSource = {
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
    };
    service = new StudioModerationService(
      dataSource as unknown as DataSource,
      catalog as unknown as StudioCatalogService,
      modAudit as unknown as ModAuditService,
    );
  });

  it('locks the release, then records the reason, the staff member and the time', async () => {
    const before = Date.now();
    await service.takedown(STAFF_ID, RELEASE_ID, 'Uploaded without the rights');
    expect(manager.findOne).toHaveBeenCalledWith(StudioRelease, {
      where: { id: RELEASE_ID },
      lock: { mode: 'pessimistic_write' },
    });
    const saved = manager.save.mock.calls[0]![0] as StudioRelease;
    expect(saved.status).toBe('taken_down');
    expect(saved.takenDownById).toBe(STAFF_ID);
    expect(saved.takedownReason).toBe('Uploaded without the rights');
    expect(saved.takenDownAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(saved.publishedAt).toBe(PUBLISHED_AT);
    expect(catalog.getReleaseForStaff).toHaveBeenCalledWith(RELEASE_ID);
  });

  it('audits the takedown in the same transaction without naming the owner', async () => {
    await service.takedown(STAFF_ID, RELEASE_ID, 'Uploaded without the rights');
    expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
      null,
      STAFF_ID,
      'studio_release_taken_down',
      undefined,
      `${RELEASE_ID}: Uploaded without the rights`,
      undefined,
      manager,
      null,
    );
  });

  it('keeps the first takedown when asked twice', async () => {
    release = {
      ...release!,
      status: StudioReleaseStatus.TakenDown,
      takedownReason: 'First',
    };
    await service.takedown(STAFF_ID, RELEASE_ID, 'Second');
    expect(manager.save).not.toHaveBeenCalled();
    expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
  });

  it('restores a release that was live back to published and clears the takedown', async () => {
    release = {
      ...release!,
      status: StudioReleaseStatus.TakenDown,
      takedownReason: 'First',
      takenDownById: STAFF_ID,
      takenDownAt: new Date(),
    };
    await service.restore(STAFF_ID, RELEASE_ID);
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'published',
        takedownReason: null,
        takenDownById: null,
        takenDownAt: null,
      }),
    );
    expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
      null,
      STAFF_ID,
      'studio_release_restored',
      undefined,
      RELEASE_ID,
      undefined,
      manager,
      null,
    );
  });

  it('restores a draft that was taken down to draft, so restore never publishes', async () => {
    release = {
      ...release!,
      status: StudioReleaseStatus.TakenDown,
      publishedAt: null,
    };
    await service.restore(STAFF_ID, RELEASE_ID);
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft' }),
    );
  });

  it('restores nothing for a release that is not taken down', async () => {
    await service.restore(STAFF_ID, RELEASE_ID);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('answers 404 for a missing release', async () => {
    release = null;
    await expect(
      service.takedown(STAFF_ID, RELEASE_ID, 'Reason'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.restore(STAFF_ID, RELEASE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('needs a reason of 1 to 500 characters after trimming', async () => {
    const errorsFor = async (reason: unknown) =>
      (await validate(plainToInstance(TakedownStudioReleaseDto, { reason })))
        .length;
    expect(await errorsFor('Uploaded twice')).toBe(0);
    expect(await errorsFor('   ')).toBe(1);
    expect(await errorsFor('x'.repeat(501))).toBe(1);
  });
});
