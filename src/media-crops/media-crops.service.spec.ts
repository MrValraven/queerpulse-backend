import type { FindOperator, Repository } from 'typeorm';
import { MediaCropService } from './media-crops.service';
import type { MediaCrop } from './entities/media-crop.entity';
import type { CropRect } from './crop-rect';

/** The bare shape this fake repo stores. `storageKey` is always present;
 *  `ownerId`/`crop` are optional so a test can seed a row that has never
 *  been through `save` (see "removes the row when the crop is identity"). */
type MediaCropRow = Pick<MediaCrop, 'storageKey'> &
  Partial<Pick<MediaCrop, 'ownerId' | 'crop'>>;

/** Bare `jest.Mock` fields (not `jest.Mocked<Repository<...>>`): the real
 *  `Repository` methods are heavily overloaded, and a `jest.fn()` with a
 *  precise, narrower implementation (below) does not structurally match any
 *  single overload. Matches the `MockRepo`-style convention used elsewhere
 *  in this repo (e.g. `admin-overview.service.spec.ts`). */
interface FakeMediaCropRepoShape {
  save: jest.Mock;
  delete: jest.Mock;
  find: jest.Mock;
}

/** Only what `MediaCropService.getMany` actually passes to `repository.find`:
 *  `{ where: { storageKey: In(bareKeys) } }`. */
interface FakeFindOptions {
  where: { storageKey: FindOperator<string[]> };
}

function fakeRepo() {
  const rows = new Map<string, MediaCropRow>();
  const repo: FakeMediaCropRepoShape = {
    save: jest.fn(
      async (row: Pick<MediaCrop, 'storageKey' | 'ownerId' | 'crop'>) => {
        rows.set(row.storageKey, row);
        return row;
      },
    ),
    delete: jest.fn(async (key: string) => {
      rows.delete(key);
      return { affected: 1, raw: [] };
    }),
    find: jest.fn(async (opts: FakeFindOptions) => {
      const keys = opts.where.storageKey.value;
      return [...rows.values()].filter((row) => keys.includes(row.storageKey));
    }),
  };
  return { ...repo, rows };
}

const crop: CropRect = {
  x: 0.1,
  y: 0.1,
  width: 0.5,
  height: 0.5,
  aspect: '1:1',
};

describe('MediaCropService', () => {
  it('upserts a crop for a bare key', async () => {
    const repo = fakeRepo();
    const service = new MediaCropService(
      repo as unknown as Repository<MediaCrop>,
    );
    await service.upsert('avatars/owner-1/pic.jpg', 'owner-1', crop);
    expect(repo.rows.get('avatars/owner-1/pic.jpg')!.crop).toEqual(crop);
  });

  it('removes the row when the crop is identity', async () => {
    const repo = fakeRepo();
    const service = new MediaCropService(
      repo as unknown as Repository<MediaCrop>,
    );
    repo.rows.set('avatars/owner-1/pic.jpg', {
      storageKey: 'avatars/owner-1/pic.jpg',
    });
    await service.upsert('avatars/owner-1/pic.jpg', 'owner-1', {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      aspect: 'free',
    });
    expect(repo.rows.has('avatars/owner-1/pic.jpg')).toBe(false);
  });

  it('getMany returns a map keyed by bare key', async () => {
    const repo = fakeRepo();
    const service = new MediaCropService(
      repo as unknown as Repository<MediaCrop>,
    );
    await service.upsert('avatars/owner-1/pic.jpg', 'owner-1', crop);
    const map = await service.getMany([
      'avatars/owner-1/pic.jpg',
      'missing/key.jpg',
    ]);
    expect(map.get('avatars/owner-1/pic.jpg')).toEqual(crop);
    expect(map.has('missing/key.jpg')).toBe(false);
  });
});
