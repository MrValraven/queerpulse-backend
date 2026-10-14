import { HttpException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  StudioRelease,
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioOwnershipService } from './studio-ownership.service';
import { StudioSchedulingService } from './studio-scheduling.service';

const USER_ID = 'c9000000-0000-4000-8000-000000000001';
const RELEASE_ID = 'c9000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-10-13T12:00:00.000Z');
const IN_A_WEEK = '2026-10-20T18:00:00.000Z';
const AUDIO_KEY = 'studio-audio/a/b.mp3';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

const releaseWith = (overrides: Partial<StudioRelease> = {}): StudioRelease =>
  ({
    id: RELEASE_ID,
    subprofileId: 'persona-1',
    title: 'Lisbon at four',
    type: StudioReleaseType.Mix,
    coverKey: 'persona/a/b.jpg',
    rightsConfirmedAt: new Date('2026-10-01T09:00:00.000Z'),
    releasedOn: null,
    status: StudioReleaseStatus.Draft,
    publishAt: null,
    publishedAt: null,
    ...overrides,
  }) as StudioRelease;

describe('StudioSchedulingService', () => {
  let release: StudioRelease;
  let tracks: Partial<StudioTrack>[];
  let manager: { find: jest.Mock; save: jest.Mock };
  let ownership: { lockReleaseForWrite: jest.Mock };
  let catalog: { getRelease: jest.Mock };
  let service: StudioSchedulingService;

  beforeEach(() => {
    release = releaseWith();
    // The default release is a mix, so its track credits a source.
    tracks = [
      {
        id: 'track-1',
        audioKey: AUDIO_KEY,
        durationSeconds: 200,
        sources: [{ title: 'Rumour Has It', artist: 'Adele' }],
      },
    ];
    manager = {
      find: jest.fn(() => Promise.resolve(tracks)),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
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
    service = new StudioSchedulingService(
      dataSource as unknown as DataSource,
      ownership as unknown as StudioOwnershipService,
      catalog as unknown as StudioCatalogService,
    );
  });

  describe('schedule', () => {
    it('schedules a draft, fills the release date in Lisbon and answers the owner view', async () => {
      await service.schedule(
        USER_ID,
        RELEASE_ID,
        { publishAt: '2026-10-20T23:30:00.000Z' },
        NOW,
      );
      const saved = manager.save.mock.calls[0]![0] as StudioRelease;
      expect(saved.status).toBe('scheduled');
      expect(saved.publishAt?.toISOString()).toBe('2026-10-20T23:30:00.000Z');
      expect(saved.releasedOn).toBe('2026-10-21');
      expect(catalog.getRelease).toHaveBeenCalledWith(USER_ID, RELEASE_ID);
    });

    it('keeps a release date the artist typed', async () => {
      release = releaseWith({ releasedOn: '2026-11-01' });
      await service.schedule(
        USER_ID,
        RELEASE_ID,
        { publishAt: IN_A_WEEK },
        NOW,
      );
      expect((manager.save.mock.calls[0]![0] as StudioRelease).releasedOn).toBe(
        '2026-11-01',
      );
    });

    it('reschedules and moves a release date that scheduling filled', async () => {
      release = releaseWith({
        status: StudioReleaseStatus.Scheduled,
        publishAt: new Date('2026-10-20T18:00:00.000Z'),
        releasedOn: '2026-10-20',
      });
      await service.schedule(
        USER_ID,
        RELEASE_ID,
        { publishAt: '2026-10-27T18:00:00.000Z' },
        NOW,
      );
      const saved = manager.save.mock.calls[0]![0] as StudioRelease;
      expect(saved.publishAt?.toISOString()).toBe('2026-10-27T18:00:00.000Z');
      expect(saved.releasedOn).toBe('2026-10-27');
    });

    it.each([[StudioReleaseStatus.Published], [StudioReleaseStatus.TakenDown]])(
      'refuses a %s release',
      async (status) => {
        release = releaseWith({ status });
        expect(
          await codeOf(
            service.schedule(
              USER_ID,
              RELEASE_ID,
              { publishAt: IN_A_WEEK },
              NOW,
            ),
          ),
        ).toBe('studio_release_not_schedulable');
        expect(manager.save).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['ten minutes ahead', '2026-10-13T12:10:00.000Z'],
      ['in the past', '2026-10-13T11:00:00.000Z'],
      ['two years ahead', '2028-10-13T12:00:00.000Z'],
    ])('refuses a time %s', async (_label, publishAt) => {
      expect(
        await codeOf(service.schedule(USER_ID, RELEASE_ID, { publishAt }, NOW)),
      ).toBe('studio_schedule_out_of_range');
      expect(manager.find).not.toHaveBeenCalled();
    });

    it('runs the publish rule at scheduling time', async () => {
      release = releaseWith({ coverKey: null });
      expect(
        await codeOf(
          service.schedule(USER_ID, RELEASE_ID, { publishAt: IN_A_WEEK }, NOW),
        ),
      ).toBe('studio_publish_missing_cover');
      release = releaseWith();
      tracks = [
        { id: 'track-1', audioKey: null, durationSeconds: null, sources: [] },
      ];
      expect(
        await codeOf(
          service.schedule(USER_ID, RELEASE_ID, { publishAt: IN_A_WEEK }, NOW),
        ),
      ).toBe('studio_publish_tracks_pending');
      expect(manager.find).toHaveBeenCalledWith(StudioTrack, {
        where: { releaseId: RELEASE_ID },
        select: {
          id: true,
          audioKey: true,
          durationSeconds: true,
          sources: true,
        },
      });
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('unschedule', () => {
    it('returns a scheduled release to draft and clears its time and the date scheduling filled', async () => {
      release = releaseWith({
        status: StudioReleaseStatus.Scheduled,
        publishAt: new Date('2026-10-20T18:00:00.000Z'),
        releasedOn: '2026-10-20',
      });
      await service.unschedule(USER_ID, RELEASE_ID);
      const saved = manager.save.mock.calls[0]![0] as StudioRelease;
      expect(saved.status).toBe('draft');
      expect(saved.publishAt).toBeNull();
      expect(saved.releasedOn).toBeNull();
    });

    it('keeps a typed release date', async () => {
      release = releaseWith({
        status: StudioReleaseStatus.Scheduled,
        publishAt: new Date('2026-10-20T18:00:00.000Z'),
        releasedOn: '2026-11-01',
      });
      await service.unschedule(USER_ID, RELEASE_ID);
      expect((manager.save.mock.calls[0]![0] as StudioRelease).releasedOn).toBe(
        '2026-11-01',
      );
    });

    it('returns a draft unchanged', async () => {
      await service.unschedule(USER_ID, RELEASE_ID);
      expect(manager.save).not.toHaveBeenCalled();
      expect(catalog.getRelease).toHaveBeenCalledWith(USER_ID, RELEASE_ID);
    });

    it('refuses a published release', async () => {
      release = releaseWith({ status: StudioReleaseStatus.Published });
      expect(await codeOf(service.unschedule(USER_ID, RELEASE_ID))).toBe(
        'studio_release_not_schedulable',
      );
    });
  });

  // Studio artist kinds.
  it('refuses to schedule a mix whose track credits no source', async () => {
    tracks = [
      { id: 'track-1', audioKey: AUDIO_KEY, durationSeconds: 200, sources: [] },
    ];
    expect(
      await codeOf(
        service.schedule(
          USER_ID,
          RELEASE_ID,
          { publishAt: '2026-10-20T18:00:00.000Z' },
          new Date('2026-10-14T09:00:00.000Z'),
        ),
      ),
    ).toBe('studio_publish_missing_sources');
    expect(manager.save).not.toHaveBeenCalled();
  });
});
