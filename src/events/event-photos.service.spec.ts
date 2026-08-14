import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RsvpStatus } from './entities/event-rsvp.entity';
import { EventPhotosService } from './event-photos.service';

const GATHERING_KEY =
  'gathering-photos/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.jpg';
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

function build(overrides: { rsvp?: unknown; photoRow?: unknown } = {}) {
  const event = {
    id: 'event-1',
    slug: 'poetry-night',
    hostId: organizer.userId,
  };
  const events = { findOne: jest.fn().mockResolvedValue(event) };
  const rsvps = {
    findOne: jest.fn().mockResolvedValue(overrides.rsvp ?? null),
  };
  const photos = {
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
  };
  const mediaCropService = { getMany: jest.fn().mockResolvedValue(new Map()) };
  const service = new EventPhotosService(
    photos as never,
    events as never,
    rsvps as never,
    profiles,
    eventsService as never,
    storage as never,
    mediaCropService as never,
  );
  return { service, events, rsvps, photos, storage, mediaCropService };
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
      },
    });
    await expect(
      service.remove('poetry-night', goingMember, 'photo-1'),
    ).resolves.toEqual({ ok: true });
    expect(photos.delete).toHaveBeenCalledWith({ id: 'photo-1' });
  });
});
