import {
  BadRequestException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { PersonaImageKeysService } from '../storage/persona-image-keys.service';
import { StudioAudioUploadsService } from '../storage/studio-audio-uploads.service';
import {
  StudioRelease,
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioOwnershipService } from './studio-ownership.service';
import { StudioReleasesService } from './studio-releases.service';

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
  let manager: { find: jest.Mock; save: jest.Mock; delete: jest.Mock };
  let ownership: {
    assertArtistPersona: jest.Mock;
    lockReleaseForWrite: jest.Mock;
  };
  let catalog: { getRelease: jest.Mock };
  let personaImageKeys: {
    rehomeKeys: jest.Mock;
    isMemberOfKeyPersona: jest.Mock;
  };
  let studioAudioUploads: { deleteObjectsAndForget: jest.Mock };
  let releases: { create: jest.Mock; save: jest.Mock };
  let service: StudioReleasesService;

  beforeEach(() => {
    release = draftRelease();
    personaKind = 'dj';
    tracks = [{ id: 'track-1', audioKey: AUDIO_KEY, durationSeconds: 240 }];
    manager = {
      find: jest.fn(() => Promise.resolve(tracks)),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    ownership = {
      assertArtistPersona: jest.fn(() =>
        Promise.resolve({ id: PERSONA_ID, kind: personaKind }),
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
    const dataSource = {
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
    };
    service = new StudioReleasesService(
      dataSource as unknown as DataSource,
      releases as unknown as Repository<StudioRelease>,
      ownership as unknown as StudioOwnershipService,
      catalog as unknown as StudioCatalogService,
      personaImageKeys as unknown as PersonaImageKeysService,
      studioAudioUploads as unknown as StudioAudioUploadsService,
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
      tracks = [{ id: 'track-1', audioKey: null, durationSeconds: null }];
      expect(await codeOf(service.publish(USER_ID, RELEASE_ID))).toBe(
        'studio_publish_tracks_pending',
      );
    });

    it('publishes on the server clock and fills an empty release date', async () => {
      const before = Date.now();
      await service.publish(USER_ID, RELEASE_ID);
      const saved = manager.save.mock.calls[0]![0] as StudioRelease;
      expect(saved.status).toBe('published');
      expect(saved.publishedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(saved.releasedOn).toBe(
        saved.publishedAt!.toISOString().slice(0, 10),
      );
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
});
