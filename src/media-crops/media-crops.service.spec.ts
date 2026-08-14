import { MediaCropService } from './media-crops.service';
import type { CropRect } from './crop-rect';

function fakeRepo() {
  const rows = new Map<string, any>();
  return {
    rows,
    save: jest.fn(async (row: any) => {
      rows.set(row.storageKey, row);
      return row;
    }),
    delete: jest.fn(async (key: string) => {
      rows.delete(key);
      return { affected: 1 };
    }),
    find: jest.fn(async (opts: any) => {
      const keys: string[] =
        opts.where.storageKey._value ?? opts.where.storageKey.value ?? [];
      return [...rows.values()].filter((row) => keys.includes(row.storageKey));
    }),
  };
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
    const service = new MediaCropService(repo as any);
    await service.upsert('avatars/owner-1/pic.jpg', 'owner-1', crop);
    expect(repo.rows.get('avatars/owner-1/pic.jpg').crop).toEqual(crop);
  });

  it('removes the row when the crop is identity', async () => {
    const repo = fakeRepo();
    const service = new MediaCropService(repo as any);
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
    const service = new MediaCropService(repo as any);
    await service.upsert('avatars/owner-1/pic.jpg', 'owner-1', crop);
    const map = await service.getMany([
      'avatars/owner-1/pic.jpg',
      'missing/key.jpg',
    ]);
    expect(map.get('avatars/owner-1/pic.jpg')).toEqual(crop);
    expect(map.has('missing/key.jpg')).toBe(false);
  });
});
