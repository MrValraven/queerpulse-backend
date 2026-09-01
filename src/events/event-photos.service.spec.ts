import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RsvpStatus } from './entities/event-rsvp.entity';
import { EventPhotosService } from './event-photos.service';

const GATHERING_KEY =
  'gathering-photos/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.jpg';
const OTHER_GATHERING_KEY =
  'gathering-photos/11111111-1111-1111-1111-111111111111/44444444-4444-4444-4444-444444444444.jpg';
const AVATAR_KEY =
  'avatars/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.jpg';

const organizer = {
  userId: '11111111-1111-1111-1111-111111111111',
  email: '',
  status: 'active',
  role: 'member',
};
const goingMember = {
  ...organizer,
  userId: '33333333-3333-3333-3333-333333333333',
};
const stranger = {
  ...organizer,
  userId: '99999999-9999-9999-9999-999999999999',
};

function build(
  overrides: {
    rsvp?: unknown;
    photoRow?: unknown;
    /** Rows the stubbed album query builder reports for this event. */
    albumRows?: Array<{ id: string; storageKey: string; createdAt: Date }>;
    /** Ids the stubbed `content_moderation` table holds a takedown for. */
    hiddenPhotoIds?: string[];
    /** Moderation state `stateFor` answers with (default: fully visible). */
    moderationState?: { hidden: boolean; removed: boolean };
  } = {},
) {
  const event = {
    id: 'event-1',
    slug: 'poetry-night',
    hostId: organizer.userId,
  };
  const events = { findOne: jest.fn().mockResolvedValue(event) };
  const rsvps = {
    findOne: jest.fn().mockResolvedValue(overrides.rsvp ?? null),
  };
  // The album read is a query builder so the takedown predicate lands BEFORE
  // `take(200)`. This stub stands in for Postgres rather than merely recording
  // calls: it applies `hiddenPhotoIds` only when a `content_moderation`
  // predicate was actually attached. Assert on the RETURNED album and the stub
  // is mutation-sensitive — delete the `excludeModeratedPhotos` call from the
  // service and every takedown test below fails, which a bare
  // `expect(andWhere).toHaveBeenCalled()` would not guarantee.
  const albumRows = overrides.albumRows ?? [];
  const hiddenPhotoIds = new Set(overrides.hiddenPhotoIds ?? []);
  let isTakedownFilterApplied = false;
  const albumQueryBuilder = {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('content_moderation')) {
        isTakedownFilterApplied = true;
      }
      return albumQueryBuilder;
    }),
    getMany: jest
      .fn()
      .mockImplementation(async () =>
        isTakedownFilterApplied
          ? albumRows.filter((row) => !hiddenPhotoIds.has(row.id))
          : albumRows,
      ),
  };
  const photos = {
    createQueryBuilder: jest.fn().mockReturnValue(albumQueryBuilder),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(overrides.photoRow ?? null),
    create: jest.fn().mockImplementation((row: unknown) => row),
    save: jest.fn().mockImplementation((row: object) => ({
      id: 'photo-1',
      createdAt: new Date('2026-07-30T00:00:00.000Z'),
      ...row,
    })),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const profiles = {
    find: jest.fn().mockResolvedValue([]),
  } as never;
  const eventsService = {
    isOrganizer: jest
      .fn()
      .mockImplementation(async (_eventId: string, userId: string) =>
        Promise.resolve(userId === organizer.userId),
      ),
  };
  const storage = {
    createPresignedDownload: jest.fn().mockResolvedValue('https://signed/url'),
    deleteObjectByReference: jest.fn().mockResolvedValue(true),
  };
  const mediaCropService = {
    getMany: jest.fn().mockResolvedValue(new Map()),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const contentModeration = {
    stateFor: jest
      .fn()
      .mockResolvedValue(
        overrides.moderationState ?? { hidden: false, removed: false },
      ),
  };
  const service = new EventPhotosService(
    photos as never,
    events as never,
    rsvps as never,
    profiles,
    eventsService as never,
    storage as never,
    mediaCropService as never,
    contentModeration as never,
  );
  return {
    service,
    events,
    rsvps,
    photos,
    albumQueryBuilder,
    storage,
    mediaCropService,
    contentModeration,
  };
}

describe('EventPhotosService', () => {
  it('attach: rejects a non-organizer', async () => {
    const { service } = build();
    await expect(
      service.attach('poetry-night', goingMember, { key: GATHERING_KEY }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('attach: rejects a non-gathering-photo key', async () => {
    const { service } = build();
    await expect(
      service.attach('poetry-night', organizer, { key: AVATAR_KEY }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('attach: organizer records the row and returns a presigned view', async () => {
    const { service, photos } = build();
    const view = await service.attach('poetry-night', organizer, {
      key: GATHERING_KEY,
      caption: 'the toast',
    });
    expect(photos.save).toHaveBeenCalled();
    expect(view.url).toBe('https://signed/url');
    expect(view.caption).toBe('the toast');
  });

  it('attach: rejects re-attaching a key already on another event', async () => {
    const { service } = build({
      photoRow: {
        id: 'photo-1',
        eventId: 'other-event',
        storageKey: GATHERING_KEY,
        caption: null,
      },
    });
    await expect(
      service.attach('poetry-night', organizer, { key: GATHERING_KEY }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('attach: a same-event repeat refreshes the caption idempotently', async () => {
    const { service, photos } = build({
      photoRow: {
        id: 'photo-1',
        eventId: 'event-1',
        storageKey: GATHERING_KEY,
        caption: 'old',
      },
    });
    const view = await service.attach('poetry-night', organizer, {
      key: GATHERING_KEY,
      caption: 'new',
    });
    expect(photos.save).toHaveBeenCalledWith(
      expect.objectContaining({ caption: 'new' }),
    );
    expect(view.caption).toBe('new');
  });

  it('list: a going member sees photos', async () => {
    const { service } = build({ rsvp: { status: RsvpStatus.Going } });
    await expect(service.list('poetry-night', goingMember)).resolves.toEqual({
      photos: [],
    });
  });

  it('list: a stranger (no RSVP, not organizer) is forbidden', async () => {
    const { service } = build({ rsvp: null });
    await expect(service.list('poetry-night', stranger)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('list: 404s for an unknown event', async () => {
    const { service, events } = build();
    events.findOne.mockResolvedValue(null);
    await expect(service.list('nope', organizer)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('remove: a stranger cannot delete', async () => {
    const { service } = build({
      photoRow: {
        id: 'photo-1',
        eventId: 'event-1',
        uploaderId: organizer.userId,
      },
    });
    await expect(
      service.remove('poetry-night', stranger, 'photo-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('remove: the uploader can delete their own photo', async () => {
    const { service, photos } = build({
      photoRow: {
        id: 'photo-1',
        eventId: 'event-1',
        uploaderId: goingMember.userId,
        storageKey: GATHERING_KEY,
      },
    });
    await expect(
      service.remove('poetry-night', goingMember, 'photo-1'),
    ).resolves.toEqual({ ok: true });
    expect(photos.delete).toHaveBeenCalledWith({ id: 'photo-1' });
  });

  it('remove: takes down the object and the crop, not just the row', async () => {
    const { service, photos, storage, mediaCropService } = build({
      photoRow: {
        id: 'photo-1',
        eventId: 'event-1',
        uploaderId: goingMember.userId,
        storageKey: GATHERING_KEY,
      },
    });
    await service.remove('poetry-night', goingMember, 'photo-1');
    expect(storage.deleteObjectByReference).toHaveBeenCalledWith(GATHERING_KEY);
    expect(mediaCropService.remove).toHaveBeenCalledWith(GATHERING_KEY);
    expect(photos.delete).toHaveBeenCalledWith({ id: 'photo-1' });
  });

  it('remove: deletes the object BEFORE the row, so a bucket failure is retryable', async () => {
    const { service, photos, storage } = build({
      photoRow: {
        id: 'photo-1',
        eventId: 'event-1',
        uploaderId: goingMember.userId,
        storageKey: GATHERING_KEY,
      },
    });
    const callOrder: string[] = [];
    storage.deleteObjectByReference.mockImplementation(async () => {
      callOrder.push('storage');
      return true;
    });
    photos.delete.mockImplementation(async () => {
      callOrder.push('row');
    });
    await service.remove('poetry-night', goingMember, 'photo-1');
    expect(callOrder).toEqual(['storage', 'row']);
  });

  it('remove: a storage failure aborts the take-down and leaves the row standing', async () => {
    const { service, photos, storage, mediaCropService } = build({
      photoRow: {
        id: 'photo-1',
        eventId: 'event-1',
        uploaderId: goingMember.userId,
        storageKey: GATHERING_KEY,
      },
    });
    storage.deleteObjectByReference.mockRejectedValue(new Error('bucket down'));
    await expect(
      service.remove('poetry-night', goingMember, 'photo-1'),
    ).rejects.toThrow('bucket down');
    // Nothing was removed, so the album still shows the photo and the member
    // can press remove again. The opposite order would have deleted the row and
    // left the file live with no way to ask a second time.
    expect(mediaCropService.remove).not.toHaveBeenCalled();
    expect(photos.delete).not.toHaveBeenCalled();
  });

  it('remove: a crop-delete failure also leaves the row standing', async () => {
    const { service, photos, mediaCropService } = build({
      photoRow: {
        id: 'photo-1',
        eventId: 'event-1',
        uploaderId: goingMember.userId,
        storageKey: GATHERING_KEY,
      },
    });
    mediaCropService.remove.mockRejectedValue(new Error('crops unavailable'));
    await expect(
      service.remove('poetry-night', goingMember, 'photo-1'),
    ).rejects.toThrow('crops unavailable');
    expect(photos.delete).not.toHaveBeenCalled();
  });

  it('remove: an organizer can take down a photo they did not upload', async () => {
    const { service, storage, mediaCropService, photos } = build({
      photoRow: {
        id: 'photo-1',
        eventId: 'event-1',
        uploaderId: goingMember.userId,
        storageKey: GATHERING_KEY,
      },
    });
    await expect(
      service.remove('poetry-night', organizer, 'photo-1'),
    ).resolves.toEqual({ ok: true });
    expect(storage.deleteObjectByReference).toHaveBeenCalledWith(GATHERING_KEY);
    expect(mediaCropService.remove).toHaveBeenCalledWith(GATHERING_KEY);
    expect(photos.delete).toHaveBeenCalledWith({ id: 'photo-1' });
  });

  it('remove: a photo on another event 404s and touches no storage', async () => {
    const { service, storage, photos } = build({
      photoRow: {
        id: 'photo-1',
        eventId: 'other-event',
        uploaderId: goingMember.userId,
        storageKey: GATHERING_KEY,
      },
    });
    await expect(
      service.remove('poetry-night', goingMember, 'photo-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.deleteObjectByReference).not.toHaveBeenCalled();
    expect(photos.delete).not.toHaveBeenCalled();
  });

  it('remove: a stranger cannot make us touch the bucket', async () => {
    const { service, storage } = build({
      photoRow: {
        id: 'photo-1',
        eventId: 'event-1',
        uploaderId: organizer.userId,
        storageKey: GATHERING_KEY,
      },
    });
    await expect(
      service.remove('poetry-night', stranger, 'photo-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(storage.deleteObjectByReference).not.toHaveBeenCalled();
  });

  it('remove: a non-key storage value still clears the rows', async () => {
    const { service, photos, storage, mediaCropService } = build({
      photoRow: {
        id: 'photo-1',
        eventId: 'event-1',
        uploaderId: goingMember.userId,
        storageKey: 'https://example.test/legacy.jpg',
      },
    });
    // `deleteObjectByReference` filters non-keys itself and reports false.
    storage.deleteObjectByReference.mockResolvedValue(false);
    await expect(
      service.remove('poetry-night', goingMember, 'photo-1'),
    ).resolves.toEqual({ ok: true });
    expect(mediaCropService.remove).toHaveBeenCalled();
    expect(photos.delete).toHaveBeenCalledWith({ id: 'photo-1' });
  });
  // ── Moderator takedowns (`event_photo` subject) ────────────────────────────
  // A takedown that does not take down is the failure mode here: until this
  // subject existed a photograph of an identifiable person at a queer event
  // could be removed only by its uploader or an organizer, who on the reports
  // that matter most are the very people being complained about.

  const visiblePhoto = {
    id: 'photo-visible',
    eventId: 'event-1',
    storageKey: GATHERING_KEY,
    uploaderId: goingMember.userId,
    caption: null,
    createdAt: new Date('2026-07-30T00:00:00.000Z'),
  };
  const takenDownPhoto = {
    ...visiblePhoto,
    id: 'photo-taken-down',
    storageKey: OTHER_GATHERING_KEY,
  };

  it('list: a taken-down photo is absent from the album', async () => {
    const { service } = build({
      rsvp: { status: RsvpStatus.Going },
      albumRows: [visiblePhoto, takenDownPhoto],
      hiddenPhotoIds: [takenDownPhoto.id],
    });
    const { photos } = await service.list('poetry-night', goingMember);
    expect(photos.map((photo) => photo.id)).toEqual([visiblePhoto.id]);
  });

  it('list: a taken-down photo is absent from the album COUNT too', async () => {
    const { service } = build({
      rsvp: { status: RsvpStatus.Going },
      albumRows: [visiblePhoto, takenDownPhoto],
      hiddenPhotoIds: [takenDownPhoto.id],
    });
    const { photos } = await service.list('poetry-night', goingMember);
    // The album strip is counted from exactly this array on the client, so a
    // hidden photo must not be counted any more than it is rendered.
    expect(photos).toHaveLength(1);
  });

  it('list: an ORGANIZER does not see a taken-down photo either', async () => {
    // The point of the whole subject. Organizers are the people a photo report
    // is most often about, so there is no staff view of a taken-down
    // photograph on this surface.
    const { service } = build({
      albumRows: [visiblePhoto, takenDownPhoto],
      hiddenPhotoIds: [takenDownPhoto.id],
    });
    const { photos } = await service.list('poetry-night', organizer);
    expect(photos.map((photo) => photo.id)).toEqual([visiblePhoto.id]);
  });

  it('list: the takedown filter runs BEFORE the 200 cap', async () => {
    const { service, albumQueryBuilder } = build({
      rsvp: { status: RsvpStatus.Going },
      albumRows: [visiblePhoto],
    });
    await service.list('poetry-night', goingMember);
    // Post-fetch filtering would under-fill the strip: the cap has to count
    // only photographs the album will actually show.
    expect(albumQueryBuilder.take).toHaveBeenCalledWith(200);
    expect(albumQueryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('content_moderation'),
      expect.objectContaining({ photoSubjectType: 'event_photo' }),
    );
  });

  it('list: an untouched album is returned whole', async () => {
    const { service } = build({
      rsvp: { status: RsvpStatus.Going },
      albumRows: [visiblePhoto, takenDownPhoto],
    });
    const { photos } = await service.list('poetry-night', goingMember);
    expect(photos.map((photo) => photo.id)).toEqual([
      visiblePhoto.id,
      takenDownPhoto.id,
    ]);
  });

  it('attach: re-attaching a taken-down key is refused, not answered 200', async () => {
    const { service, photos } = build({
      photoRow: {
        id: 'photo-1',
        eventId: 'event-1',
        storageKey: GATHERING_KEY,
        caption: 'old',
      },
      moderationState: { hidden: true, removed: false },
    });
    await expect(
      service.attach('poetry-night', organizer, {
        key: GATHERING_KEY,
        caption: 'new',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    // A 200 here would hand the organizer a photo view for a photograph the
    // album then refuses to list.
    expect(photos.save).not.toHaveBeenCalled();
  });

  it('attach: a removed photo is refused on the same rule as a hidden one', async () => {
    const { service } = build({
      photoRow: {
        id: 'photo-1',
        eventId: 'event-1',
        storageKey: GATHERING_KEY,
        caption: null,
      },
      moderationState: { hidden: true, removed: true },
    });
    await expect(
      service.attach('poetry-night', organizer, { key: GATHERING_KEY }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('attach: an untouched same-event repeat still succeeds', async () => {
    const { service, contentModeration } = build({
      photoRow: {
        id: 'photo-1',
        eventId: 'event-1',
        storageKey: GATHERING_KEY,
        caption: 'old',
      },
    });
    const view = await service.attach('poetry-night', organizer, {
      key: GATHERING_KEY,
      caption: 'new',
    });
    expect(view.caption).toBe('new');
    expect(contentModeration.stateFor).toHaveBeenCalledWith(
      'event_photo',
      'photo-1',
    );
  });

  it('remove: a taken-down photo can still be removed for real', async () => {
    // A moderator hiding a photo withholds it; the uploader deleting it erases
    // the file. Hiding must never block the stronger action.
    const { service, storage, photos } = build({
      photoRow: {
        id: 'photo-1',
        eventId: 'event-1',
        uploaderId: goingMember.userId,
        storageKey: GATHERING_KEY,
      },
      moderationState: { hidden: true, removed: false },
    });
    await expect(
      service.remove('poetry-night', goingMember, 'photo-1'),
    ).resolves.toEqual({ ok: true });
    expect(storage.deleteObjectByReference).toHaveBeenCalledWith(GATHERING_KEY);
    expect(photos.delete).toHaveBeenCalledWith({ id: 'photo-1' });
  });
});
