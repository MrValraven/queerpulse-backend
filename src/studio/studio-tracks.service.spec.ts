import { HttpException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { StudioAudioUploadsService } from '../storage/studio-audio-uploads.service';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioOwnershipService } from './studio-ownership.service';
import { StudioTracksService, isSameTrackSet } from './studio-tracks.service';

const USER_ID = 'e2000000-0000-4000-8000-000000000001';
const RELEASE_ID = 'e2000000-0000-4000-8000-000000000002';
const FIRST_TRACK = 'e2000000-0000-4000-8000-000000000003';
const SECOND_TRACK = 'e2000000-0000-4000-8000-000000000004';
const THIRD_TRACK = 'e2000000-0000-4000-8000-000000000005';
const AUDIO_KEY =
  'studio-audio/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.mp3';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

describe('isSameTrackSet', () => {
  it('accepts every current track exactly once, in any order', () => {
    expect(
      isSameTrackSet([FIRST_TRACK, SECOND_TRACK], [SECOND_TRACK, FIRST_TRACK]),
    ).toBe(true);
  });

  it.each([
    ['a missing track', [FIRST_TRACK]],
    ['a duplicate', [FIRST_TRACK, FIRST_TRACK]],
    ['a track of another release', [FIRST_TRACK, THIRD_TRACK]],
  ])('refuses %s', (_label, requestedTrackIds) => {
    expect(isSameTrackSet([FIRST_TRACK, SECOND_TRACK], requestedTrackIds)).toBe(
      false,
    );
  });
});

describe('StudioTracksService', () => {
  let releaseStatus: StudioReleaseStatus;
  let storedTrack: Partial<StudioTrack> | null;
  let currentTracks: Partial<StudioTrack>[];
  let manager: {
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    delete: jest.Mock;
    query: jest.Mock;
  };
  let ownership: { lockReleaseForWrite: jest.Mock };
  let catalog: { getTrack: jest.Mock; getRelease: jest.Mock };
  let studioAudioUploads: { deleteObjectsAndForget: jest.Mock };
  let service: StudioTracksService;

  beforeEach(() => {
    releaseStatus = StudioReleaseStatus.Draft;
    storedTrack = {
      id: FIRST_TRACK,
      releaseId: RELEASE_ID,
      position: 1,
      title: 'Opening',
      audioKey: AUDIO_KEY,
      credits: [],
      lyrics: null,
      isExplicit: false,
    };
    currentTracks = [{ id: FIRST_TRACK }, { id: SECOND_TRACK }];
    manager = {
      count: jest.fn().mockResolvedValue(2),
      create: jest.fn((_entity: unknown, row: object) => row),
      save: jest.fn((row: object) =>
        Promise.resolve({ id: THIRD_TRACK, ...row }),
      ),
      find: jest.fn(() => Promise.resolve(currentTracks)),
      findOne: jest.fn(() => Promise.resolve(storedTrack)),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      query: jest.fn().mockResolvedValue(undefined),
    };
    ownership = {
      lockReleaseForWrite: jest.fn(() =>
        Promise.resolve({
          release: { id: RELEASE_ID, status: releaseStatus } as StudioRelease,
          persona: { id: 'persona-1', kind: 'musician' },
        }),
      ),
    };
    catalog = {
      getTrack: jest.fn().mockResolvedValue({ id: THIRD_TRACK }),
      getRelease: jest.fn().mockResolvedValue({ id: RELEASE_ID }),
    };
    studioAudioUploads = {
      deleteObjectsAndForget: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
    };
    service = new StudioTracksService(
      dataSource as unknown as DataSource,
      ownership as unknown as StudioOwnershipService,
      catalog as unknown as StudioCatalogService,
      studioAudioUploads as unknown as StudioAudioUploadsService,
    );
  });

  describe('create', () => {
    it('appends a track at the next position', async () => {
      await service.create(USER_ID, RELEASE_ID, { title: 'Closing' });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          releaseId: RELEASE_ID,
          position: 3,
          title: 'Closing',
        }),
      );
      expect(catalog.getTrack).toHaveBeenCalledWith(USER_ID, THIRD_TRACK);
    });

    it('answers studio_track_limit once a release holds 50 tracks', async () => {
      manager.count.mockResolvedValue(50);
      expect(
        await codeOf(
          service.create(USER_ID, RELEASE_ID, { title: 'One more' }),
        ),
      ).toBe('studio_track_limit');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('refuses a new track on a published release', async () => {
      releaseStatus = StudioReleaseStatus.Published;
      expect(
        await codeOf(service.create(USER_ID, RELEASE_ID, { title: 'Late' })),
      ).toBe('studio_release_not_draft');
    });
  });

  describe('update', () => {
    it('saves credits in order, keeps lyrics as written and clears blank lyrics', async () => {
      await service.update(USER_ID, FIRST_TRACK, {
        credits: [
          { name: 'Ana', role: 'Vocals' },
          { name: 'Rui', role: 'Guitar' },
        ],
        lyrics: '  first line\nsecond line',
        isExplicit: true,
      });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          credits: [
            { name: 'Ana', role: 'Vocals' },
            { name: 'Rui', role: 'Guitar' },
          ],
          lyrics: '  first line\nsecond line',
          isExplicit: true,
        }),
      );
      manager.save.mockClear();
      await service.update(USER_ID, FIRST_TRACK, { lyrics: '   ' });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ lyrics: null }),
      );
    });

    it('edits a track of a published release and refuses a taken-down one', async () => {
      releaseStatus = StudioReleaseStatus.Published;
      await service.update(USER_ID, FIRST_TRACK, { title: 'Opening (edit)' });
      expect(manager.save).toHaveBeenCalled();
      releaseStatus = StudioReleaseStatus.TakenDown;
      expect(
        await codeOf(service.update(USER_ID, FIRST_TRACK, { title: 'x' })),
      ).toBe('studio_release_not_draft');
    });

    it('answers 404 for a track that vanished while it waited for the lock', async () => {
      manager.findOne
        .mockResolvedValueOnce({ id: FIRST_TRACK, releaseId: RELEASE_ID })
        .mockResolvedValueOnce(null);
      await expect(
        service.update(USER_ID, FIRST_TRACK, { title: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes the track, closes the gap in one statement, then deletes its audio', async () => {
      await service.remove(USER_ID, FIRST_TRACK);
      expect(manager.delete).toHaveBeenCalledWith(StudioTrack, {
        id: FIRST_TRACK,
      });
      expect(manager.query).toHaveBeenCalledWith(
        `UPDATE "studio_tracks" SET "position" = "position" - 1 WHERE "release_id" = $1 AND "position" > $2`,
        [RELEASE_ID, 1],
      );
      expect(studioAudioUploads.deleteObjectsAndForget).toHaveBeenCalledWith([
        AUDIO_KEY,
      ]);
      expect(manager.delete.mock.invocationCallOrder[0]).toBeLessThan(
        manager.query.mock.invocationCallOrder[0]!,
      );
      expect(manager.query.mock.invocationCallOrder[0]).toBeLessThan(
        studioAudioUploads.deleteObjectsAndForget.mock.invocationCallOrder[0]!,
      );
    });

    it('refuses on a published release and keeps the audio', async () => {
      releaseStatus = StudioReleaseStatus.Published;
      expect(await codeOf(service.remove(USER_ID, FIRST_TRACK))).toBe(
        'studio_release_not_draft',
      );
      expect(studioAudioUploads.deleteObjectsAndForget).not.toHaveBeenCalled();
    });
  });

  describe('reorder', () => {
    it('locks the release before it reads the track list', async () => {
      await service.reorder(USER_ID, RELEASE_ID, {
        trackIds: [SECOND_TRACK, FIRST_TRACK],
      });
      expect(
        ownership.lockReleaseForWrite.mock.invocationCallOrder[0],
      ).toBeLessThan(manager.find.mock.invocationCallOrder[0]!);
    });

    it('writes every position in one statement', async () => {
      await service.reorder(USER_ID, RELEASE_ID, {
        trackIds: [SECOND_TRACK, FIRST_TRACK],
      });
      expect(manager.query).toHaveBeenCalledTimes(1);
      const [statement, parameters] = manager.query.mock.calls[0] as [
        string,
        unknown[],
      ];
      expect(statement).toContain('unnest($2::uuid[], $3::smallint[])');
      expect(parameters).toEqual([
        RELEASE_ID,
        [SECOND_TRACK, FIRST_TRACK],
        [1, 2],
      ]);
      expect(catalog.getRelease).toHaveBeenCalledWith(USER_ID, RELEASE_ID);
    });

    it('answers a mismatch when a track was deleted first', async () => {
      currentTracks = [{ id: FIRST_TRACK }];
      expect(
        await codeOf(
          service.reorder(USER_ID, RELEASE_ID, {
            trackIds: [SECOND_TRACK, FIRST_TRACK],
          }),
        ),
      ).toBe('studio_track_order_mismatch');
      expect(manager.query).not.toHaveBeenCalled();
    });

    it('refuses to reorder a published release', async () => {
      releaseStatus = StudioReleaseStatus.Published;
      expect(
        await codeOf(
          service.reorder(USER_ID, RELEASE_ID, {
            trackIds: [SECOND_TRACK, FIRST_TRACK],
          }),
        ),
      ).toBe('studio_release_not_draft');
    });
  });
});
