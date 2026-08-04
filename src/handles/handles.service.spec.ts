import { ConflictException } from '@nestjs/common';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { Handle, HandleOwnerKind } from './entities/handle.entity';
import { HandleHistory } from './entities/handle-history.entity';
import { HandleOwner, HandlesService } from './handles.service';

// --- in-memory fake registry -------------------------------------------------
// A tiny stand-in for the `handles` + `handle_history` tables and the slice of
// EntityManager the service touches (create/insert/delete/findOne/upsert). The
// fake is ENTITY-AWARE — it dispatches on the entity class to the right map —
// because the service now reads and writes both tables in one transaction.
//
// `findOne`/`delete` match the WHOLE where clause (not just `name`): the service
// relies on that (owner-scoped release reads the exact row it will free), and a
// fake that matched name alone would report cross-owner reads/deletes as hits.
//
// `insert` throws a 23505 QueryFailedError on a PK collision, exactly like
// Postgres, so we can assert the ConflictException path without a database.

function uniqueViolation(): QueryFailedError {
  const err = new QueryFailedError('insert', [], new Error('duplicate key'));
  (err as unknown as { driverError: { code: string } }).driverError = {
    code: '23505',
  };
  return err;
}

interface FakeStores {
  handleRows: Map<string, Handle>;
  historyRows: Map<string, HandleHistory>;
}

function matchesWhere<Row extends Record<string, unknown>>(
  row: Row,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function makeManager(stores: FakeStores): EntityManager {
  const mapFor = (entity: unknown): Map<string, { name: string }> =>
    entity === HandleHistory ? stores.historyRows : stores.handleRows;

  const manager = {
    create: (_entity: unknown, data: Partial<Handle>): Handle =>
      ({ ...data }) as Handle,
    insert: (entity: unknown, data: { name: string }): Promise<void> => {
      const rows = mapFor(entity);
      if (rows.has(data.name)) {
        return Promise.reject(uniqueViolation());
      }
      rows.set(data.name, {
        ...(data as Handle),
        createdAt: new Date(),
      } as unknown as { name: string });
      return Promise.resolve();
    },
    // Upsert-by-name — `handle_history`'s only write path (reservation on
    // release). Overwrites so the latest release wins, matching the PK upsert.
    upsert: (entity: unknown, data: { name: string }): Promise<void> => {
      mapFor(entity).set(data.name, { ...data });
      return Promise.resolve();
    },
    delete: (
      entity: unknown,
      where: { name?: string } & Record<string, unknown>,
    ): Promise<{ affected: number }> => {
      const rows = mapFor(entity);
      const row = where.name !== undefined ? rows.get(where.name) : undefined;
      if (row === undefined || !matchesWhere(row, where)) {
        return Promise.resolve({ affected: 0 });
      }
      rows.delete(where.name as string);
      return Promise.resolve({ affected: 1 });
    },
    findOne: (
      entity: unknown,
      opts: { where: { name: string } & Record<string, unknown> },
    ): Promise<unknown> => {
      const row = mapFor(entity).get(opts.where.name);
      if (row === undefined || !matchesWhere(row, opts.where)) {
        return Promise.resolve(null);
      }
      return Promise.resolve(row);
    },
  };
  return manager as unknown as EntityManager;
}

function makeService(handleRows: Map<string, Handle> = new Map()): {
  service: HandlesService;
  manager: EntityManager;
  rows: Map<string, Handle>;
  historyRows: Map<string, HandleHistory>;
} {
  const historyRows = new Map<string, HandleHistory>();
  const manager = makeManager({ handleRows, historyRows });
  // check() reaches through `this.handles.manager`.
  const repo = { manager } as unknown as Repository<Handle>;
  return {
    service: new HandlesService(repo),
    manager,
    rows: handleRows,
    historyRows,
  };
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

// Seed a reclaim reservation directly, so cooldown boundaries can be exercised
// without waiting real time. `reclaimableAt` in the future = still cooling.
function seedReservation(
  historyRows: Map<string, HandleHistory>,
  name: string,
  previousOwner: HandleOwner,
  reclaimableAt: Date,
) {
  historyRows.set(name, {
    name,
    previousOwnerKind:
      previousOwner.kind === 'profile'
        ? HandleOwnerKind.Profile
        : HandleOwnerKind.Subprofile,
    previousOwnerUserId:
      previousOwner.kind === 'profile' ? previousOwner.userId : null,
    previousOwnerSubprofileId:
      previousOwner.kind === 'subprofile' ? previousOwner.subprofileId : null,
    releasedAt: new Date(reclaimableAt.getTime() - 1000),
    reclaimableAt,
  } as HandleHistory);
}

const oneDayFromNow = () => new Date(Date.now() + 24 * 60 * 60 * 1000);
const oneDayAgo = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

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

  it('reports a cooling-down name as taken to a stranger', async () => {
    const { service, historyRows } = makeService();
    seedReservation(
      historyRows,
      'aurora',
      profileOwner('user-1'),
      oneDayFromNow(),
    );
    await expect(service.check('Aurora')).resolves.toEqual({
      available: false,
      reason: 'taken',
    });
    await expect(
      service.check('Aurora', profileOwner('user-2')),
    ).resolves.toEqual({ available: false, reason: 'taken' });
  });

  it('reports a cooling-down name as available to its previous owner', async () => {
    const { service, historyRows } = makeService();
    seedReservation(
      historyRows,
      'aurora',
      profileOwner('user-1'),
      oneDayFromNow(),
    );
    await expect(
      service.check('Aurora', profileOwner('user-1')),
    ).resolves.toEqual({ available: true, reason: null });
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

  it('refuses a stranger claiming a name still in its reclaim cooldown', async () => {
    const { service, manager, historyRows } = makeService();
    seedReservation(
      historyRows,
      'aurora',
      profileOwner('user-1'),
      oneDayFromNow(),
    );
    await expect(
      service.claim(manager, 'aurora', profileOwner('user-2')),
    ).rejects.toBeInstanceOf(ConflictException);
    // The reservation is untouched by the refused claim.
    expect(historyRows.has('aurora')).toBe(true);
  });

  it('lets the previous owner reclaim within the cooldown, clearing the reservation', async () => {
    const { service, manager, rows, historyRows } = makeService();
    seedReservation(
      historyRows,
      'aurora',
      profileOwner('user-1'),
      oneDayFromNow(),
    );
    await service.claim(manager, 'aurora', profileOwner('user-1'));
    expect(rows.get('aurora')).toMatchObject({ userId: 'user-1' });
    expect(historyRows.has('aurora')).toBe(false);
  });

  it('lets anyone claim once the cooldown has lapsed, clearing the reservation', async () => {
    const { service, manager, rows, historyRows } = makeService();
    seedReservation(historyRows, 'aurora', profileOwner('user-1'), oneDayAgo());
    await service.claim(manager, 'aurora', profileOwner('user-2'));
    expect(rows.get('aurora')).toMatchObject({ userId: 'user-2' });
    expect(historyRows.has('aurora')).toBe(false);
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

  it('reserves the released old name to its previous owner', async () => {
    const rows = new Map<string, Handle>();
    seedProfile(rows, 'old-name', 'user-1');
    const { service, manager, historyRows } = makeService(rows);

    await service.rename(
      manager,
      'old-name',
      'new-name',
      profileOwner('user-1'),
    );

    const reservation = historyRows.get('old-name');
    expect(reservation).toMatchObject({
      previousOwnerKind: HandleOwnerKind.Profile,
      previousOwnerUserId: 'user-1',
      previousOwnerSubprofileId: null,
    });
    expect(reservation!.reclaimableAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('lets the previous owner rename straight back within the cooldown', async () => {
    const rows = new Map<string, Handle>();
    seedProfile(rows, 'old-name', 'user-1');
    const { service, manager } = makeService(rows);

    await service.rename(
      manager,
      'old-name',
      'new-name',
      profileOwner('user-1'),
    );
    await service.rename(
      manager,
      'new-name',
      'old-name',
      profileOwner('user-1'),
    );

    expect(rows.get('old-name')).toMatchObject({ userId: 'user-1' });
    expect(rows.has('new-name')).toBe(false);
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

  it('treats a cooling-down name as taken for a stranger', async () => {
    const { service, manager, historyRows } = makeService();
    seedReservation(
      historyRows,
      'aurora',
      profileOwner('user-1'),
      oneDayFromNow(),
    );
    await expect(service.isTaken(manager, 'aurora')).resolves.toBe(true);
    await expect(
      service.isTaken(manager, 'aurora', profileOwner('user-2')),
    ).resolves.toBe(true);
  });

  it('treats a cooling-down name as free for its previous owner', async () => {
    const { service, manager, historyRows } = makeService();
    seedReservation(
      historyRows,
      'aurora',
      profileOwner('user-1'),
      oneDayFromNow(),
    );
    await expect(
      service.isTaken(manager, 'aurora', profileOwner('user-1')),
    ).resolves.toBe(false);
  });

  it('treats a name whose cooldown has lapsed as free for everyone', async () => {
    const { service, manager, historyRows } = makeService();
    seedReservation(historyRows, 'aurora', profileOwner('user-1'), oneDayAgo());
    await expect(
      service.isTaken(manager, 'aurora', profileOwner('user-2')),
    ).resolves.toBe(false);
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
    const { service, manager, historyRows } = makeService(rows);

    await service.release(manager, 'nightform', profileOwner('user-2'));

    expect(rows.has('nightform')).toBe(true);
    // No row was freed, so no reservation was written either.
    expect(historyRows.has('nightform')).toBe(false);
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

  it('records a reservation for whoever actually held the freed name', async () => {
    const rows = new Map<string, Handle>();
    seedProfile(rows, 'nightform', 'user-1');
    const { service, manager, historyRows } = makeService(rows);

    await service.release(manager, 'Nightform', profileOwner('user-1'));

    expect(historyRows.get('nightform')).toMatchObject({
      previousOwnerKind: HandleOwnerKind.Profile,
      previousOwnerUserId: 'user-1',
    });
  });
});
