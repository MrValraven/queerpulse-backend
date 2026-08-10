import { Test } from '@nestjs/testing';
import { MyMediaService } from './my-media.service';
import { StorageService } from '../storage/storage.service';

describe('MyMediaService.listMine', () => {
  const userId = '11111111-1111-1111-1111-111111111111';

  function makeService(listObjects: jest.Mock) {
    return Test.createTestingModule({
      providers: [
        MyMediaService,
        { provide: StorageService, useValue: { listObjects } },
        {
          provide: 'MY_MEDIA_USAGE_RESOLVER',
          useValue: { resolve: jest.fn().mockResolvedValue(new Map()) },
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

    const items = await service.listMine(userId);

    expect(items.map((item) => item.key)).toEqual([
      `listing-photos/${userId}/b.jpg`,
      `avatars/${userId}/a.jpg`,
    ]);
    expect(items[0].fileUrl).toBe(`/files/listing-photos/${userId}/b.jpg`);
    expect(items[0].inUse).toBe(false);
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

    const items = await service.listMine(userId);

    expect(items.map((item) => item.key)).toEqual([
      `avatars/${userId}/p1.jpg`,
      `avatars/${userId}/p2.jpg`,
    ]);
  });
});
