import { BadRequestException, HttpException, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { ModAuditService } from '../moderation/mod-audit.service';
import { StorageService } from '../storage/storage.service';
import {
  AdminStudioLandingPhotosService,
  LOCK_PHOTO_SQL,
} from './admin-studio-landing-photos.service';
import { PutStudioLandingPhotoDto } from './dto/admin-studio-landing.dto';
import {
  resetStudioLandingMemoForTesting,
  studioLandingMemoGeneration,
} from './studio-landing-memo';

const STAFF_ID = 'a9000000-0000-4000-8000-000000000001';
const OTHER_STAFF_ID = 'a9000000-0000-4000-8000-000000000002';
const STAFF_UPLOAD_KEY = `work/${STAFF_ID}/b9000000-0000-4000-8000-000000000001.jpg`;
const OTHER_STAFF_UPLOAD_KEY = `work/${OTHER_STAFF_ID}/b9000000-0000-4000-8000-000000000002.jpg`;
const STAFF_MESSAGE_IMAGE_KEY = `message-images/${STAFF_ID}/b9000000-0000-4000-8000-000000000003.jpg`;
const OLD_LANDING_KEY =
  'studio-landing/c9000000-0000-4000-8000-000000000001/c9000000-0000-4000-8000-000000000002.jpg';
const OTHER_LANDING_KEY =
  'studio-landing/c9000000-0000-4000-8000-000000000003/c9000000-0000-4000-8000-000000000004.jpg';
const FRESH_LANDING_KEY =
  'studio-landing/c9000000-0000-4000-8000-000000000005/c9000000-0000-4000-8000-000000000006.jpg';

const BODY: PutStudioLandingPhotoDto = {
  imageKey: STAFF_UPLOAD_KEY,
  altTextEn: 'Two dancers under a disco ball',
  altTextPt: 'Duas dançarinas debaixo de uma bola de espelhos',
  credit: 'Photo by the crew',
  hasConsent: true,
};

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

describe('AdminStudioLandingPhotosService', () => {
  let commitOrder: string[];
  let storedKeyRead: string | null;
  let lockedKey: string | null;
  let dataSourceQuery: jest.Mock;
  let managerQuery: jest.Mock;
  let storage: {
    copyObjectToStudioLandingScope: jest.Mock;
    deleteObjectByKey: jest.Mock;
  };
  let modAudit: { namesForUserIds: jest.Mock };
  let service: AdminStudioLandingPhotosService;

  /** The slot holds this key now, for the unlocked read and the locked one. */
  const storedKey = (key: string | null) => {
    storedKeyRead = key;
    lockedKey = key;
  };

  beforeEach(() => {
    setImageUrlBase('https://api.example.test');
    resetStudioLandingMemoForTesting();
    commitOrder = [];
    storedKeyRead = null;
    lockedKey = null;
    dataSourceQuery = jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('ORDER BY')
          ? []
          : storedKeyRead === null
            ? []
            : [{ image_key: storedKeyRead }],
      ),
    );
    managerQuery = jest.fn((sql: string, parameters: unknown[] = []) => {
      if (sql === LOCK_PHOTO_SQL) {
        return Promise.resolve(
          lockedKey === null ? [] : [{ image_key: lockedKey }],
        );
      }
      if (sql.includes('INSERT INTO')) {
        const [slot, imageKey, altTextEn, altTextPt, credit, updatedById] =
          parameters;
        return Promise.resolve([
          {
            slot,
            image_key: imageKey,
            alt_text_en: altTextEn,
            alt_text_pt: altTextPt,
            credit,
            consented_at: new Date('2026-10-28T10:00:00.000Z'),
            updated_by_id: updatedById,
          },
        ]);
      }
      return Promise.resolve([]);
    });
    const dataSource = {
      query: dataSourceQuery,
      transaction: jest.fn(async (work: (inner: EntityManager) => unknown) => {
        const result = await work({
          query: managerQuery,
        } as unknown as EntityManager);
        commitOrder.push('commit');
        return result;
      }),
    };
    storage = {
      copyObjectToStudioLandingScope: jest.fn(() => {
        commitOrder.push('copy');
        return Promise.resolve(FRESH_LANDING_KEY);
      }),
      deleteObjectByKey: jest.fn(() => {
        commitOrder.push('delete');
        return Promise.resolve();
      }),
    };
    modAudit = {
      namesForUserIds: jest.fn((userIds: string[]) =>
        Promise.resolve(new Map(userIds.map((id) => [id, 'Staff Sam']))),
      ),
    };
    service = new AdminStudioLandingPhotosService(
      dataSource as unknown as DataSource,
      storage as unknown as StorageService,
      modAudit as unknown as ModAuditService,
    );
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
    resetStudioLandingMemoForTesting();
  });

  describe('putPhoto', () => {
    it('refuses a save without consent before copying', async () => {
      await expect(
        service.putPhoto(STAFF_ID, 'hero', { ...BODY, hasConsent: false }),
      ).rejects.toMatchObject({
        response: { code: 'studio_landing_consent_required' },
      });
      expect(storage.copyObjectToStudioLandingScope).not.toHaveBeenCalled();
      expect(managerQuery).not.toHaveBeenCalled();
    });

    it.each([
      ['a landing key the slot does not hold', OTHER_LANDING_KEY],
      ['an https URL', 'https://images.example/photo.jpg'],
      ["another staff member's upload", OTHER_STAFF_UPLOAD_KEY],
      ["the staff member's own message image", STAFF_MESSAGE_IMAGE_KEY],
    ])(
      'refuses %s with studio_landing_photo_not_yours',
      async (_label, key) => {
        storedKey(OLD_LANDING_KEY);
        expect(
          await codeOf(
            service.putPhoto(STAFF_ID, 'hero', { ...BODY, imageKey: key }),
          ),
        ).toBe('studio_landing_photo_not_yours');
        expect(storage.copyObjectToStudioLandingScope).not.toHaveBeenCalled();
        expect(managerQuery).not.toHaveBeenCalled();
        expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
      },
    );

    it("refuses the hero slot's current landing key saved into the manifesto slot", async () => {
      dataSourceQuery.mockImplementation(
        (_sql: string, parameters: unknown[]) =>
          Promise.resolve(
            parameters[0] === 'hero' ? [{ image_key: OLD_LANDING_KEY }] : [],
          ),
      );

      expect(
        await codeOf(
          service.putPhoto(STAFF_ID, 'manifesto', {
            ...BODY,
            imageKey: OLD_LANDING_KEY,
          }),
        ),
      ).toBe('studio_landing_photo_not_yours');
      expect(managerQuery).not.toHaveBeenCalled();
      expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
    });

    it('copies the staff upload, upserts the slot and deletes the replaced copy after commit', async () => {
      storedKey(OLD_LANDING_KEY);

      const photo = await service.putPhoto(STAFF_ID, 'hero', {
        ...BODY,
        imageKey: STAFF_UPLOAD_KEY,
      });

      expect(storage.copyObjectToStudioLandingScope).toHaveBeenCalledWith(
        STAFF_UPLOAD_KEY,
      );
      expect(storage.deleteObjectByKey.mock.calls).toEqual([[OLD_LANDING_KEY]]);
      expect(commitOrder).toEqual(['copy', 'commit', 'delete']);
      const upsertCalls = managerQuery.mock.calls.filter(
        ([sql]) =>
          typeof sql === 'string' &&
          sql.includes('ON CONFLICT ("slot") DO UPDATE'),
      );
      expect(upsertCalls.map(([, parameters]) => parameters)).toEqual([
        [
          'hero',
          FRESH_LANDING_KEY,
          BODY.altTextEn,
          BODY.altTextPt,
          'Photo by the crew',
          STAFF_ID,
        ],
      ]);
      expect(photo).toEqual({
        slot: 'hero',
        imageKey: FRESH_LANDING_KEY,
        url: `https://api.example.test/files/${FRESH_LANDING_KEY}`,
        altText: { en: BODY.altTextEn, pt: BODY.altTextPt },
        credit: 'Photo by the crew',
        consentedAt: '2026-10-28T10:00:00.000Z',
        updatedBy: { id: STAFF_ID, displayName: 'Staff Sam' },
      });
    });

    it('stores an empty credit as null and deletes nothing for a first save', async () => {
      await service.putPhoto(STAFF_ID, 'manifesto', { ...BODY, credit: '  ' });

      const upsertParameters = managerQuery.mock.calls
        .filter(
          ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO'),
        )
        .map(([, parameters]) => parameters);
      expect(upsertParameters).toEqual([
        [
          'manifesto',
          FRESH_LANDING_KEY,
          BODY.altTextEn,
          BODY.altTextPt,
          null,
          STAFF_ID,
        ],
      ]);
      expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
    });

    it('keeps the stored copy when its key is sent back', async () => {
      storedKey(OLD_LANDING_KEY);

      const photo = await service.putPhoto(STAFF_ID, 'hero', {
        ...BODY,
        imageKey: OLD_LANDING_KEY,
        altTextEn: 'New alt text',
      });

      expect(storage.copyObjectToStudioLandingScope).not.toHaveBeenCalled();
      expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
      expect(photo.imageKey).toBe(OLD_LANDING_KEY);
      expect(photo.altText.en).toBe('New alt text');
    });

    it('refuses a re-sent stored key another save replaced first', async () => {
      storedKeyRead = OLD_LANDING_KEY;
      lockedKey = OTHER_LANDING_KEY;

      expect(
        await codeOf(
          service.putPhoto(STAFF_ID, 'hero', {
            ...BODY,
            imageKey: OLD_LANDING_KEY,
          }),
        ),
      ).toBe('studio_landing_photo_not_yours');

      const insertCalls = managerQuery.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO'),
      );
      expect(insertCalls).toEqual([]);
      expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
      expect(studioLandingMemoGeneration()).toBe(0);
    });

    it('discards the fresh copy when the write fails', async () => {
      storedKey(OLD_LANDING_KEY);
      managerQuery.mockImplementation((sql: string) =>
        sql === LOCK_PHOTO_SQL
          ? Promise.resolve([{ image_key: OLD_LANDING_KEY }])
          : Promise.reject(new Error('db down')),
      );

      await expect(service.putPhoto(STAFF_ID, 'hero', BODY)).rejects.toThrow(
        'db down',
      );

      expect(storage.deleteObjectByKey.mock.calls).toEqual([
        [FRESH_LANDING_KEY],
      ]);
      expect(studioLandingMemoGeneration()).toBe(0);
    });

    it('still reports the original failure when the cleanup delete also fails, and logs it', async () => {
      managerQuery.mockRejectedValue(new Error('db down'));
      storage.deleteObjectByKey.mockRejectedValue(new Error('bucket down'));
      const logSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      await expect(service.putPhoto(STAFF_ID, 'hero', BODY)).rejects.toThrow(
        'db down',
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('bucket down'),
      );
      logSpy.mockRestore();
    });

    it('keeps the save and logs when deleting the replaced copy fails', async () => {
      storedKey(OLD_LANDING_KEY);
      storage.deleteObjectByKey.mockRejectedValue(new Error('bucket down'));
      const logSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      const photo = await service.putPhoto(STAFF_ID, 'hero', BODY);

      expect(photo.imageKey).toBe(FRESH_LANDING_KEY);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('bucket down'),
      );
      logSpy.mockRestore();
    });

    it('answers a named 400 when the upload object is missing', async () => {
      storage.copyObjectToStudioLandingScope.mockRejectedValue({
        name: 'NoSuchKey',
      });

      const failure = await service
        .putPhoto(STAFF_ID, 'hero', BODY)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(BadRequestException);
      expect((failure as BadRequestException).message).toBe(
        'Photo upload not found',
      );
      expect(managerQuery).not.toHaveBeenCalled();
    });
  });

  describe('deletePhoto', () => {
    it('deletes the slot and its copy after commit', async () => {
      storedKey(OLD_LANDING_KEY);

      await service.deletePhoto('hero');

      const deleteCalls = managerQuery.mock.calls
        .filter(
          ([sql]) => typeof sql === 'string' && sql.startsWith('DELETE FROM'),
        )
        .map(([, parameters]) => parameters);
      expect(deleteCalls).toEqual([['hero']]);
      expect(storage.deleteObjectByKey.mock.calls).toEqual([[OLD_LANDING_KEY]]);
      expect(commitOrder).toEqual(['commit', 'delete']);
    });

    it('answers quietly for an empty slot', async () => {
      await expect(service.deletePhoto('manifesto')).resolves.toBeUndefined();

      expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
      expect(studioLandingMemoGeneration()).toBe(0);
    });
  });

  describe('getPhotos', () => {
    it('reads each slot, an empty one as null, with the staff name', async () => {
      dataSourceQuery.mockResolvedValue([
        {
          slot: 'manifesto',
          image_key: OLD_LANDING_KEY,
          alt_text_en: 'Alt en',
          alt_text_pt: 'Alt pt',
          credit: null,
          consented_at: new Date('2026-10-27T09:00:00.000Z'),
          updated_by_id: STAFF_ID,
        },
      ]);

      const photos = await service.getPhotos();

      expect(photos.hero).toBeNull();
      expect(photos.manifesto).toEqual({
        slot: 'manifesto',
        imageKey: OLD_LANDING_KEY,
        url: `https://api.example.test/files/${OLD_LANDING_KEY}`,
        altText: { en: 'Alt en', pt: 'Alt pt' },
        credit: null,
        consentedAt: '2026-10-27T09:00:00.000Z',
        updatedBy: { id: STAFF_ID, displayName: 'Staff Sam' },
      });
    });

    it('reads both slots as null when none is stored', async () => {
      expect(await service.getPhotos()).toEqual({
        hero: null,
        manifesto: null,
      });
    });
  });

  describe('the landing memo', () => {
    it('bumps the memo after a save and a delete', async () => {
      await service.putPhoto(STAFF_ID, 'hero', BODY);
      expect(studioLandingMemoGeneration()).toBe(1);

      storedKey(FRESH_LANDING_KEY);
      await service.deletePhoto('hero');
      expect(studioLandingMemoGeneration()).toBe(2);
    });
  });
});
