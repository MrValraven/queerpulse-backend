import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, Not } from 'typeorm';
import { StudioAudioUploadsService } from '../storage/studio-audio-uploads.service';
import {
  StudioPriceMode,
  StudioRelease,
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioOwnershipService } from './studio-ownership.service';
import {
  PAYMENT_METHOD_COUNT_SQL,
  PAYMENT_METHODS_LOCK_SQL,
} from './studio-payment-method-lock';
import { KEPT_SOURCE_KEYS_HELD_SQL } from './studio-kept-tracks';
import { STAMP_TRACKS_CHANGED_SQL } from './studio-release-edit-rule';
import { StudioTracksService, isSameTrackSet } from './studio-tracks.service';

const USER_ID = 'e2000000-0000-4000-8000-000000000001';
const RELEASE_ID = 'e2000000-0000-4000-8000-000000000002';
const FIRST_TRACK = 'e2000000-0000-4000-8000-000000000003';
const SECOND_TRACK = 'e2000000-0000-4000-8000-000000000004';
const THIRD_TRACK = 'e2000000-0000-4000-8000-000000000005';
const AUDIO_KEY =
  'studio-audio/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.mp3';
const PEAKS = Array.from({ length: 200 }, (_unused, index) => index);
const CHAPTER_BODY = [
  { startSeconds: 0, title: 'Intro' },
  { startSeconds: 120, title: 'Second', artist: '' },
  { startSeconds: 180, title: 'Third', artist: 'Ana Moura' },
];

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
  let releaseType: StudioReleaseType;
  let personaKind: string;
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
  let dataSourceQuery: jest.Mock;
  let service: StudioTracksService;

  beforeEach(() => {
    releaseStatus = StudioReleaseStatus.Draft;
    releaseType = StudioReleaseType.Album;
    personaKind = 'musician';
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
          release: {
            id: RELEASE_ID,
            subprofileId: 'persona-1',
            status: releaseStatus,
            type: releaseType,
          } as StudioRelease,
          persona: { id: 'persona-1', kind: personaKind },
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
    dataSourceQuery = jest.fn().mockResolvedValue([]);
    const dataSource = {
      query: dataSourceQuery,
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

    it('adds a track to a published release and stamps the track change', async () => {
      releaseStatus = StudioReleaseStatus.Published;
      await service.create(USER_ID, RELEASE_ID, { title: 'Bonus' });
      expect(manager.save).toHaveBeenCalled();
      expect(manager.query).toHaveBeenCalledWith(STAMP_TRACKS_CHANGED_SQL, [
        RELEASE_ID,
      ]);
    });

    it('adds a track to a scheduled release without stamping it', async () => {
      releaseStatus = StudioReleaseStatus.Scheduled;
      await service.create(USER_ID, RELEASE_ID, { title: 'Bonus' });
      expect(manager.save).toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
    });

    it('refuses a new track on a taken-down release', async () => {
      releaseStatus = StudioReleaseStatus.TakenDown;
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

    it('stores the waveform, the loudness pair, timed lyrics and chapters', async () => {
      storedTrack = { ...storedTrack, durationSeconds: 200 };
      await service.update(USER_ID, FIRST_TRACK, {
        waveformPeaks: PEAKS,
        loudnessLufs: -9.5,
        peakDb: -0.4,
        syncedLyrics: [
          { ms: 0, text: 'First line' },
          { ms: 4000, text: '' },
        ],
        chapters: CHAPTER_BODY,
      });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          waveformPeaks: PEAKS,
          loudnessLufs: -9.5,
          peakDb: -0.4,
          syncedLyrics: [
            { ms: 0, text: 'First line' },
            { ms: 4000, text: '' },
          ],
          chapters: [
            { startSeconds: 0, title: 'Intro', artist: null },
            { startSeconds: 120, title: 'Second', artist: null },
            { startSeconds: 180, title: 'Third', artist: 'Ana Moura' },
          ],
        }),
      );
    });

    it('clears each listening field with null, chapters included on a track without audio', async () => {
      storedTrack = {
        ...storedTrack,
        audioKey: null,
        durationSeconds: null,
        waveformPeaks: PEAKS,
        loudnessLufs: -9.5,
        peakDb: -0.4,
        syncedLyrics: [{ ms: 0, text: 'First line' }],
        chapters: [{ startSeconds: 0, title: 'Intro', artist: null }],
      };
      await service.update(USER_ID, FIRST_TRACK, {
        waveformPeaks: null,
        loudnessLufs: null,
        peakDb: null,
        syncedLyrics: null,
        chapters: null,
      });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          waveformPeaks: null,
          loudnessLufs: null,
          peakDb: null,
          syncedLyrics: null,
          chapters: null,
        }),
      );
    });

    it('leaves the listening fields as stored when a PATCH omits them', async () => {
      storedTrack = {
        ...storedTrack,
        durationSeconds: 200,
        waveformPeaks: PEAKS,
        loudnessLufs: -9.5,
        peakDb: -0.4,
        syncedLyrics: [{ ms: 0, text: 'First line' }],
        chapters: [{ startSeconds: 0, title: 'Intro', artist: null }],
      };
      await service.update(USER_ID, FIRST_TRACK, { title: 'Opening (edit)' });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Opening (edit)',
          waveformPeaks: PEAKS,
          loudnessLufs: -9.5,
          peakDb: -0.4,
          syncedLyrics: [{ ms: 0, text: 'First line' }],
          chapters: [{ startSeconds: 0, title: 'Intro', artist: null }],
        }),
      );
    });

    it('answers studio_chapters_out_of_range for a chapter starting at the last second boundary', async () => {
      storedTrack = { ...storedTrack, durationSeconds: 200 };
      expect(
        await codeOf(
          service.update(USER_ID, FIRST_TRACK, {
            chapters: [
              { startSeconds: 0, title: 'Intro' },
              { startSeconds: 200, title: 'Too late' },
            ],
          }),
        ),
      ).toBe('studio_chapters_out_of_range');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it.each([
      [
        'no audio key and no duration',
        { audioKey: null, durationSeconds: null },
      ],
      [
        'an audio key whose duration is not read yet',
        { durationSeconds: null },
      ],
    ])(
      'answers studio_chapters_out_of_range on a track with no confirmed audio (%s)',
      async (_label, trackState) => {
        storedTrack = { ...storedTrack, ...trackState };
        expect(
          await codeOf(
            service.update(USER_ID, FIRST_TRACK, {
              chapters: [{ startSeconds: 0, title: 'Intro' }],
            }),
          ),
        ).toBe('studio_chapters_out_of_range');
        expect(manager.save).not.toHaveBeenCalled();
      },
    );

    it('checks chapters against the duration read under the lock', async () => {
      manager.findOne
        .mockResolvedValueOnce({ id: FIRST_TRACK, releaseId: RELEASE_ID })
        .mockResolvedValueOnce({ ...storedTrack, durationSeconds: 100 });
      expect(
        await codeOf(
          service.update(USER_ID, FIRST_TRACK, {
            chapters: [
              { startSeconds: 0, title: 'Intro' },
              { startSeconds: 150, title: 'Second' },
            ],
          }),
        ),
      ).toBe('studio_chapters_out_of_range');
    });

    it('refuses listening fields on a taken-down release', async () => {
      releaseStatus = StudioReleaseStatus.TakenDown;
      expect(
        await codeOf(
          service.update(USER_ID, FIRST_TRACK, {
            loudnessLufs: -9.5,
            peakDb: -0.4,
          }),
        ),
      ).toBe('studio_release_not_draft');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('saves listening fields on a published release without stamping the track change', async () => {
      releaseStatus = StudioReleaseStatus.Published;
      await service.update(USER_ID, FIRST_TRACK, {
        loudnessLufs: -9.5,
        peakDb: -0.4,
      });
      expect(manager.save).toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
    });

    // Studio safety and moderation.
    it('stores the artist warnings once each, in theme order, and keeps the staff list', async () => {
      storedTrack = {
        ...storedTrack,
        contentWarnings: [],
        staffContentWarnings: ['violence'],
      };
      await service.update(USER_ID, FIRST_TRACK, {
        contentWarnings: ['police', 'medical', 'police'],
      });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          contentWarnings: ['medical', 'police'],
          staffContentWarnings: ['violence'],
        }),
      );
    });

    it('clears the artist warnings with an empty list', async () => {
      storedTrack = { ...storedTrack, contentWarnings: ['police'] };
      await service.update(USER_ID, FIRST_TRACK, { contentWarnings: [] });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ contentWarnings: [] }),
      );
    });

    it('refuses to clear the explicit flag our team locked, and saves nothing', async () => {
      storedTrack = {
        ...storedTrack,
        isExplicit: true,
        explicitLockedAt: new Date('2026-10-14T10:00:00.000Z'),
      };
      expect(
        await codeOf(
          service.update(USER_ID, FIRST_TRACK, {
            title: 'Renamed',
            isExplicit: false,
          }),
        ),
      ).toBe('studio_track_explicit_locked');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('takes a locked track kept explicit as a no-op on the flag', async () => {
      storedTrack = {
        ...storedTrack,
        isExplicit: true,
        explicitLockedAt: new Date('2026-10-14T10:00:00.000Z'),
      };
      await service.update(USER_ID, FIRST_TRACK, { isExplicit: true });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ isExplicit: true }),
      );
    });

    it('lets the artist clear a flag our team never locked', async () => {
      storedTrack = {
        ...storedTrack,
        isExplicit: true,
        explicitLockedAt: null,
      };
      await service.update(USER_ID, FIRST_TRACK, { isExplicit: false });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ isExplicit: false }),
      );
    });

    it('re-reads the track under a row lock once the release is locked', async () => {
      await service.update(USER_ID, FIRST_TRACK, { title: 'Opening (edit)' });
      expect(manager.findOne).toHaveBeenCalledWith(StudioTrack, {
        where: { id: FIRST_TRACK, releaseId: RELEASE_ID },
        lock: { mode: 'pessimistic_write' },
      });
    });
  });

  // Studio purchases (contract 2.1).
  describe('update prices', () => {
    it('prices a track on an album after the release lock and the payment-methods lock', async () => {
      manager.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([{ count: 1 }]);
      await service.update(USER_ID, FIRST_TRACK, {
        price: { mode: 'name_your_price', amountCents: 300 },
      });
      expect(manager.query.mock.calls).toEqual([
        [PAYMENT_METHODS_LOCK_SQL, ['persona-1']],
        [PAYMENT_METHOD_COUNT_SQL, ['persona-1']],
      ]);
      expect(manager.query.mock.invocationCallOrder[0]).toBeGreaterThan(
        ownership.lockReleaseForWrite.mock.invocationCallOrder[0] ?? Infinity,
      );
      expect(manager.save.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          id: FIRST_TRACK,
          priceMode: 'name_your_price',
          priceCents: 300,
        }),
      );
    });

    it('refuses a price on a track of a podcast show with studio_release_type_not_for_sale', async () => {
      releaseType = StudioReleaseType.Podcast;
      personaKind = 'podcaster';
      expect(
        await codeOf(
          service.update(USER_ID, FIRST_TRACK, {
            price: { mode: 'fixed', amountCents: 200 },
          }),
        ),
      ).toBe('studio_release_type_not_for_sale');
      expect(manager.query).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('refuses a fixed track price under one euro and a price while the persona has no payment methods', async () => {
      expect(
        await codeOf(
          service.update(USER_ID, FIRST_TRACK, {
            price: { mode: 'fixed', amountCents: 50 },
          }),
        ),
      ).toBe('studio_price_out_of_range');
      expect(manager.query).not.toHaveBeenCalled();

      manager.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([{ count: 0 }]);
      expect(
        await codeOf(
          service.update(USER_ID, FIRST_TRACK, {
            price: { mode: 'fixed', amountCents: 100 },
          }),
        ),
      ).toBe('studio_payment_methods_needed_for_sale');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('takes a track off sale with null', async () => {
      releaseStatus = StudioReleaseStatus.Published;
      storedTrack = {
        ...storedTrack,
        priceMode: StudioPriceMode.Fixed,
        priceCents: 500,
      };
      await service.update(USER_ID, FIRST_TRACK, { price: null });
      expect(manager.query).not.toHaveBeenCalled();
      expect(manager.save.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          priceMode: 'not_for_sale',
          priceCents: null,
        }),
      );
    });

    it('leaves the track price alone when the body has none', async () => {
      storedTrack = {
        ...storedTrack,
        priceMode: StudioPriceMode.Fixed,
        priceCents: 500,
      };
      await service.update(USER_ID, FIRST_TRACK, { title: 'Opening (edit)' });
      expect(manager.query).not.toHaveBeenCalled();
      expect(manager.save.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ priceMode: 'fixed', priceCents: 500 }),
      );
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

    it('removes a track from a published release that keeps a playable one, then stamps the change', async () => {
      releaseStatus = StudioReleaseStatus.Published;
      currentTracks = [
        { id: SECOND_TRACK, audioKey: AUDIO_KEY, durationSeconds: 200 },
      ];
      await service.remove(USER_ID, FIRST_TRACK);
      expect(manager.find).toHaveBeenCalledWith(StudioTrack, {
        where: { releaseId: RELEASE_ID, id: Not(FIRST_TRACK) },
        select: {
          id: true,
          audioKey: true,
          durationSeconds: true,
          publishedAt: true,
        },
      });
      expect(
        ownership.lockReleaseForWrite.mock.invocationCallOrder[0],
      ).toBeLessThan(manager.find.mock.invocationCallOrder[0]!);
      expect(manager.delete).toHaveBeenCalledWith(StudioTrack, {
        id: FIRST_TRACK,
      });
      expect(manager.query).toHaveBeenLastCalledWith(STAMP_TRACKS_CHANGED_SQL, [
        RELEASE_ID,
      ]);
      expect(studioAudioUploads.deleteObjectsAndForget).toHaveBeenCalledWith([
        AUDIO_KEY,
      ]);
    });

    it('keeps the audio a pending kept copy still reads', async () => {
      dataSourceQuery.mockResolvedValue([{ source_audio_key: AUDIO_KEY }]);
      await service.remove(USER_ID, FIRST_TRACK);
      expect(dataSourceQuery.mock.calls).toEqual([
        [KEPT_SOURCE_KEYS_HELD_SQL, [[AUDIO_KEY]]],
      ]);
      expect(manager.delete).toHaveBeenCalled();
      expect(studioAudioUploads.deleteObjectsAndForget).not.toHaveBeenCalled();
    });

    it('refuses to remove the last playable track of a published release and keeps its audio', async () => {
      releaseStatus = StudioReleaseStatus.Published;
      currentTracks = [
        { id: SECOND_TRACK, audioKey: null, durationSeconds: null },
      ];
      expect(await codeOf(service.remove(USER_ID, FIRST_TRACK))).toBe(
        'studio_release_needs_playable_track',
      );
      expect(manager.delete).not.toHaveBeenCalled();
      expect(studioAudioUploads.deleteObjectsAndForget).not.toHaveBeenCalled();
    });

    it('refuses to empty a scheduled release', async () => {
      releaseStatus = StudioReleaseStatus.Scheduled;
      currentTracks = [];
      expect(await codeOf(service.remove(USER_ID, FIRST_TRACK))).toBe(
        'studio_release_needs_playable_track',
      );
    });

    it('deletes from a draft without the playable-track check', async () => {
      await service.remove(USER_ID, FIRST_TRACK);
      expect(manager.find).not.toHaveBeenCalled();
      expect(manager.delete).toHaveBeenCalled();
    });

    it('refuses on a taken-down release and keeps the audio', async () => {
      releaseStatus = StudioReleaseStatus.TakenDown;
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

    it('reorders a published release and stamps the change after the move', async () => {
      releaseStatus = StudioReleaseStatus.Published;
      await service.reorder(USER_ID, RELEASE_ID, {
        trackIds: [SECOND_TRACK, FIRST_TRACK],
      });
      expect(manager.query).toHaveBeenCalledTimes(2);
      expect(manager.query.mock.calls[1]).toEqual([
        STAMP_TRACKS_CHANGED_SQL,
        [RELEASE_ID],
      ]);
    });

    it('refuses to reorder a taken-down release', async () => {
      releaseStatus = StudioReleaseStatus.TakenDown;
      expect(
        await codeOf(
          service.reorder(USER_ID, RELEASE_ID, {
            trackIds: [SECOND_TRACK, FIRST_TRACK],
          }),
        ),
      ).toBe('studio_release_not_draft');
    });
  });

  // Studio artist kinds.
  describe('artist kinds', () => {
    it('adds a 51st episode to a show and refuses the 501st', async () => {
      releaseType = StudioReleaseType.Podcast;
      personaKind = 'podcaster';
      manager.count.mockResolvedValue(50);
      await service.create(USER_ID, RELEASE_ID, { title: 'Episode 51' });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Episode 51', position: 51 }),
      );
      manager.save.mockClear();
      manager.count.mockResolvedValue(500);
      expect(
        await codeOf(
          service.create(USER_ID, RELEASE_ID, { title: 'Episode 501' }),
        ),
      ).toBe('studio_episode_limit');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('still refuses a music release at 50 tracks with studio_track_limit', async () => {
      manager.count.mockResolvedValue(50);
      expect(
        await codeOf(service.create(USER_ID, RELEASE_ID, { title: 'More' })),
      ).toBe('studio_track_limit');
    });

    it('adds a draft episode to a published show and stamps nothing', async () => {
      releaseStatus = StudioReleaseStatus.Published;
      releaseType = StudioReleaseType.Podcast;
      personaKind = 'podcaster';
      await service.create(USER_ID, RELEASE_ID, { title: 'Episode 4' });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Episode 4', position: 3 }),
      );
      expect(manager.query).not.toHaveBeenCalled();
    });

    it('stores a 60000 character transcript on a podcast episode', async () => {
      releaseType = StudioReleaseType.Podcast;
      personaKind = 'podcaster';
      await service.update(USER_ID, FIRST_TRACK, {
        lyrics: 't'.repeat(60000),
      });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ lyrics: 't'.repeat(60000) }),
      );
    });

    it('refuses lyrics over 10000 characters on a music track and saves nothing', async () => {
      await expect(
        service.update(USER_ID, FIRST_TRACK, { lyrics: 'l'.repeat(10001) }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('stores show notes on an episode and clears blank notes', async () => {
      releaseType = StudioReleaseType.Podcast;
      personaKind = 'podcaster';
      await service.update(USER_ID, FIRST_TRACK, {
        notes: '00:00 Intro\n01:30 Housing in Lisbon',
      });
      expect(manager.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          notes: '00:00 Intro\n01:30 Housing in Lisbon',
        }),
      );
      await service.update(USER_ID, FIRST_TRACK, { notes: '   ' });
      expect(manager.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ notes: null }),
      );
    });

    it('refuses show notes on an album track', async () => {
      expect(
        await codeOf(
          service.update(USER_ID, FIRST_TRACK, { notes: 'Liner notes' }),
        ),
      ).toBe('studio_not_a_podcast');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('stores the sources of a lip-sync mix', async () => {
      releaseType = StudioReleaseType.LipSync;
      personaKind = 'drag';
      await service.update(USER_ID, FIRST_TRACK, {
        sources: [{ title: 'Rumour Has It', artist: 'Adele' }],
      });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          sources: [{ title: 'Rumour Has It', artist: 'Adele' }],
        }),
      );
    });

    it('refuses to clear the sources of a published mix', async () => {
      releaseStatus = StudioReleaseStatus.Published;
      releaseType = StudioReleaseType.Mix;
      personaKind = 'dj';
      expect(
        await codeOf(service.update(USER_ID, FIRST_TRACK, { sources: [] })),
      ).toBe('studio_publish_missing_sources');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('refuses to reorder a published show and writes nothing', async () => {
      releaseStatus = StudioReleaseStatus.Published;
      releaseType = StudioReleaseType.Podcast;
      personaKind = 'podcaster';
      expect(
        await codeOf(
          service.reorder(USER_ID, RELEASE_ID, {
            trackIds: [SECOND_TRACK, FIRST_TRACK],
          }),
        ),
      ).toBe('studio_episode_order_locked');
      expect(manager.find).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
    });

    it('reorders a draft show', async () => {
      releaseType = StudioReleaseType.Podcast;
      personaKind = 'podcaster';
      await service.reorder(USER_ID, RELEASE_ID, {
        trackIds: [SECOND_TRACK, FIRST_TRACK],
      });
      expect(manager.query).toHaveBeenCalledTimes(1);
    });

    it('refuses to remove the last published episode of a live show though a draft episode has audio', async () => {
      releaseStatus = StudioReleaseStatus.Published;
      releaseType = StudioReleaseType.Podcast;
      personaKind = 'podcaster';
      currentTracks = [
        {
          id: SECOND_TRACK,
          audioKey: AUDIO_KEY,
          durationSeconds: 1800,
          publishedAt: null,
        },
      ];
      expect(await codeOf(service.remove(USER_ID, FIRST_TRACK))).toBe(
        'studio_release_needs_playable_track',
      );
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it('removes an episode of a live show that keeps a published one, with no version stamp', async () => {
      releaseStatus = StudioReleaseStatus.Published;
      releaseType = StudioReleaseType.Podcast;
      personaKind = 'podcaster';
      currentTracks = [
        {
          id: SECOND_TRACK,
          audioKey: AUDIO_KEY,
          durationSeconds: 1800,
          publishedAt: new Date('2026-10-01T09:00:00.000Z'),
        },
      ];
      await service.remove(USER_ID, FIRST_TRACK);
      expect(manager.delete).toHaveBeenCalledWith(StudioTrack, {
        id: FIRST_TRACK,
      });
      expect(manager.query).not.toHaveBeenCalledWith(STAMP_TRACKS_CHANGED_SQL, [
        RELEASE_ID,
      ]);
    });
  });
});
