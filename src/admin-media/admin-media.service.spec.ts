import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminMediaService } from './admin-media.service';
import { StorageService } from '../storage/storage.service';
import { MediaReferenceResolver } from '../media-references/media-reference.resolver';
import { MediaReference } from '../media-references/media-reference.types';
import { ModAuditService } from '../moderation/mod-audit.service';
import { Profile } from '../users/entities/profile.entity';
import {
  isPrivateMessageKey,
  PRIVATE_MESSAGE_PREFIXES,
  UPLOAD_KIND_SPECS,
} from '../storage/upload-kinds';
import { encodeBrowseCursor } from './admin-media-browse-cursor';
import { PersonaImageKeysService } from '../storage/persona-image-keys.service';
import { PERSONA_SCOPED_PREFIX } from '../storage/storage-key';

const ownerId = '11111111-1111-1111-1111-111111111111';
const actorId = '22222222-2222-2222-2222-222222222222';
const avatarKey = `avatars/${ownerId}/33333333-3333-3333-3333-333333333333.jpg`;
const communityAvatarKey = `community-avatars/${ownerId}/66666666-6666-6666-6666-666666666666.png`;
const messageImageKey = `message-images/${ownerId}/44444444-4444-4444-4444-444444444444.jpg`;
const messageDocumentKey = `message-documents/${ownerId}/55555555-5555-5555-5555-555555555555.pdf`;

const publicPrefixes = [
  ...Object.values(UPLOAD_KIND_SPECS)
    .map((spec) => spec.prefix)
    .filter((prefix) => !PRIVATE_MESSAGE_PREFIXES.has(prefix)),
  // T17: unlinked persona images.
  PERSONA_SCOPED_PREFIX,
];
const personaKey =
  'persona/77777777-7777-4777-8777-777777777777/88888888-8888-4888-8888-888888888888.jpg';

function storedObject(key: string) {
  return { key, size: 10, lastModified: '2026-01-01T00:00:00.000Z' };
}

async function makeService(
  storageOverrides: Record<string, jest.Mock> = {},
  personaOverrides: Record<string, jest.Mock> = {},
) {
  const storage = {
    listObjects: jest
      .fn()
      .mockResolvedValue({ objects: [], nextContinuationToken: null }),
    listUserObjects: jest.fn().mockResolvedValue([]),
    createPresignedDownload: jest
      .fn()
      .mockImplementation((key: string) =>
        Promise.resolve(`https://bucket.example/${key}?signed`),
      ),
    headObject: jest
      .fn()
      .mockResolvedValue({ contentType: 'image/jpeg', contentLength: 10 }),
    deleteObjectByKey: jest.fn().mockResolvedValue(undefined),
    ...storageOverrides,
  };
  const references = {
    resolve: jest.fn().mockResolvedValue({
      references: new Map<string, MediaReference[]>(),
      degraded: false,
    }),
  };
  const modAudit = { writeAuditLog: jest.fn().mockResolvedValue(undefined) };
  const profiles = { find: jest.fn().mockResolvedValue([]) };
  // T17: no persona-scoped keys unless a test stages some.
  const personaImageKeys = {
    listObjectsUploadedBy: jest.fn().mockResolvedValue([]),
    uploaderIdsFor: jest.fn().mockResolvedValue(new Map<string, string>()),
    forgetDeletedKeys: jest.fn().mockResolvedValue(undefined),
    ...personaOverrides,
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      AdminMediaService,
      { provide: StorageService, useValue: storage },
      { provide: MediaReferenceResolver, useValue: references },
      { provide: ModAuditService, useValue: modAudit },
      { provide: getRepositoryToken(Profile), useValue: profiles },
      { provide: PersonaImageKeysService, useValue: personaImageKeys },
    ],
  }).compile();

  return {
    service: moduleRef.get(AdminMediaService),
    storage,
    references,
    modAudit,
    profiles,
    personaImageKeys,
  };
}

describe('isPrivateMessageKey', () => {
  it('matches both message attachment prefixes and nothing else', () => {
    expect(isPrivateMessageKey(messageImageKey)).toBe(true);
    expect(isPrivateMessageKey(messageDocumentKey)).toBe(true);
    expect(isPrivateMessageKey(avatarKey)).toBe(false);
  });

  it('matches a leading slash and any letter case in the first segment', () => {
    expect(isPrivateMessageKey(`/${messageImageKey}`)).toBe(true);
    expect(isPrivateMessageKey('Message-Documents/a/b.pdf')).toBe(true);
    expect(isPrivateMessageKey(`/${avatarKey}`)).toBe(false);
  });
});

describe('AdminMediaService.list', () => {
  it('drops private message objects at the chokepoint and signs only what it returns', async () => {
    const { service, storage, references } = await makeService({
      listObjects: jest.fn().mockImplementation(({ prefix }) =>
        Promise.resolve({
          objects:
            prefix === 'avatars/'
              ? [
                  storedObject(avatarKey),
                  storedObject(messageDocumentKey),
                  storedObject(messageImageKey),
                ]
              : [],
          nextContinuationToken: null,
        }),
      ),
    });

    const response = await service.list({});

    expect(response.objects.map((object) => object.key)).toEqual([avatarKey]);
    expect(storage.createPresignedDownload).toHaveBeenCalledTimes(1);
    expect(storage.createPresignedDownload).toHaveBeenCalledWith(avatarKey);
    expect(references.resolve).toHaveBeenCalledWith([avatarKey]);
  });

  it('never requests a private message prefix from storage during the "All" browse', async () => {
    const { service, storage } = await makeService();

    const response = await service.list({});

    const requestedPrefixes = storage.listObjects.mock.calls.map(
      ([params]) => (params as { prefix: string }).prefix,
    );
    expect(requestedPrefixes).toEqual(
      [...publicPrefixes].sort().map((prefix) => `${prefix}/`),
    );
    for (const requestedPrefix of requestedPrefixes) {
      expect(isPrivateMessageKey(requestedPrefix)).toBe(false);
    }
    expect(response.objects).toEqual([]);
    expect(response.nextContinuationToken).toBeNull();
  });

  it('fills an "All" page across a prefix boundary and resumes from the cursor', async () => {
    const listObjects = jest.fn().mockImplementation(({ prefix }) => {
      if (prefix === 'avatars/') {
        return Promise.resolve({
          objects: [storedObject(avatarKey)],
          nextContinuationToken: null,
        });
      }
      if (prefix === 'community-avatars/') {
        return Promise.resolve({
          objects: [storedObject(communityAvatarKey)],
          nextContinuationToken: 'community-avatars-next',
        });
      }
      return Promise.resolve({ objects: [], nextContinuationToken: null });
    });
    const { service } = await makeService({ listObjects });

    const firstPage = await service.list({ limit: 2 });

    expect(firstPage.objects.map((object) => object.key)).toEqual([
      avatarKey,
      communityAvatarKey,
    ]);
    expect(listObjects).toHaveBeenCalledTimes(2);
    expect(listObjects).toHaveBeenNthCalledWith(1, {
      prefix: 'avatars/',
      continuationToken: undefined,
      maxKeys: 2,
    });
    expect(listObjects).toHaveBeenNthCalledWith(2, {
      prefix: 'community-avatars/',
      continuationToken: undefined,
      maxKeys: 1,
    });
    expect(firstPage.nextContinuationToken).toBe(
      encodeBrowseCursor({
        prefix: 'community-avatars',
        token: 'community-avatars-next',
      }),
    );

    listObjects.mockClear();
    await service.list({
      limit: 2,
      continuationToken: firstPage.nextContinuationToken ?? undefined,
    });

    expect(listObjects).toHaveBeenNthCalledWith(1, {
      prefix: 'community-avatars/',
      continuationToken: 'community-avatars-next',
      maxKeys: 2,
    });
  });

  it.each([
    [
      'a cursor naming a private prefix',
      encodeBrowseCursor({ prefix: 'message-images', token: null }),
    ],
    [
      'a cursor naming an unknown prefix',
      encodeBrowseCursor({ prefix: 'secrets', token: null }),
    ],
    ['a cursor that is not base64url', 'not a cursor!'],
    [
      'a cursor that is not JSON',
      Buffer.from('avatars', 'utf8').toString('base64url'),
    ],
    [
      'a cursor missing its token field',
      Buffer.from(JSON.stringify({ prefix: 'avatars' }), 'utf8').toString(
        'base64url',
      ),
    ],
    [
      'a cursor with an extra field',
      Buffer.from(
        JSON.stringify({ prefix: 'avatars', token: null, extra: 1 }),
        'utf8',
      ).toString('base64url'),
    ],
  ])(
    'rejects %s with a 400 before touching storage',
    async (_label, cursor) => {
      const { service, storage } = await makeService();

      await expect(
        service.list({ continuationToken: cursor }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.listObjects).not.toHaveBeenCalled();
    },
  );

  it('drops private message objects from the per-uploader view', async () => {
    const { service, storage } = await makeService({
      listUserObjects: jest
        .fn()
        .mockResolvedValue([
          storedObject(messageImageKey),
          storedObject(avatarKey),
          storedObject(messageDocumentKey),
        ]),
    });

    const response = await service.list({ uploaderId: ownerId });

    expect(response.objects.map((object) => object.key)).toEqual([avatarKey]);
    expect(storage.createPresignedDownload).not.toHaveBeenCalledWith(
      messageImageKey,
    );
    expect(storage.createPresignedDownload).not.toHaveBeenCalledWith(
      messageDocumentKey,
    );
  });

  // T17: a persona-scoped key names no uploader, so the uploader view adds
  // the registry's rows and the uploader column reads the registry.
  it('adds the persona-scoped images the registry records to the per-uploader view, named by the registry', async () => {
    const { service, profiles, personaImageKeys } = await makeService(
      {
        listUserObjects: jest.fn().mockResolvedValue([storedObject(avatarKey)]),
      },
      {
        listObjectsUploadedBy: jest
          .fn()
          .mockResolvedValue([
            { ...storedObject(personaKey), uploadKind: 'avatar' },
          ]),
        uploaderIdsFor: jest
          .fn()
          .mockResolvedValue(new Map([[personaKey, ownerId]])),
      },
    );
    profiles.find.mockResolvedValue([
      { userId: ownerId, firstName: 'Robin', lastName: 'Vale', slug: 'robin' },
    ]);

    const response = await service.list({ uploaderId: ownerId });

    expect(personaImageKeys.listObjectsUploadedBy).toHaveBeenCalledWith(
      ownerId,
    );
    const personaRow = response.objects.find(
      (object) => object.key === personaKey,
    );
    expect(personaRow?.uploaderId).toBe(ownerId);
    expect(personaRow?.uploader?.handle).toBe('robin');
    expect(response.objects.map((object) => object.key).sort()).toEqual(
      [avatarKey, personaKey].sort(),
    );
  });

  it.each(['message-images', 'message-documents'])(
    'rejects the %s prefix filter as an unknown kind',
    async (prefix) => {
      const { service, storage } = await makeService();

      await expect(service.list({ prefix })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(storage.listObjects).not.toHaveBeenCalled();
    },
  );
});

describe('AdminMediaService.head', () => {
  it.each([messageImageKey, messageDocumentKey])(
    '404s a private message key without touching the bucket (%s)',
    async (key) => {
      const { service, storage } = await makeService();

      await expect(service.head(key)).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.headObject).not.toHaveBeenCalled();
      expect(storage.createPresignedDownload).not.toHaveBeenCalled();
    },
  );

  it('still inspects a browsable key', async () => {
    const { service } = await makeService();

    await expect(service.head(avatarKey)).resolves.toEqual({
      key: avatarKey,
      contentType: 'image/jpeg',
      contentLength: 10,
    });
  });
});

describe('AdminMediaService.delete', () => {
  // T17: a persona-scoped key is served only while its registry row exists,
  // so the row (and any crop) goes with the object.
  it.each([
    ['an unforced', false],
    ['a forced', true],
  ])(
    'forgets a persona-scoped key after %s delete of its object',
    async (_label, force) => {
      const { service, storage, personaImageKeys } = await makeService();

      await service.delete(personaKey, actorId, force);

      expect(storage.deleteObjectByKey).toHaveBeenCalledWith(personaKey);
      expect(personaImageKeys.forgetDeletedKeys).toHaveBeenCalledWith([
        personaKey,
      ]);
      expect(
        storage.deleteObjectByKey.mock.invocationCallOrder[0]!,
      ).toBeLessThan(
        personaImageKeys.forgetDeletedKeys.mock.invocationCallOrder[0]!,
      );
    },
  );

  it('writes a media_force_delete audit row naming the actor before a forced delete', async () => {
    const { service, storage, modAudit } = await makeService();

    await service.delete(avatarKey, actorId, true);

    expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
      null,
      actorId,
      'media_force_delete',
      undefined,
      avatarKey,
    );
    expect(storage.deleteObjectByKey).toHaveBeenCalledWith(avatarKey);
    expect(modAudit.writeAuditLog.mock.invocationCallOrder[0]!).toBeLessThan(
      storage.deleteObjectByKey.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps the object when the audit row cannot be written', async () => {
    const { service, storage, modAudit } = await makeService();
    modAudit.writeAuditLog.mockRejectedValueOnce(new Error('db down'));

    await expect(service.delete(avatarKey, actorId, true)).rejects.toThrow(
      'db down',
    );
    expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
  });

  it('writes no audit row for an unforced delete of an unreferenced object', async () => {
    const { service, storage, modAudit } = await makeService();

    await service.delete(avatarKey, actorId, false);

    expect(storage.deleteObjectByKey).toHaveBeenCalledWith(avatarKey);
    expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    '404s a private message key (force=%s) and deletes nothing',
    async (force) => {
      const { service, storage, modAudit, references } = await makeService();

      await expect(
        service.delete(messageImageKey, actorId, force),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(references.resolve).not.toHaveBeenCalled();
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
      expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
    },
  );
});
