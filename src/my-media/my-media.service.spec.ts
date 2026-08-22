import { Test } from '@nestjs/testing';
import {
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MyMediaService } from './my-media.service';
import { StorageService } from '../storage/storage.service';
import { MediaReferenceResolver } from '../media-references/media-reference.resolver';
import { MediaReference } from '../media-references/media-reference.types';

describe('MyMediaService.listMine', () => {
  const userId = '11111111-1111-1111-1111-111111111111';

  function makeService(
    listObjects: jest.Mock,
    resolveReferences: jest.Mock = jest.fn().mockResolvedValue({
      references: new Map<string, MediaReference[]>(),
      degraded: false,
    }),
  ) {
    return Test.createTestingModule({
      providers: [
        MyMediaService,
        { provide: StorageService, useValue: { listObjects } },
        {
          provide: MediaReferenceResolver,
          useValue: { resolve: resolveReferences },
        },
      ],
    }).compile();
  }

  it('lists every upload kind under the caller-scoped prefix and sorts newest-first', async () => {
    const listObjects = jest.fn().mockImplementation(({ prefix }) => {
      if (prefix === `avatars/${userId}/`) {
        return Promise.resolve({
          objects: [
            {
              key: `avatars/${userId}/a.jpg`,
              size: 10,
              lastModified: '2026-01-01T00:00:00.000Z',
            },
          ],
          nextContinuationToken: null,
        });
      }
      if (prefix === `listing-photos/${userId}/`) {
        return Promise.resolve({
          objects: [
            {
              key: `listing-photos/${userId}/b.jpg`,
              size: 20,
              lastModified: '2026-02-01T00:00:00.000Z',
            },
          ],
          nextContinuationToken: null,
        });
      }
      return Promise.resolve({ objects: [], nextContinuationToken: null });
    });
    const moduleRef = await makeService(listObjects);
    const service = moduleRef.get(MyMediaService);

    const { items, degraded } = await service.listMine(userId);

    expect(items.map((item) => item.key)).toEqual([
      `listing-photos/${userId}/b.jpg`,
      `avatars/${userId}/a.jpg`,
    ]);
    expect(items[0]!.fileUrl).toBe(`/files/listing-photos/${userId}/b.jpg`);
    expect(items[0]!.references).toEqual([]);
    expect(degraded).toBe(false);
  });

  it('surfaces the resolver degraded flag so callers can suppress safe-to-delete', async () => {
    const listObjects = jest.fn().mockImplementation(({ prefix }) => {
      if (prefix === `avatars/${userId}/`) {
        return Promise.resolve({
          objects: [
            {
              key: `avatars/${userId}/a.jpg`,
              size: 10,
              lastModified: '2026-01-01T00:00:00.000Z',
            },
          ],
          nextContinuationToken: null,
        });
      }
      return Promise.resolve({ objects: [], nextContinuationToken: null });
    });
    const resolveReferences = jest.fn().mockResolvedValue({
      references: new Map<string, MediaReference[]>(),
      degraded: true,
    });
    const moduleRef = await makeService(listObjects, resolveReferences);
    const service = moduleRef.get(MyMediaService);

    const { items, degraded } = await service.listMine(userId);

    expect(degraded).toBe(true);
    // The item still lists no references — degraded means that "empty" is
    // unverified, not confirmed-orphan.
    expect(items[0]!.references).toEqual([]);
  });

  it('attaches every resolved reference to its matching item', async () => {
    const listObjects = jest.fn().mockImplementation(({ prefix }) => {
      if (prefix === `avatars/${userId}/`) {
        return Promise.resolve({
          objects: [
            {
              key: `avatars/${userId}/a.jpg`,
              size: 10,
              lastModified: '2026-01-01T00:00:00.000Z',
            },
          ],
          nextContinuationToken: null,
        });
      }
      return Promise.resolve({ objects: [], nextContinuationToken: null });
    });
    const reference: MediaReference = {
      type: 'profile-photo',
      entityId: userId,
      label: 'Jamie Doe',
      slug: 'jamie-doe',
    };
    const resolveReferences = jest.fn().mockResolvedValue({
      references: new Map<string, MediaReference[]>([
        [`avatars/${userId}/a.jpg`, [reference]],
      ]),
      degraded: false,
    });
    const moduleRef = await makeService(listObjects, resolveReferences);
    const service = moduleRef.get(MyMediaService);

    const { items } = await service.listMine(userId);

    expect(resolveReferences).toHaveBeenCalledWith([`avatars/${userId}/a.jpg`]);
    expect(items[0]!.references).toEqual([reference]);
  });

  it('follows the S3 continuation token within a kind', async () => {
    const pages = [
      {
        objects: [
          {
            key: `avatars/${userId}/p1.jpg`,
            size: 1,
            lastModified: '2026-01-02T00:00:00.000Z',
          },
        ],
        nextContinuationToken: 'TOKEN',
      },
      {
        objects: [
          {
            key: `avatars/${userId}/p2.jpg`,
            size: 1,
            lastModified: '2026-01-01T00:00:00.000Z',
          },
        ],
        nextContinuationToken: null,
      },
    ];
    const listObjects = jest
      .fn()
      .mockImplementation(({ prefix, continuationToken }) => {
        if (prefix !== `avatars/${userId}/`)
          return Promise.resolve({ objects: [], nextContinuationToken: null });
        return Promise.resolve(
          continuationToken === 'TOKEN' ? pages[1] : pages[0],
        );
      });
    const moduleRef = await makeService(listObjects);
    const service = moduleRef.get(MyMediaService);

    const { items } = await service.listMine(userId);

    expect(items.map((item) => item.key)).toEqual([
      `avatars/${userId}/p1.jpg`,
      `avatars/${userId}/p2.jpg`,
    ]);
  });
});

describe('MyMediaService.deleteMine', () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  const otherId = '22222222-2222-2222-2222-222222222222';
  const FILE = '66666666-7777-8888-9999-000000000000';
  const ownKey = `avatars/${userId}/${FILE}.jpg`;
  const foreignKey = `avatars/${otherId}/${FILE}.jpg`;

  const unreferenced = () =>
    jest.fn().mockResolvedValue({
      references: new Map<string, MediaReference[]>(),
      degraded: false,
    });

  function makeService(
    deleteObjectByReference: jest.Mock,
    resolveReferences: jest.Mock = unreferenced(),
  ) {
    return Test.createTestingModule({
      providers: [
        MyMediaService,
        {
          provide: StorageService,
          useValue: { listObjects: jest.fn(), deleteObjectByReference },
        },
        {
          provide: MediaReferenceResolver,
          useValue: { resolve: resolveReferences },
        },
      ],
    }).compile();
  }

  it('deletes an object the caller owns that nothing references', async () => {
    const deleteObjectByReference = jest.fn().mockResolvedValue(true);
    const service = (await makeService(deleteObjectByReference)).get(
      MyMediaService,
    );
    await service.deleteMine(userId, ownKey);
    expect(deleteObjectByReference).toHaveBeenCalledWith(ownKey);
  });

  it('refuses a key owned by someone else', async () => {
    const deleteObjectByReference = jest.fn();
    const service = (await makeService(deleteObjectByReference)).get(
      MyMediaService,
    );
    await expect(service.deleteMine(userId, foreignKey)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(deleteObjectByReference).not.toHaveBeenCalled();
  });

  it('refuses a malformed key', async () => {
    const deleteObjectByReference = jest.fn();
    const service = (await makeService(deleteObjectByReference)).get(
      MyMediaService,
    );
    await expect(
      service.deleteMine(userId, '../../etc/passwd'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(deleteObjectByReference).not.toHaveBeenCalled();
  });

  it('refuses to delete an object that is still referenced, and names where', async () => {
    const deleteObjectByReference = jest.fn();
    const reference: MediaReference = {
      type: 'community-cover',
      entityId: '33333333-3333-3333-3333-333333333333',
      label: 'Trans Joy Lisbon',
      slug: 'trans-joy-lisbon',
    };
    const resolveReferences = jest.fn().mockResolvedValue({
      references: new Map<string, MediaReference[]>([[ownKey, [reference]]]),
      degraded: false,
    });
    const service = (
      await makeService(deleteObjectByReference, resolveReferences)
    ).get(MyMediaService);

    await expect(service.deleteMine(userId, ownKey)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(deleteObjectByReference).not.toHaveBeenCalled();
  });

  it('refuses to delete when reference checking is degraded', async () => {
    // "No references" is not authoritative while a source query is failing, and
    // a bucket delete cannot be undone — so this fails closed.
    const deleteObjectByReference = jest.fn();
    const resolveReferences = jest.fn().mockResolvedValue({
      references: new Map<string, MediaReference[]>(),
      degraded: true,
    });
    const service = (
      await makeService(deleteObjectByReference, resolveReferences)
    ).get(MyMediaService);

    await expect(service.deleteMine(userId, ownKey)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(deleteObjectByReference).not.toHaveBeenCalled();
  });

  it('never resolves references for a key the caller does not own', async () => {
    const deleteObjectByReference = jest.fn();
    const resolveReferences = unreferenced();
    const service = (
      await makeService(deleteObjectByReference, resolveReferences)
    ).get(MyMediaService);

    await expect(service.deleteMine(userId, foreignKey)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(resolveReferences).not.toHaveBeenCalled();
  });
});
