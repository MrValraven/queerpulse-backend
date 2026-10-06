import type { EntityManager, Repository } from 'typeorm';
import { SubprofileLinkVisibility } from '../subprofiles/entities/subprofile.entity';
import { PersonaStorageKey } from './entities/persona-storage-key.entity';
import { PersonaImageKeysService } from './persona-image-keys.service';
import { storageKeyOwnerId } from './storage-key';
import { StorageService } from './storage.service';

const PERSONA_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_PERSONA_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER_ID = '11111111-2222-4333-8444-555555555555';
const CO_OWNER_ID = '22222222-3333-4444-8555-666666666666';
const FILE_A = '66666666-7777-4888-9999-000000000001';
const FILE_B = '66666666-7777-4888-9999-000000000002';
const FILE_C = '66666666-7777-4888-9999-000000000003';
const FILE_D = '66666666-7777-4888-9999-000000000004';

const AVATAR_KEY = `avatars/${OWNER_ID}/${FILE_A}.jpg`;
const COVER_KEY = `persona-covers/${CO_OWNER_ID}/${FILE_B}.png`;
const ITEM_KEY = `work/${OWNER_ID}/${FILE_C}.webp`;
const FEED_ART_KEY = `work/${OWNER_ID}/${FILE_D}.png`;
/** A persona-scoped key registered to PERSONA_ID. */
const OWN_PERSONA_KEY = `persona/${FILE_A}/${FILE_B}.jpg`;
/** A persona-scoped key registered to OTHER_PERSONA_ID. */
const OTHER_PERSONA_KEY = `persona/${FILE_C}/${FILE_D}.png`;

/** The key `copyObjectToPersonaScope` mints on its `index`-th call. */
function mintedKey(index: number): string {
  return `persona/${FILE_D}/00000000-0000-4000-8000-${String(index).padStart(12, '0')}.jpg`;
}

const registryRow = (
  storageKey: string,
  subprofileId: string,
  uploadedById: string | null,
): Partial<PersonaStorageKey> => ({
  storageKey,
  subprofileId,
  uploadedById,
  uploadKind: 'avatar',
});

describe('PersonaImageKeysService (T17)', () => {
  let storage: {
    copyObjectToPersonaScope: jest.Mock;
    describeObject: jest.Mock;
    deleteObjectByKey: jest.Mock;
  };
  let registry: {
    findOne: jest.Mock;
    find: jest.Mock;
    query: jest.Mock;
    delete: jest.Mock;
  };
  let manager: { insert: jest.Mock; query: jest.Mock; find: jest.Mock };
  let service: PersonaImageKeysService;

  beforeEach(() => {
    let copies = 0;
    storage = {
      copyObjectToPersonaScope: jest.fn(() => {
        copies += 1;
        return Promise.resolve(mintedKey(copies));
      }),
      describeObject: jest.fn(),
      deleteObjectByKey: jest.fn().mockResolvedValue(undefined),
    };
    registry = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      query: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    manager = {
      insert: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([]),
      // The registry read for persona-scoped values.
      find: jest
        .fn()
        .mockResolvedValue([
          registryRow(OWN_PERSONA_KEY, PERSONA_ID, CO_OWNER_ID),
          registryRow(OTHER_PERSONA_KEY, OTHER_PERSONA_ID, OWNER_ID),
        ]),
    };
    service = new PersonaImageKeysService(
      storage as unknown as StorageService,
      registry as unknown as Repository<PersonaStorageKey>,
    );
  });

  const asManager = () => manager as unknown as EntityManager;

  describe('rehomeKeys', () => {
    it('copies each member-scoped key once to a key with no user id, registered with its uploader and kind', async () => {
      const rehomed = await service.rehomeKeys(asManager(), PERSONA_ID, [
        AVATAR_KEY,
        `/files/${COVER_KEY}`,
        AVATAR_KEY,
      ]);

      expect(storage.copyObjectToPersonaScope).toHaveBeenCalledTimes(2);
      expect(storage.copyObjectToPersonaScope).toHaveBeenCalledWith(
        AVATAR_KEY,
        { allowsPersonaScopedSource: false },
      );
      for (const freshKey of rehomed.values()) {
        expect(freshKey).toMatch(/^persona\//);
        expect(freshKey).not.toContain(OWNER_ID);
        expect(freshKey).not.toContain(CO_OWNER_ID);
        expect(storageKeyOwnerId(freshKey ?? '')).toBeNull();
      }
      expect(manager.insert).toHaveBeenCalledWith(PersonaStorageKey, {
        storageKey: mintedKey(1),
        subprofileId: PERSONA_ID,
        uploadedById: OWNER_ID,
        uploadKind: 'avatar',
      });
      expect(manager.insert).toHaveBeenCalledWith(PersonaStorageKey, {
        storageKey: mintedKey(2),
        subprofileId: PERSONA_ID,
        uploadedById: CO_OWNER_ID,
        uploadKind: 'persona-cover',
      });
    });

    it('carries a saved crop over to the new key', async () => {
      await service.rehomeKeys(asManager(), PERSONA_ID, [ITEM_KEY]);

      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "media_crops"'),
        [mintedKey(1), ITEM_KEY],
      );
    });

    it("keeps this persona's own persona-scoped key, external URLs and empty values", async () => {
      const rehomed = await service.rehomeKeys(asManager(), PERSONA_ID, [
        OWN_PERSONA_KEY,
        'https://images.example/photo.jpg',
        null,
        undefined,
        '',
      ]);

      expect(rehomed.size).toBe(0);
      expect(storage.copyObjectToPersonaScope).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
    });

    // Copying your own unlinked persona: the copy never shares a key with
    // the persona it came from.
    it("copies another persona's key to a fresh one, keeping that key's uploader and kind", async () => {
      const rehomed = await service.rehomeKeys(asManager(), PERSONA_ID, [
        OTHER_PERSONA_KEY,
      ]);

      expect(storage.copyObjectToPersonaScope).toHaveBeenCalledWith(
        OTHER_PERSONA_KEY,
        { allowsPersonaScopedSource: true },
      );
      expect(rehomed.get(OTHER_PERSONA_KEY)).toBe(mintedKey(1));
      expect(rehomed.get(OTHER_PERSONA_KEY)).not.toBe(OTHER_PERSONA_KEY);
      expect(manager.insert).toHaveBeenCalledWith(PersonaStorageKey, {
        storageKey: mintedKey(1),
        subprofileId: PERSONA_ID,
        uploadedById: OWNER_ID,
        uploadKind: 'avatar',
      });
    });

    it("copy-all gives this persona's own key a fresh one too, except the kept values", async () => {
      const rehomed = await service.rehomeKeys(
        asManager(),
        PERSONA_ID,
        [OWN_PERSONA_KEY, OTHER_PERSONA_KEY],
        { personaScopedMode: 'copy-all', keepValues: [OTHER_PERSONA_KEY] },
      );

      expect([...rehomed.keys()]).toEqual([OWN_PERSONA_KEY]);
      expect(rehomed.get(OWN_PERSONA_KEY)).not.toBe(OWN_PERSONA_KEY);
      expect(manager.insert).toHaveBeenCalledWith(PersonaStorageKey, {
        storageKey: mintedKey(1),
        subprofileId: PERSONA_ID,
        uploadedById: CO_OWNER_ID,
        uploadKind: 'avatar',
      });
    });

    it('leaves member-scoped keys alone when asked to (a linked persona)', async () => {
      const rehomed = await service.rehomeKeys(
        asManager(),
        PERSONA_ID,
        [AVATAR_KEY, OTHER_PERSONA_KEY],
        { shouldCopyMemberScoped: false },
      );

      expect([...rehomed.keys()]).toEqual([OTHER_PERSONA_KEY]);
    });

    it('clears a reference whose object is gone, so the user id goes with it', async () => {
      storage.copyObjectToPersonaScope.mockRejectedValueOnce(
        Object.assign(new Error('missing'), { name: 'NoSuchKey' }),
      );

      const rehomed = await service.rehomeKeys(asManager(), PERSONA_ID, [
        AVATAR_KEY,
      ]);

      expect(rehomed.get(AVATAR_KEY)).toBeNull();
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('fails on any other bucket error, so the write is retried', async () => {
      storage.copyObjectToPersonaScope.mockRejectedValueOnce(
        new Error('network down'),
      );

      await expect(
        service.rehomeKeys(asManager(), PERSONA_ID, [AVATAR_KEY]),
      ).rejects.toThrow('network down');
    });
  });

  describe('rehomeForPersonaWrite', () => {
    it('re-homes member uploads for an unlinked persona, read through the transaction', async () => {
      manager.query.mockResolvedValueOnce([
        { link_visibility: SubprofileLinkVisibility.Unlinked },
      ]);

      const rehomed = await service.rehomeForPersonaWrite(
        asManager(),
        PERSONA_ID,
        [ITEM_KEY],
      );

      expect(manager.query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('"link_visibility"'),
        [PERSONA_ID],
      );
      expect(rehomed.get(ITEM_KEY)).toBe(mintedKey(1));
    });

    it("keeps member uploads on a linked persona, and still copies another persona's key", async () => {
      manager.query.mockResolvedValueOnce([
        { link_visibility: SubprofileLinkVisibility.Linked },
      ]);

      const rehomed = await service.rehomeForPersonaWrite(
        asManager(),
        PERSONA_ID,
        [ITEM_KEY, OTHER_PERSONA_KEY],
      );

      expect([...rehomed.keys()]).toEqual([OTHER_PERSONA_KEY]);
    });

    it('skips the read when no value is a storage key', async () => {
      await service.rehomeForPersonaWrite(asManager(), PERSONA_ID, [
        'https://images.example/photo.jpg',
        null,
      ]);

      expect(manager.query).not.toHaveBeenCalled();
    });
  });

  describe('rehomeUnlinkedPersona', () => {
    const stageReferences = () => {
      manager.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM "subprofile_items"')) {
          return Promise.resolve([{ image_url: ITEM_KEY }]);
        }
        if (sql.includes('FROM "subprofile_feeds"')) {
          return Promise.resolve([{ image_key: FEED_ART_KEY }]);
        }
        return Promise.resolve([]);
      });
    };

    it('re-homes the avatar, cover, item images and feed art, and rewrites every reference', async () => {
      stageReferences();
      const persona = {
        id: PERSONA_ID,
        avatarUrl: AVATAR_KEY,
        coverUrl: COVER_KEY,
      };

      const rehomed = await service.rehomeUnlinkedPersona(
        asManager(),
        persona,
        'unlink',
      );

      expect(rehomed.size).toBe(4);
      expect(persona.avatarUrl).toBe(rehomed.get(AVATAR_KEY));
      expect(persona.coverUrl).toBe(rehomed.get(COVER_KEY));
      expect(persona.avatarUrl).not.toContain(OWNER_ID);
      expect(persona.coverUrl).not.toContain(CO_OWNER_ID);

      const statements = manager.query.mock.calls.map(
        ([sql, parameters]: [string, unknown[]]) => ({ sql, parameters }),
      );
      expect(statements).toContainEqual({
        sql: expect.stringContaining('UPDATE "subprofiles"') as unknown,
        parameters: [PERSONA_ID, persona.avatarUrl, persona.coverUrl],
      });
      expect(statements).toContainEqual({
        sql: expect.stringContaining('UPDATE "subprofile_items"') as unknown,
        parameters: [PERSONA_ID, ITEM_KEY, rehomed.get(ITEM_KEY)],
      });
      expect(statements).toContainEqual({
        sql: expect.stringContaining('UPDATE "subprofile_feeds"') as unknown,
        parameters: [PERSONA_ID, FEED_ART_KEY, rehomed.get(FEED_ART_KEY)],
      });
      // Revisions are re-homed lazily, on restore.
      expect(
        statements.some(({ sql }) =>
          sql.includes('UPDATE "subprofile_item_revisions"'),
        ),
      ).toBe(false);
    });

    // Linked, then unlinked, then linked and unlinked again: the second
    // unlink must not carry a key the persona showed while linked.
    it('gives a key the persona already holds a fresh one on unlink', async () => {
      const persona = {
        id: PERSONA_ID,
        avatarUrl: OWN_PERSONA_KEY,
        coverUrl: null,
      };

      await service.rehomeUnlinkedPersona(asManager(), persona, 'unlink');

      expect(persona.avatarUrl).toBe(mintedKey(1));
      expect(persona.avatarUrl).not.toBe(OWN_PERSONA_KEY);
      expect(storage.copyObjectToPersonaScope).toHaveBeenCalledWith(
        OWN_PERSONA_KEY,
        { allowsPersonaScopedSource: true },
      );
      // The uploader the source row recorded stays on the new row.
      expect(manager.insert).toHaveBeenCalledWith(PersonaStorageKey, {
        storageKey: mintedKey(1),
        subprofileId: PERSONA_ID,
        uploadedById: CO_OWNER_ID,
        uploadKind: 'avatar',
      });
    });

    it('backfill writes nothing when every image is already the persona own key', async () => {
      const persona = {
        id: PERSONA_ID,
        avatarUrl: OWN_PERSONA_KEY,
        coverUrl: null,
      };

      await service.rehomeUnlinkedPersona(asManager(), persona, 'backfill');

      expect(persona.avatarUrl).toBe(OWN_PERSONA_KEY);
      expect(storage.copyObjectToPersonaScope).not.toHaveBeenCalled();
      const writes = manager.query.mock.calls.filter(([sql]: [string]) =>
        sql.trimStart().startsWith('UPDATE'),
      );
      expect(writes).toEqual([]);
    });
  });

  describe('serving and membership reads', () => {
    it('reads the registry row and the uploader status in one joined query', async () => {
      registry.query.mockResolvedValueOnce([
        { uploaded_by_id: OWNER_ID, uploader_status: 'suspended' },
      ]);

      await expect(
        service.findServingRegistration(OWN_PERSONA_KEY),
      ).resolves.toEqual({
        uploadedById: OWNER_ID,
        uploaderStatus: 'suspended',
      });
      expect(registry.query).toHaveBeenCalledTimes(1);
      expect(registry.query).toHaveBeenCalledWith(
        expect.stringContaining('LEFT JOIN "users"'),
        [OWN_PERSONA_KEY],
      );
    });

    it('answers membership from the registry joined to the persona members', async () => {
      registry.query.mockResolvedValueOnce([{ '?column?': 1 }]);

      await expect(
        service.isMemberOfKeyPersona(OWN_PERSONA_KEY, CO_OWNER_ID),
      ).resolves.toBe(true);
      expect(registry.query).toHaveBeenCalledWith(
        expect.stringContaining('JOIN "subprofile_members"'),
        [OWN_PERSONA_KEY, CO_OWNER_ID],
      );
    });

    it('refuses a caller who is not a member', async () => {
      await expect(
        service.isMemberOfKeyPersona(OWN_PERSONA_KEY, CO_OWNER_ID),
      ).resolves.toBe(false);
    });
  });

  describe('listObjectsUploadedBy', () => {
    it('lists the registered keys that still exist, with size, date and kind', async () => {
      registry.find.mockResolvedValue([
        { storageKey: OWN_PERSONA_KEY, uploadKind: 'avatar' },
        { storageKey: OTHER_PERSONA_KEY, uploadKind: 'work-image' },
      ]);
      storage.describeObject.mockImplementation((key: string) =>
        Promise.resolve(
          key === OWN_PERSONA_KEY
            ? { key, size: 9, lastModified: '2026-01-01T00:00:00.000Z' }
            : null,
        ),
      );

      await expect(service.listObjectsUploadedBy(OWNER_ID)).resolves.toEqual([
        {
          key: OWN_PERSONA_KEY,
          size: 9,
          lastModified: '2026-01-01T00:00:00.000Z',
          uploadKind: 'avatar',
        },
      ]);
    });
  });

  describe('forgetDeletedKeys', () => {
    it('drops the registry rows and crops of persona-scoped keys only', async () => {
      await service.forgetDeletedKeys([OWN_PERSONA_KEY, AVATAR_KEY]);

      expect(registry.delete).toHaveBeenCalledTimes(1);
      expect(registry.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM "media_crops"'),
        [[OWN_PERSONA_KEY]],
      );
    });

    it('does nothing for a member-scoped key', async () => {
      await service.forgetDeletedKeys([AVATAR_KEY]);

      expect(registry.delete).not.toHaveBeenCalled();
      expect(registry.query).not.toHaveBeenCalled();
    });
  });
});
