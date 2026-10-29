import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { PersonaImageKeysService } from '../storage/persona-image-keys.service';
import { StudioAudioUploadsService } from '../storage/studio-audio-uploads.service';
import {
  StudioPriceMode,
  StudioRelease,
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import { StudioSceneState } from './entities/studio-scene.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioOwnershipService } from './studio-ownership.service';
import { KEPT_SOURCE_KEYS_HELD_SQL } from './studio-kept-tracks';
import { StudioReleasesService } from './studio-releases.service';
import { scheduleDateInLisbon } from './studio-schedule-rule';
import { STAMP_SHOW_EPISODES_SQL } from './studio-episode-rule';
import {
  PAYMENT_METHOD_COUNT_SQL,
  PAYMENT_METHODS_LOCK_SQL,
  RELEASE_TRACKS_PRICED_SQL,
} from './studio-payment-method-lock';
import { STUDIO_RELEASE_PUBLISHED } from './studio.events';

const USER_ID = 'a2000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = 'a2000000-0000-4000-8000-000000000009';
const PERSONA_ID = 'a2000000-0000-4000-8000-000000000002';
const RELEASE_ID = 'a2000000-0000-4000-8000-000000000003';
const MEMBER_COVER = `persona-covers/${USER_ID}/b0000000-0000-4000-8000-000000000001.jpg`;
const FOREIGN_COVER = `persona-covers/${OTHER_USER_ID}/b0000000-0000-4000-8000-000000000002.jpg`;
const PERSONA_COVER =
  'persona/c0000000-0000-4000-8000-000000000001/c0000000-0000-4000-8000-000000000002.jpg';
const AUDIO_KEY =
  'studio-audio/d0000000-0000-4000-8000-000000000001/d0000000-0000-4000-8000-000000000002.mp3';
const SCENE_ID = 'e1000000-0000-4000-8000-000000000001';
const ARCHIVED_SCENE_ID = 'e1000000-0000-4000-8000-000000000002';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

const draftRelease = (overrides: Partial<StudioRelease> = {}): StudioRelease =>
  ({
    id: RELEASE_ID,
    subprofileId: PERSONA_ID,
    title: 'Lisbon at four',
    type: StudioReleaseType.Mix,
    description: null,
    genre: null,
    genres: [],
    coverKey: PERSONA_COVER,
    releasedOn: null,
    status: StudioReleaseStatus.Draft,
    publishedAt: null,
    rightsConfirmedAt: new Date('2026-10-08T09:00:00.000Z'),
    takedownReason: null,
    ...overrides,
  }) as StudioRelease;

describe('StudioReleasesService', () => {
  let release: StudioRelease;
  let personaKind: string;
  let tracks: Partial<StudioTrack>[];
  let manager: {
    find: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    findOne: jest.Mock;
    query: jest.Mock;
  };
  let ownership: {
    assertArtistPersona: jest.Mock;
    lockReleaseForWrite: jest.Mock;
    loadReleaseForWrite: jest.Mock;
  };
  let trackFind: jest.Mock;
  let catalog: { getRelease: jest.Mock };
  let personaImageKeys: {
    rehomeKeys: jest.Mock;
    isMemberOfKeyPersona: jest.Mock;
  };
  let studioAudioUploads: { deleteObjectsAndForget: jest.Mock };
  let dataSourceQuery: jest.Mock;
  let releases: { create: jest.Mock; save: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let service: StudioReleasesService;

  beforeEach(() => {
    release = draftRelease();
    personaKind = 'dj';
    // The default release is a mix, so its track credits a source.
    tracks = [
      {
        id: 'track-1',
        audioKey: AUDIO_KEY,
        durationSeconds: 240,
        sources: [{ title: 'Rumour Has It', artist: 'Adele' }],
      },
    ];
    manager = {
      find: jest.fn(() => Promise.resolve(tracks)),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn().mockResolvedValue(null),
      query: jest.fn().mockResolvedValue(undefined),
    };
    ownership = {
      assertArtistPersona: jest.fn(() =>
        Promise.resolve({ id: PERSONA_ID, kind: personaKind }),
      ),
      loadReleaseForWrite: jest.fn(() =>
        Promise.resolve({
          release,
          persona: { id: PERSONA_ID, kind: personaKind },
        }),
      ),
      lockReleaseForWrite: jest.fn(() =>
        Promise.resolve({
          release,
          persona: { id: PERSONA_ID, kind: personaKind },
        }),
      ),
    };
    catalog = { getRelease: jest.fn().mockResolvedValue({ id: RELEASE_ID }) };
    personaImageKeys = {
      rehomeKeys: jest.fn().mockResolvedValue(new Map()),
      isMemberOfKeyPersona: jest.fn().mockResolvedValue(false),
    };
    studioAudioUploads = {
      deleteObjectsAndForget: jest.fn().mockResolvedValue(undefined),
    };
    releases = {
      create: jest.fn((row: object) => row),
      save: jest.fn((row: object) =>
        Promise.resolve({ ...row, id: RELEASE_ID }),
      ),
    };
    trackFind = jest.fn(() => Promise.resolve(tracks));
    dataSourceQuery = jest.fn().mockResolvedValue([]);
    const dataSource = {
      query: dataSourceQuery,
      getRepository: jest.fn(() => ({ find: trackFind })),
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
    };
    eventEmitter = { emit: jest.fn() };
    service = new StudioReleasesService(
      dataSource as unknown as DataSource,
      releases as unknown as Repository<StudioRelease>,
      ownership as unknown as StudioOwnershipService,
      catalog as unknown as StudioCatalogService,
      personaImageKeys as unknown as PersonaImageKeysService,
      studioAudioUploads as unknown as StudioAudioUploadsService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  describe('create', () => {
    it('creates a draft mix for a DJ persona', async () => {
      await service.create(USER_ID, {
        subprofileId: PERSONA_ID,
        type: StudioReleaseType.Mix,
        title: 'Lisbon at four',
      });
      expect(releases.save).toHaveBeenCalledWith(
        expect.objectContaining({
          subprofileId: PERSONA_ID,
          type: 'mix',
          status: 'draft',
        }),
      );
      expect(catalog.getRelease).toHaveBeenCalledWith(USER_ID, RELEASE_ID);
    });

    it('answers a type that belongs to the other kind of persona with a type mismatch', async () => {
      expect(
        await codeOf(
          service.create(USER_ID, {
            subprofileId: PERSONA_ID,
            type: StudioReleaseType.Album,
            title: 'Rooms',
          }),
        ),
      ).toBe('studio_release_type_mismatch');
      personaKind = 'musician';
      expect(
        await codeOf(
          service.create(USER_ID, {
            subprofileId: PERSONA_ID,
            type: StudioReleaseType.Mix,
            title: 'Rooms',
          }),
        ),
      ).toBe('studio_release_type_mismatch');
      expect(releases.save).not.toHaveBeenCalled();
    });

    // Studio artist kinds.
    it('presets the spoken word genre for a poet and leaves a show without one', async () => {
      personaKind = 'poet';
      await service.create(USER_ID, {
        subprofileId: PERSONA_ID,
        type: StudioReleaseType.Ep,
        title: 'Salt Poems',
      });
      expect(releases.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: 'ep',
          genre: 'spoken-word',
          genres: ['spoken-word'],
        }),
      );
      personaKind = 'podcaster';
      await service.create(USER_ID, {
        subprofileId: PERSONA_ID,
        type: StudioReleaseType.Podcast,
        title: 'Lisbon After Dark',
      });
      expect(releases.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'podcast', genre: null, genres: [] }),
      );
    });

    it('refuses an album for a podcaster', async () => {
      personaKind = 'podcaster';
      expect(
        await codeOf(
          service.create(USER_ID, {
            subprofileId: PERSONA_ID,
            type: StudioReleaseType.Album,
            title: 'Lisbon After Dark',
          }),
        ),
      ).toBe('studio_release_type_mismatch');
    });
  });

  describe('publish', () => {
    it.each([
      ['a blank title', { title: ' ' }, 'studio_publish_missing_title'],
      ['no cover', { coverKey: null }, 'studio_publish_missing_cover'],
      [
        'no rights confirmation',
        { rightsConfirmedAt: null },
        'studio_publish_missing_rights',
      ],
    ] as const)(
      'refuses a release with %s',
      async (_label, overrides, expectedCode) => {
        release = draftRelease(overrides);
        expect(await codeOf(service.publish(USER_ID, RELEASE_ID))).toBe(
          expectedCode,
        );
        expect(manager.save).not.toHaveBeenCalled();
      },
    );

    it('refuses a release with no tracks, then one still uploading', async () => {
      tracks = [];
      expect(await codeOf(service.publish(USER_ID, RELEASE_ID))).toBe(
        'studio_publish_missing_tracks',
      );
      tracks = [
        { id: 'track-1', audioKey: null, durationSeconds: null, sources: [] },
      ];
      expect(await codeOf(service.publish(USER_ID, RELEASE_ID))).toBe(
        'studio_publish_tracks_pending',
      );
    });

    it('publishes on the server clock and fills an empty release date with the Lisbon day', async () => {
      const before = Date.now();
      await service.publish(USER_ID, RELEASE_ID);
      const saved = manager.save.mock.calls[0]![0] as StudioRelease;
      expect(saved.status).toBe('published');
      expect(saved.publishedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(saved.releasedOn).toBe(scheduleDateInLisbon(saved.publishedAt!));
    });

    it('fills the Lisbon day for a publish late in the UTC evening of the summer', async () => {
      jest.useFakeTimers({ now: new Date('2026-07-14T23:30:00.000Z') });
      try {
        await service.publish(USER_ID, RELEASE_ID);
        const saved = manager.save.mock.calls[0]![0] as StudioRelease;
        expect(saved.releasedOn).toBe('2026-07-15');
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps a release date the artist chose', async () => {
      release = draftRelease({ releasedOn: '2026-09-01' });
      await service.publish(USER_ID, RELEASE_ID);
      expect((manager.save.mock.calls[0]![0] as StudioRelease).releasedOn).toBe(
        '2026-09-01',
      );
    });

    it('refuses a release that is already published or taken down', async () => {
      release = draftRelease({
        status: StudioReleaseStatus.Published,
        publishedAt: new Date(),
      });
      expect(await codeOf(service.publish(USER_ID, RELEASE_ID))).toBe(
        'studio_release_not_draft',
      );
      release = draftRelease({ status: StudioReleaseStatus.TakenDown });
      expect(await codeOf(service.publish(USER_ID, RELEASE_ID))).toBe(
        'studio_release_not_draft',
      );
    });

    // Studio v3: "Publish now" on a scheduled release.
    it('publishes a scheduled release now and clears its time', async () => {
      release = draftRelease({
        status: StudioReleaseStatus.Scheduled,
        publishAt: new Date('2026-12-01T18:00:00.000Z'),
        releasedOn: '2026-11-20',
      });
      await service.publish(USER_ID, RELEASE_ID);
      const saved = manager.save.mock.calls[0]![0] as StudioRelease;
      expect(saved.status).toBe('published');
      expect(saved.publishAt).toBeNull();
      expect(saved.releasedOn).toBe('2026-11-20');
      expect(eventEmitter.emit).toHaveBeenCalledWith(STUDIO_RELEASE_PUBLISHED, {
        releaseId: RELEASE_ID,
      });
    });

    it('replaces a release date that scheduling filled with the Lisbon publish day', async () => {
      release = draftRelease({
        status: StudioReleaseStatus.Scheduled,
        publishAt: new Date('2026-12-01T18:00:00.000Z'),
        releasedOn: '2026-12-01',
      });
      await service.publish(USER_ID, RELEASE_ID);
      const saved = manager.save.mock.calls[0]![0] as StudioRelease;
      expect(saved.releasedOn).toBe(scheduleDateInLisbon(saved.publishedAt!));
    });

    it('names the Lisbon day when the publish happens late in the evening UTC', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-20T23:30:00.000Z') });
      try {
        release = draftRelease({
          status: StudioReleaseStatus.Scheduled,
          publishAt: new Date('2026-12-01T18:00:00.000Z'),
          releasedOn: '2026-12-01',
        });
        await service.publish(USER_ID, RELEASE_ID);
        const saved = manager.save.mock.calls[0]![0] as StudioRelease;
        expect(saved.releasedOn).toBe('2026-10-21');
      } finally {
        jest.useRealTimers();
      }
    });

    // Studio v2: the alert listener hears about a publish only once it has
    // committed, and a refused publish tells it nothing.
    it('tells the alert listener once the publish has committed', async () => {
      await service.publish(USER_ID, RELEASE_ID);

      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(STUDIO_RELEASE_PUBLISHED, {
        releaseId: RELEASE_ID,
      });
      const saveOrder = manager.save.mock.invocationCallOrder[0] ?? 0;
      const emitOrder = eventEmitter.emit.mock.invocationCallOrder[0] ?? 0;
      expect(saveOrder).toBeLessThan(emitOrder);
    });

    it('tells the alert listener nothing when the publish rule refuses', async () => {
      tracks = [];
      await codeOf(service.publish(USER_ID, RELEASE_ID));
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    // Studio artist kinds.
    it('refuses a mix whose track credits no source and changes nothing', async () => {
      tracks = [
        {
          id: 'track-1',
          audioKey: AUDIO_KEY,
          durationSeconds: 240,
          sources: [],
        },
      ];
      expect(await codeOf(service.publish(USER_ID, RELEASE_ID))).toBe(
        'studio_publish_missing_sources',
      );
      expect(manager.save).not.toHaveBeenCalled();
      expect(manager.find).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          select: expect.objectContaining({ sources: true }) as unknown,
        }),
      );
    });

    it("stamps the show's episodes in the publish transaction, with the publish time", async () => {
      release = draftRelease({ type: StudioReleaseType.Podcast });
      personaKind = 'podcaster';
      tracks = [
        {
          id: 'track-1',
          audioKey: AUDIO_KEY,
          durationSeconds: 1800,
          sources: [],
        },
      ];
      await service.publish(USER_ID, RELEASE_ID);
      const saved = manager.save.mock.calls[0]![0] as StudioRelease;
      expect(manager.query).toHaveBeenCalledWith(STAMP_SHOW_EPISODES_SQL, [
        RELEASE_ID,
        saved.publishedAt,
      ]);
      expect(manager.save.mock.invocationCallOrder[0]).toBeLessThan(
        manager.query.mock.invocationCallOrder[0]!,
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(STUDIO_RELEASE_PUBLISHED, {
        releaseId: RELEASE_ID,
      });
    });

    it('stamps nothing for a release of another type', async () => {
      await service.publish(USER_ID, RELEASE_ID);
      expect(manager.query).not.toHaveBeenCalled();
    });
  });

  describe('unpublish', () => {
    it('returns a published release to draft and clears published_at', async () => {
      release = draftRelease({
        status: StudioReleaseStatus.Published,
        publishedAt: new Date(),
      });
      await service.unpublish(USER_ID, RELEASE_ID);
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'draft', publishedAt: null }),
      );
    });

    it('clears the preview link when a published release goes back to draft', async () => {
      release = draftRelease({
        status: StudioReleaseStatus.Published,
        publishedAt: new Date(),
        previewToken: 'a'.repeat(64),
        previewLinkCreatedAt: new Date('2026-10-10T09:00:00.000Z'),
      });
      await service.unpublish(USER_ID, RELEASE_ID);
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'draft',
          previewToken: null,
          previewLinkCreatedAt: null,
        }),
      );
    });

    it('returns a draft unchanged', async () => {
      await service.unpublish(USER_ID, RELEASE_ID);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('refuses a taken-down release, so the owner cannot lift a takedown', async () => {
      release = draftRelease({ status: StudioReleaseStatus.TakenDown });
      expect(await codeOf(service.unpublish(USER_ID, RELEASE_ID))).toBe(
        'studio_release_not_draft',
      );
    });

    it('emits no new-release event when a release goes back to draft', async () => {
      release = draftRelease({
        status: StudioReleaseStatus.Published,
        publishedAt: new Date(),
      });
      await service.unpublish(USER_ID, RELEASE_ID);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('refuses every owner edit of a taken-down release', async () => {
      release = draftRelease({ status: StudioReleaseStatus.TakenDown });
      expect(
        await codeOf(service.update(USER_ID, RELEASE_ID, { title: 'New' })),
      ).toBe('studio_release_not_draft');
    });

    it('edits a published release in place', async () => {
      release = draftRelease({
        status: StudioReleaseStatus.Published,
        publishedAt: new Date(),
      });
      await service.update(USER_ID, RELEASE_ID, {
        description: '  Liner notes  ',
      });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Liner notes',
          status: 'published',
        }),
      );
    });

    it('refuses to clear the cover of a published release and changes nothing', async () => {
      release = draftRelease({
        status: StudioReleaseStatus.Published,
        publishedAt: new Date(),
      });
      expect(
        await codeOf(
          service.update(USER_ID, RELEASE_ID, {
            title: 'New',
            coverKey: null,
          }),
        ),
      ).toBe('studio_publish_missing_cover');
      expect(release.coverKey).toBe(PERSONA_COVER);
      expect(release.title).toBe('Lisbon at four');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('refuses to clear the cover of a scheduled release', async () => {
      release = draftRelease({
        status: StudioReleaseStatus.Scheduled,
        publishAt: new Date('2026-12-01T18:00:00.000Z'),
      });
      expect(
        await codeOf(service.update(USER_ID, RELEASE_ID, { coverKey: null })),
      ).toBe('studio_publish_missing_cover');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('stores a buy link and clears it with null', async () => {
      await service.update(USER_ID, RELEASE_ID, {
        buyUrl: 'https://nightshift.bandcamp.com/album/lisbon',
      });
      expect((manager.save.mock.calls[0]![0] as StudioRelease).buyUrl).toBe(
        'https://nightshift.bandcamp.com/album/lisbon',
      );
      await service.update(USER_ID, RELEASE_ID, { buyUrl: null });
      expect(
        (manager.save.mock.calls[1]![0] as StudioRelease).buyUrl,
      ).toBeNull();
    });

    it('stores play without gaps and turns it off again', async () => {
      await service.update(USER_ID, RELEASE_ID, { isGapless: true });
      expect((manager.save.mock.calls[0]![0] as StudioRelease).isGapless).toBe(
        true,
      );
      await service.update(USER_ID, RELEASE_ID, { isGapless: false });
      expect((manager.save.mock.calls[1]![0] as StudioRelease).isGapless).toBe(
        false,
      );
    });

    it('stamps the rights confirmation once', async () => {
      const firstStamp = new Date('2026-10-01T00:00:00.000Z');
      release = draftRelease({ rightsConfirmedAt: firstStamp });
      await service.update(USER_ID, RELEASE_ID, { rightsConfirmed: true });
      expect(
        (manager.save.mock.calls[0]![0] as StudioRelease).rightsConfirmedAt,
      ).toBe(firstStamp);
    });

    it('refuses a type change that does not fit the persona', async () => {
      expect(
        await codeOf(
          service.update(USER_ID, RELEASE_ID, {
            type: StudioReleaseType.Single,
          }),
        ),
      ).toBe('studio_release_type_mismatch');
    });

    it('copies a member-scoped cover to a persona-scoped key', async () => {
      personaImageKeys.rehomeKeys.mockResolvedValue(
        new Map([[MEMBER_COVER, PERSONA_COVER]]),
      );
      release = draftRelease({ coverKey: null });
      await service.update(USER_ID, RELEASE_ID, { coverKey: MEMBER_COVER });
      expect(personaImageKeys.rehomeKeys).toHaveBeenCalledWith(
        manager,
        PERSONA_ID,
        [MEMBER_COVER],
        { shouldCopyMemberScoped: true, personaScopedMode: 'keep-own' },
      );
      expect((manager.save.mock.calls[0]![0] as StudioRelease).coverKey).toBe(
        PERSONA_COVER,
      );
    });

    it('keeps the stored cover without copying it again', async () => {
      await service.update(USER_ID, RELEASE_ID, { coverKey: PERSONA_COVER });
      expect(personaImageKeys.rehomeKeys).not.toHaveBeenCalled();
    });

    it("refuses another member's upload as a cover", async () => {
      await expect(
        service.update(USER_ID, RELEASE_ID, { coverKey: FOREIGN_COVER }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(personaImageKeys.rehomeKeys).not.toHaveBeenCalled();
    });

    it('refuses an external image or a message attachment as a cover', async () => {
      await expect(
        service.update(USER_ID, RELEASE_ID, {
          coverKey: 'https://images.unsplash.com/photo-1',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.update(USER_ID, RELEASE_ID, {
          coverKey: `message-images/${USER_ID}/b0000000-0000-4000-8000-000000000003.jpg`,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('answers a cover upload that is gone with a 400', async () => {
      personaImageKeys.rehomeKeys.mockResolvedValue(
        new Map([[MEMBER_COVER, null]]),
      );
      await expect(
        service.update(USER_ID, RELEASE_ID, { coverKey: MEMBER_COVER }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('stores a mood and clears it with null', async () => {
      await service.update(USER_ID, RELEASE_ID, { mood: 'tender' });
      expect((manager.save.mock.calls[0]![0] as StudioRelease).mood).toBe(
        'tender',
      );
      await service.update(USER_ID, RELEASE_ID, { mood: null });
      expect((manager.save.mock.calls[1]![0] as StudioRelease).mood).toBeNull();
    });

    it('stores the genres in order, mirrors the lead into genre and clears with an empty list', async () => {
      await service.update(USER_ID, RELEASE_ID, {
        genres: ['folk', 'pop', 'fado'],
      });
      expect(manager.save.mock.calls[0]![0] as StudioRelease).toEqual(
        expect.objectContaining({
          genre: 'folk',
          genres: ['folk', 'pop', 'fado'],
        }),
      );
      await service.update(USER_ID, RELEASE_ID, { genres: [] });
      expect(manager.save.mock.calls[1]![0] as StudioRelease).toEqual(
        expect.objectContaining({ genre: null, genres: [] }),
      );
    });

    it('leaves genre and genres alone when the body carries no genres', async () => {
      release = draftRelease({ genre: 'fado', genres: ['fado', 'folk'] });
      await service.update(USER_ID, RELEASE_ID, { mood: 'tender' });
      expect(manager.save.mock.calls[0]![0] as StudioRelease).toEqual(
        expect.objectContaining({ genre: 'fado', genres: ['fado', 'folk'] }),
      );
    });

    it('opts the release into an active scene', async () => {
      manager.findOne.mockResolvedValue({ id: SCENE_ID });

      await service.update(USER_ID, RELEASE_ID, { sceneId: SCENE_ID });

      expect(manager.findOne).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          where: { id: SCENE_ID, status: StudioSceneState.Active },
        }),
      );
      expect((manager.save.mock.calls[0]![0] as StudioRelease).sceneId).toBe(
        SCENE_ID,
      );
    });

    it('refuses an unknown or archived scene', async () => {
      manager.findOne.mockResolvedValue(null);
      expect(
        await codeOf(
          service.update(USER_ID, RELEASE_ID, { sceneId: ARCHIVED_SCENE_ID }),
        ),
      ).toBe('studio_scene_not_available');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it("keeps the release's own archived scene and refuses to move another release into it", async () => {
      release = draftRelease({ sceneId: ARCHIVED_SCENE_ID });
      await service.update(USER_ID, RELEASE_ID, {
        sceneId: ARCHIVED_SCENE_ID.toUpperCase(),
        title: 'Renamed',
      });
      expect(manager.findOne).not.toHaveBeenCalled();
      expect((manager.save.mock.calls[0]![0] as StudioRelease).sceneId).toBe(
        ARCHIVED_SCENE_ID,
      );

      release = draftRelease({ sceneId: SCENE_ID });
      manager.findOne.mockResolvedValue(null);
      expect(
        await codeOf(
          service.update(USER_ID, RELEASE_ID, { sceneId: ARCHIVED_SCENE_ID }),
        ),
      ).toBe('studio_scene_not_available');
    });

    it('leaves the scene with null and asks nothing about scenes', async () => {
      release = draftRelease({ sceneId: SCENE_ID });
      await service.update(USER_ID, RELEASE_ID, { sceneId: null });
      expect(manager.findOne).not.toHaveBeenCalled();
      expect(
        (manager.save.mock.calls[0]![0] as StudioRelease).sceneId,
      ).toBeNull();
    });
  });

  // Studio purchases (contract 2.1).
  describe('update prices', () => {
    const querySqls = (): unknown[] =>
      manager.query.mock.calls.map(([sql]) => sql as unknown);

    beforeEach(() => {
      personaKind = 'musician';
      release = draftRelease({
        type: StudioReleaseType.Album,
        priceMode: StudioPriceMode.NotForSale,
        priceCents: null,
      });
    });

    it('prices a release after taking the payment-methods lock under the release lock', async () => {
      manager.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([{ count: 1 }]);
      await service.update(USER_ID, RELEASE_ID, {
        price: { mode: 'fixed', amountCents: 900 },
      });
      expect(querySqls()).toEqual([
        PAYMENT_METHODS_LOCK_SQL,
        PAYMENT_METHOD_COUNT_SQL,
      ]);
      expect(manager.query.mock.calls.map(([, params]) => params)).toEqual([
        [PERSONA_ID],
        [PERSONA_ID],
      ]);
      expect(manager.query.mock.invocationCallOrder[0]).toBeGreaterThan(
        ownership.lockReleaseForWrite.mock.invocationCallOrder[0] ?? Infinity,
      );
      expect(manager.save.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ priceMode: 'fixed', priceCents: 900 }),
      );
    });

    it('refuses a price on a mix with studio_release_type_not_for_sale before any lock', async () => {
      personaKind = 'dj';
      release = draftRelease();
      expect(
        await codeOf(
          service.update(USER_ID, RELEASE_ID, {
            price: { mode: 'name_your_price', amountCents: 0 },
          }),
        ),
      ).toBe('studio_release_type_not_for_sale');
      expect(manager.query).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('reads the type this PATCH sets before the price check', async () => {
      personaKind = 'dj';
      expect(
        await codeOf(
          service.update(USER_ID, RELEASE_ID, {
            type: StudioReleaseType.Mix,
            price: { mode: 'fixed', amountCents: 900 },
          }),
        ),
      ).toBe('studio_release_type_not_for_sale');
      expect(manager.query).not.toHaveBeenCalled();

      personaKind = 'musician';
      release = draftRelease({ type: StudioReleaseType.Mix });
      manager.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([{ count: 2 }]);
      await service.update(USER_ID, RELEASE_ID, {
        type: StudioReleaseType.Single,
        price: { mode: 'name_your_price', amountCents: 0 },
      });
      expect(querySqls()).toEqual([
        PAYMENT_METHODS_LOCK_SQL,
        PAYMENT_METHOD_COUNT_SQL,
      ]);
      expect(manager.save.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          type: 'single',
          priceMode: 'name_your_price',
          priceCents: 0,
        }),
      );
    });

    it('refuses a fixed price under one euro with studio_price_out_of_range', async () => {
      expect(
        await codeOf(
          service.update(USER_ID, RELEASE_ID, {
            price: { mode: 'fixed', amountCents: 99 },
          }),
        ),
      ).toBe('studio_price_out_of_range');
      expect(manager.query).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('refuses a price while the persona has no payment methods', async () => {
      manager.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([{ count: 0 }]);
      expect(
        await codeOf(
          service.update(USER_ID, RELEASE_ID, {
            price: { mode: 'fixed', amountCents: 900 },
          }),
        ),
      ).toBe('studio_payment_methods_needed_for_sale');
      expect(querySqls()).toEqual([
        PAYMENT_METHODS_LOCK_SQL,
        PAYMENT_METHOD_COUNT_SQL,
      ]);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('refuses a type change to an unsellable type while a track on the release is priced', async () => {
      personaKind = 'dj';
      manager.query.mockResolvedValueOnce([{ has_priced_tracks: true }]);
      expect(
        await codeOf(
          service.update(USER_ID, RELEASE_ID, { type: StudioReleaseType.Mix }),
        ),
      ).toBe('studio_release_type_not_for_sale');
      expect(manager.query.mock.calls).toEqual([
        [RELEASE_TRACKS_PRICED_SQL, [RELEASE_ID, null]],
      ]);
      expect(manager.save).not.toHaveBeenCalled();

      manager.query.mockClear();
      manager.query.mockResolvedValueOnce([{ has_priced_tracks: false }]);
      await service.update(USER_ID, RELEASE_ID, {
        type: StudioReleaseType.Mix,
      });
      expect(manager.save.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ type: 'mix', priceMode: 'not_for_sale' }),
      );
    });

    it('refuses a type change to an unsellable type while the release itself stays priced', async () => {
      personaKind = 'dj';
      release = draftRelease({
        type: StudioReleaseType.Album,
        priceMode: StudioPriceMode.Fixed,
        priceCents: 900,
      });
      expect(
        await codeOf(
          service.update(USER_ID, RELEASE_ID, { type: StudioReleaseType.Mix }),
        ),
      ).toBe('studio_release_type_not_for_sale');
      expect(manager.query).not.toHaveBeenCalled();

      manager.query.mockResolvedValueOnce([{ has_priced_tracks: false }]);
      await service.update(USER_ID, RELEASE_ID, {
        type: StudioReleaseType.Mix,
        price: null,
      });
      expect(manager.save.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          type: 'mix',
          priceMode: 'not_for_sale',
          priceCents: null,
        }),
      );
    });

    it('takes a release off sale with null and needs no payment method for it', async () => {
      release = draftRelease({
        type: StudioReleaseType.Album,
        priceMode: StudioPriceMode.Fixed,
        priceCents: 900,
      });
      await service.update(USER_ID, RELEASE_ID, { price: null });
      expect(manager.query).not.toHaveBeenCalled();
      expect(manager.save.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          priceMode: 'not_for_sale',
          priceCents: null,
        }),
      );
    });

    it('leaves the price alone when the body has none and never stamps tracks_changed_at for a price', async () => {
      release = draftRelease({
        type: StudioReleaseType.Album,
        status: StudioReleaseStatus.Published,
        publishedAt: new Date('2026-10-01T00:00:00.000Z'),
        priceMode: StudioPriceMode.NameYourPrice,
        priceCents: 300,
      });
      await service.update(USER_ID, RELEASE_ID, { title: 'Lisbon at five' });
      expect(manager.query).not.toHaveBeenCalled();
      expect(manager.save.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          title: 'Lisbon at five',
          priceMode: 'name_your_price',
          priceCents: 300,
        }),
      );

      manager.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([{ count: 1 }]);
      await service.update(USER_ID, RELEASE_ID, {
        price: { mode: 'fixed', amountCents: 1200 },
      });
      expect(
        querySqls().some((sql) => String(sql).includes('tracks_changed_at')),
      ).toBe(false);
      expect(release.tracksChangedAt).toBeUndefined();
    });

    it('keeps a taken-down release frozen', async () => {
      release = draftRelease({
        type: StudioReleaseType.Album,
        status: StudioReleaseStatus.TakenDown,
      });
      expect(
        await codeOf(
          service.update(USER_ID, RELEASE_ID, {
            price: { mode: 'fixed', amountCents: 900 },
          }),
        ),
      ).toBe('studio_release_not_draft');
      expect(manager.query).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes a draft and then its audio objects', async () => {
      await service.remove(USER_ID, RELEASE_ID);
      expect(manager.delete).toHaveBeenCalledWith(StudioRelease, {
        id: RELEASE_ID,
      });
      expect(studioAudioUploads.deleteObjectsAndForget).toHaveBeenCalledWith([
        AUDIO_KEY,
      ]);
    });

    it('keeps the audio objects a pending kept copy still reads', async () => {
      dataSourceQuery.mockResolvedValue([{ source_audio_key: AUDIO_KEY }]);
      await service.remove(USER_ID, RELEASE_ID);
      expect(dataSourceQuery.mock.calls).toEqual([
        [KEPT_SOURCE_KEYS_HELD_SQL, [[AUDIO_KEY]]],
      ]);
      expect(studioAudioUploads.deleteObjectsAndForget.mock.calls).toEqual([
        [[]],
      ]);
    });

    it('refuses to delete a published release and keeps its audio', async () => {
      release = draftRelease({
        status: StudioReleaseStatus.Published,
        publishedAt: new Date(),
      });
      expect(await codeOf(service.remove(USER_ID, RELEASE_ID))).toBe(
        'studio_release_not_draft',
      );
      expect(studioAudioUploads.deleteObjectsAndForget).not.toHaveBeenCalled();
    });
  });

  describe('trackSources', () => {
    it('lists the sources of the tracks that have audio, in track order', async () => {
      tracks = [
        {
          id: 'track-1',
          audioKey: AUDIO_KEY,
          sources: [{ title: 'Rumour Has It', artist: 'Adele' }],
        },
        { id: 'track-2', audioKey: null, sources: [] },
        { id: 'track-3', audioKey: AUDIO_KEY, sources: null },
      ] as unknown as Partial<StudioTrack>[];

      const result = await service.trackSources(USER_ID, RELEASE_ID);

      expect(ownership.loadReleaseForWrite).toHaveBeenCalledWith(
        USER_ID,
        RELEASE_ID,
      );
      expect(trackFind).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { releaseId: RELEASE_ID },
          order: { position: 'ASC' },
        }),
      );
      expect(result).toEqual({
        tracks: [
          {
            trackId: 'track-1',
            sources: [{ title: 'Rumour Has It', artist: 'Adele' }],
          },
          { trackId: 'track-3', sources: [] },
        ],
      });
    });

    it('answers an empty list for a release with no audio yet', async () => {
      tracks = [{ id: 'track-1', audioKey: null, sources: [] }];
      expect(await service.trackSources(USER_ID, RELEASE_ID)).toEqual({
        tracks: [],
      });
    });

    it('answers 404 to a stranger and reads no tracks', async () => {
      ownership.loadReleaseForWrite.mockRejectedValue(
        new NotFoundException('Release not found'),
      );
      await expect(
        service.trackSources(OTHER_USER_ID, RELEASE_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(trackFind).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown release and reads no tracks', async () => {
      ownership.loadReleaseForWrite.mockRejectedValue(
        new NotFoundException('Release not found'),
      );
      await expect(
        service.trackSources(USER_ID, 'a2000000-0000-4000-8000-0000000000ff'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(trackFind).not.toHaveBeenCalled();
    });
  });
});
