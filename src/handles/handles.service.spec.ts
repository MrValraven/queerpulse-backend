import { ConflictException } from '@nestjs/common';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { Handle, HandleOwnerKind } from './entities/handle.entity';
import { HandleOwner, HandlesService } from './handles.service';

// --- in-memory fake registry -------------------------------------------------
// A tiny stand-in for the `handles` table + the slice of EntityManager the
// service touches (create/insert/delete/findOne). `insert` throws a 23505
// QueryFailedError on a PK collision, exactly like Postgres, so we can assert
// the ConflictException path without a database.

function uniqueViolation(): QueryFailedError {
  const err = new QueryFailedError('insert', [], new Error('duplicate key'));
  (err as unknown as { driverError: { code: string } }).driverError = {
    code: '23505',
  };
  return err;
}

function makeManager(rows: Map<string, Handle> = new Map()): EntityManager {
  const manager = {
    create: (_entity: unknown, data: Partial<Handle>): Handle =>
      ({ ...data }) as Handle,
    insert: (_entity: unknown, data: Partial<Handle>): Promise<void> => {
      const name = data.name as string;
      if (rows.has(name)) {
        return Promise.reject(uniqueViolation());
      }
      rows.set(name, { ...(data as Handle), createdAt: new Date() });
      return Promise.resolve();
    },
    // Matches EVERY field of the where clause, not just `name` — owner-scoped
    // deletes pass ownerKind/userId too, and a fake that ignored them would
    // report a cross-owner delete as succeeding.
    delete: (
      _entity: unknown,
      where: Partial<Handle>,
    ): Promise<{ affected: number }> => {
      const row = rows.get(where.name as string);
      const matches =
        row !== undefined &&
        (Object.entries(where) as [keyof Handle, unknown][]).every(
          ([key, value]) => row[key] === value,
        );
      if (!matches) {
        return Promise.resolve({ affected: 0 });
      }
      rows.delete(where.name as string);
      return Promise.resolve({ affected: 1 });
    },
    findOne: (
      _entity: unknown,
      opts: { where: { name: string } },
    ): Promise<Handle | null> =>
      Promise.resolve(rows.get(opts.where.name) ?? null),
  };
  return manager as unknown as EntityManager;
}

function makeService(rows: Map<string, Handle> = new Map()): {
  service: HandlesService;
  manager: EntityManager;
  rows: Map<string, Handle>;
} {
  const manager = makeManager(rows);
  // check() reaches through `this.handles.manager`.
  const repo = { manager } as unknown as Repository<Handle>;
  return { service: new HandlesService(repo), manager, rows };
}

const profileOwner = (userId: string): HandleOwner => ({
  kind: 'profile',
  userId,
});
const subprofileOwner = (subprofileId: string): HandleOwner => ({
  kind: 'subprofile',
  subprofileId,
});

function seedProfile(rows: Map<string, Handle>, name: string, userId: string) {
  rows.set(name, {
    name,
    ownerKind: HandleOwnerKind.Profile,
    userId,
    subprofileId: null,
    createdAt: new Date(),
  } as Handle);
}

// --- check() -----------------------------------------------------------------

describe('HandlesService.check', () => {
  it('returns invalid for a malformed handle without a DB hit', async () => {
    const { service } = makeService();
    await expect(service.check('A_B')).resolves.toEqual({
      available: false,
      reason: 'invalid',
    });
    await expect(service.check('ab')).resolves.toEqual({
      available: false,
      reason: 'invalid',
    });
  });

  it('returns reserved for a reserved handle', async () => {
    const { service } = makeService();
    await expect(service.check('admin')).resolves.toEqual({
      available: false,
      reason: 'reserved',
    });
  });

  it('returns taken when the name is already in the registry', async () => {
    const rows = new Map<string, Handle>();
    seedProfile(rows, 'nightform', 'user-1');
    const { service } = makeService(rows);
    await expect(service.check('Nightform')).resolves.toEqual({
      available: false,
      reason: 'taken',
    });
  });

  it('returns available for a well-formed, unclaimed name', async () => {
    const { service } = makeService();
    await expect(service.check('  Aurora  ')).resolves.toEqual({
      available: true,
      reason: null,
    });
  });
});

// --- claim() -----------------------------------------------------------------

describe('HandlesService.claim', () => {
  it('inserts a normalized profile row', async () => {
    const { service, manager, rows } = makeService();
    await service.claim(manager, '  Aurora ', profileOwner('user-1'));
    expect(rows.get('aurora')).toMatchObject({
      name: 'aurora',
      ownerKind: HandleOwnerKind.Profile,
      userId: 'user-1',
      subprofileId: null,
    });
  });

  it('throws ConflictException on a collision (23505)', async () => {
    const rows = new Map<string, Handle>();
    seedProfile(rows, 'nightform', 'user-1');
    const { service, manager } = makeService(rows);
    await expect(
      service.claim(manager, 'nightform', subprofileOwner('sp-9')),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

// --- rename() ----------------------------------------------------------------

describe('HandlesService.rename', () => {
  it('releases the old name and claims the new one', async () => {
    const rows = new Map<string, Handle>();
    seedProfile(rows, 'old-name', 'user-1');
    const { service, manager } = makeService(rows);

    await service.rename(
      manager,
      'old-name',
      'new-name',
      profileOwner('user-1'),
    );

    expect(rows.has('old-name')).toBe(false);
    expect(rows.get('new-name')).toMatchObject({
      name: 'new-name',
      userId: 'user-1',
    });
  });

  it('claims the new name when there is no old name', async () => {
    const { service, manager, rows } = makeService();
    await service.rename(manager, null, 'fresh-name', profileOwner('user-1'));
    expect(rows.get('fresh-name')).toMatchObject({ name: 'fresh-name' });
  });

  it('is a no-op when the normalized name is unchanged', async () => {
    const rows = new Map<string, Handle>();
    seedProfile(rows, 'same-name', 'user-1');
    const { service, manager } = makeService(rows);
    await service.rename(
      manager,
      'same-name',
      'Same-Name',
      profileOwner('user-1'),
    );
    expect(rows.has('same-name')).toBe(true);
  });
});

// --- isTaken() ---------------------------------------------------------------

describe('HandlesService.isTaken', () => {
  it('is false for an unclaimed name', async () => {
    const { service, manager } = makeService();
    await expect(service.isTaken(manager, 'free-name')).resolves.toBe(false);
  });

  it('is true for a name held by someone else', async () => {
    const rows = new Map<string, Handle>();
    seedProfile(rows, 'nightform', 'user-1');
    const { service, manager } = makeService(rows);
    await expect(service.isTaken(manager, 'nightform')).resolves.toBe(true);
  });

  it('is false when the only holder is the excepted owner', async () => {
    const rows = new Map<string, Handle>();
    seedProfile(rows, 'nightform', 'user-1');
    const { service, manager } = makeService(rows);
    await expect(
      service.isTaken(manager, 'Nightform', profileOwner('user-1')),
    ).resolves.toBe(false);
  });

  it('is true when the excepted owner differs from the holder', async () => {
    const rows = new Map<string, Handle>();
    seedProfile(rows, 'nightform', 'user-1');
    const { service, manager } = makeService(rows);
    await expect(
      service.isTaken(manager, 'nightform', profileOwner('user-2')),
    ).resolves.toBe(true);
    await expect(
      service.isTaken(manager, 'nightform', subprofileOwner('sp-1')),
    ).resolves.toBe(true);
  });
});

// --- release() ownership scoping ---------------------------------------------

describe('HandlesService.release ownership scoping', () => {
  it('deletes the row when the owner matches', async () => {
    const rows = new Map<string, Handle>();
    seedProfile(rows, 'nightform', 'user-1');
    const { service, manager } = makeService(rows);

    await service.release(manager, 'nightform', profileOwner('user-1'));

    expect(rows.has('nightform')).toBe(false);
  });

  it('leaves a row owned by someone else alone', async () => {
    const rows = new Map<string, Handle>();
    seedProfile(rows, 'nightform', 'user-1');
    const { service, manager } = makeService(rows);

    await service.release(manager, 'nightform', profileOwner('user-2'));

    expect(rows.has('nightform')).toBe(true);
  });

  it('does not let a profile release a subprofile-owned name', async () => {
    const rows = new Map<string, Handle>();
    rows.set('nightform', {
      name: 'nightform',
      ownerKind: HandleOwnerKind.Subprofile,
      userId: null,
      subprofileId: 'sp-1',
      createdAt: new Date(),
    } as Handle);
    const { service, manager } = makeService(rows);

    await service.release(manager, 'nightform', profileOwner('user-1'));

    expect(rows.has('nightform')).toBe(true);
  });

  // The reason release() is owner-scoped at all. `profiles.slug` is only
  // case-SENSITIVELY unique, so `John` and `john` can both be live profiles
  // while the registry holds a single lowercase `john` row. Renaming the one
  // that does NOT own that row must not free the other's still-live username.
  it('does not free a case-folded name owned by a different profile', async () => {
    const rows = new Map<string, Handle>();
    seedProfile(rows, 'john', 'user-1'); // owned by the profile slugged `john`

    const { service, manager } = makeService(rows);

    // user-2, slugged `John`, renames away. normalizeHandle('John') === 'john'.
    await service.rename(manager, 'John', 'jonathan', profileOwner('user-2'));

    expect(rows.get('john')).toMatchObject({ userId: 'user-1' });
    expect(rows.get('jonathan')).toMatchObject({ userId: 'user-2' });
  });
});
