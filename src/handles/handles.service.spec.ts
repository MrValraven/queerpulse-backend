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
    delete: (
      _entity: unknown,
      where: { name: string },
    ): Promise<{ affected: number }> => {
      const existed = rows.delete(where.name);
      return Promise.resolve({ affected: existed ? 1 : 0 });
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

    await service.rename(manager, 'old-name', 'new-name', profileOwner('user-1'));

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
    await service.rename(manager, 'same-name', 'Same-Name', profileOwner('user-1'));
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
