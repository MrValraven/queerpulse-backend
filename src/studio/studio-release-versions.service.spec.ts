import { HttpException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  StudioRelease,
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import { StudioReleaseVersion } from './entities/studio-release-version.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioOwnershipService } from './studio-ownership.service';
import {
  INSERT_VERSION_SQL,
  StudioReleaseVersionsService,
} from './studio-release-versions.service';

const USER_ID = 'cf000000-0000-4000-8000-000000000001';
const RELEASE_ID = 'cf000000-0000-4000-8000-000000000002';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

describe('StudioReleaseVersionsService', () => {
  let release: Partial<StudioRelease>;
  let latestVersion: Partial<StudioReleaseVersion> | null;
  let manager: { findOne: jest.Mock; query: jest.Mock };
  let ownership: { lockReleaseForWrite: jest.Mock };
  let catalog: { getRelease: jest.Mock };
  let service: StudioReleaseVersionsService;

  beforeEach(() => {
    release = {
      id: RELEASE_ID,
      status: StudioReleaseStatus.Published,
      publishedAt: new Date('2026-10-01T09:00:00.000Z'),
      tracksChangedAt: new Date('2026-10-05T09:00:00.000Z'),
    };
    latestVersion = null;
    manager = {
      findOne: jest.fn(() => Promise.resolve(latestVersion)),
      query: jest.fn().mockResolvedValue(undefined),
    };
    ownership = {
      lockReleaseForWrite: jest.fn(() =>
        Promise.resolve({ release, persona: { id: 'persona-1', kind: 'dj' } }),
      ),
    };
    catalog = { getRelease: jest.fn().mockResolvedValue({ id: RELEASE_ID }) };
    const dataSource = {
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
    };
    service = new StudioReleaseVersionsService(
      dataSource as unknown as DataSource,
      ownership as unknown as StudioOwnershipService,
      catalog as unknown as StudioCatalogService,
    );
  });

  it('writes version 2 for the first note after a track change, under the release lock', async () => {
    await service.addVersion(USER_ID, RELEASE_ID, { note: 'Added a track' });
    expect(manager.findOne).toHaveBeenCalledWith(StudioReleaseVersion, {
      where: { releaseId: RELEASE_ID },
      order: { version: 'DESC' },
    });
    expect(manager.query).toHaveBeenCalledWith(INSERT_VERSION_SQL, [
      RELEASE_ID,
      2,
      'Added a track',
    ]);
    expect(INSERT_VERSION_SQL).toContain('clock_timestamp()');
    expect(
      ownership.lockReleaseForWrite.mock.invocationCallOrder[0],
    ).toBeLessThan(manager.findOne.mock.invocationCallOrder[0]!);
    expect(catalog.getRelease).toHaveBeenCalledWith(USER_ID, RELEASE_ID);
  });

  it('counts on from the newest note', async () => {
    latestVersion = {
      version: 3,
      createdAt: new Date('2026-10-04T09:00:00.000Z'),
    };
    await service.addVersion(USER_ID, RELEASE_ID, { note: 'Remastered' });
    expect(manager.query.mock.calls[0]?.[1]).toEqual([
      RELEASE_ID,
      4,
      'Remastered',
    ]);
  });

  it('answers no changes when the newest note already covers the tracks', async () => {
    latestVersion = {
      version: 2,
      createdAt: new Date('2026-10-06T09:00:00.000Z'),
    };
    expect(
      await codeOf(service.addVersion(USER_ID, RELEASE_ID, { note: 'Again' })),
    ).toBe('studio_release_no_changes');
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('answers no changes when the tracks never changed', async () => {
    release = { ...release, tracksChangedAt: null };
    expect(
      await codeOf(service.addVersion(USER_ID, RELEASE_ID, { note: 'Hi' })),
    ).toBe('studio_release_no_changes');
  });

  it('answers no changes for a draft or a scheduled release, and not draft for a taken-down one', async () => {
    release = { ...release, status: StudioReleaseStatus.Draft };
    expect(
      await codeOf(service.addVersion(USER_ID, RELEASE_ID, { note: 'Hi' })),
    ).toBe('studio_release_no_changes');
    release = { ...release, status: StudioReleaseStatus.Scheduled };
    expect(
      await codeOf(service.addVersion(USER_ID, RELEASE_ID, { note: 'Hi' })),
    ).toBe('studio_release_no_changes');
    release = { ...release, status: StudioReleaseStatus.TakenDown };
    expect(
      await codeOf(service.addVersion(USER_ID, RELEASE_ID, { note: 'Hi' })),
    ).toBe('studio_release_not_draft');
  });

  // Studio artist kinds: a show has no version notes.
  it('answers no changes for a podcast show, whatever its stamp says', async () => {
    release = { ...release, type: StudioReleaseType.Podcast };
    expect(
      await codeOf(
        service.addVersion(USER_ID, RELEASE_ID, { note: 'New episode' }),
      ),
    ).toBe('studio_release_no_changes');
    expect(manager.findOne).not.toHaveBeenCalled();
    expect(manager.query).not.toHaveBeenCalled();
  });
});
