import { BadRequestException, NotFoundException } from '@nestjs/common';
import { IdentityBlock } from '../identities/entities/identity-block.entity';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IDENTITY_BLOCKED } from './social.events';
import { PATH_METADATA } from '@nestjs/common/constants';
import { IdentityBlocksService } from './identity-blocks.service';
import { BlocksController } from './blocks.controller';
import { IdentityBlocksController } from './identity-blocks.controller';

/**
 * Task 14: blocking a whole business, persona or company. The repository is
 * an in-memory table with the `UQ_identity_blocks_pair` unique pair, so an
 * `INSERT ... ON CONFLICT DO NOTHING` behaves as it does in Postgres.
 */

const CUSTOMER = 'customer-user';
const OWNER = 'owner-user';
const CO_MANAGER = 'co-manager-user';

const LISTING_IDENTITY = '0b0b0b0b-0000-4000-8000-000000000001';
const PERSONA_IDENTITY = '0b0b0b0b-0000-4000-8000-000000000002';
const OWNER_PROFILE_IDENTITY = '0b0b0b0b-0000-4000-8000-000000000003';
const UNKNOWN_IDENTITY = '0b0b0b0b-0000-4000-8000-000000000009';

const identitiesById = new Map([
  [LISTING_IDENTITY, { id: LISTING_IDENTITY, kind: IdentityKind.Listing }],
  [PERSONA_IDENTITY, { id: PERSONA_IDENTITY, kind: IdentityKind.Subprofile }],
  [
    OWNER_PROFILE_IDENTITY,
    { id: OWNER_PROFILE_IDENTITY, kind: IdentityKind.Profile },
  ],
]);
const staffByIdentityId = new Map([
  [LISTING_IDENTITY, [OWNER, CO_MANAGER]],
  [PERSONA_IDENTITY, [OWNER]],
  [OWNER_PROFILE_IDENTITY, [OWNER]],
]);

function build() {
  const rows: IdentityBlock[] = [];
  let nextId = 1;
  const matches = (row: IdentityBlock, where: Partial<IdentityBlock>) =>
    Object.entries(where).every(
      ([column, value]) => row[column as keyof IdentityBlock] === value,
    );
  const repository = {
    createQueryBuilder: jest.fn(() => {
      let pending: Partial<IdentityBlock> | undefined;
      let blockerUserId: string | undefined;
      const builder = {
        insert: () => builder,
        into: () => builder,
        values: (values: Partial<IdentityBlock>) => {
          pending = values;
          return builder;
        },
        orIgnore: () => builder,
        returning: () => builder,
        // As Postgres answers `ON CONFLICT DO NOTHING RETURNING id`: one
        // returned row for a new insert, none for a conflict.
        execute: () => {
          const isDuplicate = rows.some(
            (row) =>
              row.blockerUserId === pending!.blockerUserId &&
              row.identityId === pending!.identityId,
          );
          if (isDuplicate) {
            return Promise.resolve({ raw: [] });
          }
          const id = `identity-block-${nextId}`;
          rows.push({
            id,
            createdAt: new Date(Date.UTC(2026, 8, nextId)),
            ...pending,
          } as IdentityBlock);
          nextId += 1;
          return Promise.resolve({ raw: [{ id }] });
        },
        where: (_clause: string, parameters: { userId: string }) => {
          blockerUserId = parameters.userId;
          return builder;
        },
        orderBy: () => builder,
        addOrderBy: () => builder,
        skip: () => builder,
        take: () => builder,
        getManyAndCount: () => {
          const ownRows = rows
            .filter((row) => row.blockerUserId === blockerUserId)
            .sort((left, right) => +right.createdAt - +left.createdAt);
          return Promise.resolve([ownRows, ownRows.length]);
        },
      };
      return builder;
    }),
    findOneOrFail: jest.fn(({ where }: { where: Partial<IdentityBlock> }) => {
      const row = rows.find((candidate) => matches(candidate, where));
      return row ? Promise.resolve(row) : Promise.reject(new Error('none'));
    }),
    delete: jest.fn((where: Partial<IdentityBlock>) => {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (matches(rows[index]!, where)) rows.splice(index, 1);
      }
      return Promise.resolve({ affected: before - rows.length });
    }),
  };
  const identities = {
    getById: jest.fn((identityId: string) =>
      Promise.resolve(identitiesById.get(identityId) ?? null),
    ),
    getByIds: jest.fn((identityIds: string[]) =>
      Promise.resolve(
        identityIds
          .map((identityId) => identitiesById.get(identityId))
          .filter(Boolean),
      ),
    ),
    isAllowedToActAs: jest.fn((userId: string, identityId: string) =>
      Promise.resolve(
        (staffByIdentityId.get(identityId) ?? []).includes(userId),
      ),
    ),
    describeIdentities: jest.fn((identityIds: string[]) =>
      Promise.resolve(
        new Map(
          identityIds.map((identityId) => [
            identityId,
            {
              displayName: `Display of ${identityId}`,
              handle: null,
              avatarUrl: null,
            },
          ]),
        ),
      ),
    ),
  };
  const eventEmitter = { emit: jest.fn() };
  const service = new IdentityBlocksService(
    repository as never,
    identities as never,
    eventEmitter as never,
  );
  return { service, rows, identities, eventEmitter };
}

describe('Task 14: IdentityBlocksService', () => {
  it('blocks a business and tells the chat gateway who blocked what', async () => {
    const { service, rows, eventEmitter } = build();

    const result = await service.blockIdentity(CUSTOMER, LISTING_IDENTITY);

    expect(rows).toHaveLength(1);
    expect(result.identity).toEqual({
      id: LISTING_IDENTITY,
      kind: IdentityKind.Listing,
      displayName: `Display of ${LISTING_IDENTITY}`,
      handle: null,
      avatarUrl: null,
    });
    expect(eventEmitter.emit).toHaveBeenCalledWith(IDENTITY_BLOCKED, {
      blockerUserId: CUSTOMER,
      identityId: LISTING_IDENTITY,
    });
  });

  it('tells the chat gateway once, for the call that placed the block, and nothing on a repeat', async () => {
    const { service, eventEmitter } = build();

    await service.blockIdentity(CUSTOMER, LISTING_IDENTITY);
    await service.blockIdentity(CUSTOMER, LISTING_IDENTITY);

    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    expect(eventEmitter.emit).toHaveBeenCalledWith(IDENTITY_BLOCKED, {
      blockerUserId: CUSTOMER,
      identityId: LISTING_IDENTITY,
    });
  });

  it('keeps one row when the same identity is blocked twice, and returns it both times', async () => {
    const { service, rows } = build();

    const first = await service.blockIdentity(CUSTOMER, LISTING_IDENTITY);
    const second = await service.blockIdentity(CUSTOMER, LISTING_IDENTITY);

    expect(rows).toHaveLength(1);
    expect(second.id).toBe(first.id);
  });

  it('refuses a profile identity, which is a person that a person block covers', async () => {
    const { service, rows, eventEmitter } = build();

    await expect(
      service.blockIdentity(CUSTOMER, OWNER_PROFILE_IDENTITY),
    ).rejects.toThrow(BadRequestException);
    expect(rows).toHaveLength(0);
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('refuses an identity the caller answers for, as owner, co-manager or persona owner', async () => {
    const { service, rows } = build();

    await expect(
      service.blockIdentity(OWNER, LISTING_IDENTITY),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.blockIdentity(CO_MANAGER, LISTING_IDENTITY),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.blockIdentity(OWNER, PERSONA_IDENTITY),
    ).rejects.toThrow(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('refuses an unknown identity', async () => {
    const { service, rows } = build();

    await expect(
      service.blockIdentity(CUSTOMER, UNKNOWN_IDENTITY),
    ).rejects.toThrow(NotFoundException);
    expect(rows).toHaveLength(0);
  });

  it('succeeds when lifting a block that does not exist, and removes one that does', async () => {
    const { service, rows } = build();

    await expect(
      service.unblockIdentity(CUSTOMER, LISTING_IDENTITY),
    ).resolves.toBeUndefined();
    await service.blockIdentity(CUSTOMER, LISTING_IDENTITY);
    await service.unblockIdentity(CUSTOMER, LISTING_IDENTITY);

    expect(rows).toHaveLength(0);
  });

  it("lists the caller's blocks newest first, with every page's display read in one batch", async () => {
    const { service, identities } = build();
    await service.blockIdentity(CUSTOMER, LISTING_IDENTITY);
    await service.blockIdentity(CUSTOMER, PERSONA_IDENTITY);
    await service.blockIdentity(OWNER, LISTING_IDENTITY).catch(() => null);
    identities.describeIdentities.mockClear();

    const page = await service.listIdentityBlocks(CUSTOMER);

    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.identity.id)).toEqual([
      PERSONA_IDENTITY,
      LISTING_IDENTITY,
    ]);
    expect(page.items.map((item) => item.identity.kind)).toEqual([
      IdentityKind.Subprofile,
      IdentityKind.Listing,
    ]);
    expect(identities.describeIdentities).toHaveBeenCalledTimes(1);
  });
});

describe('Task 14 fix round 1: the identity-block routes', () => {
  function routePath(target: object): unknown {
    return Reflect.getMetadata(PATH_METADATA, target);
  }

  it('live under /identity-blocks, apart from /blocks/:slug', () => {
    expect(routePath(IdentityBlocksController)).toBe('identity-blocks');
    const prototype = IdentityBlocksController.prototype as unknown as Record<
      string,
      object
    >;
    expect([
      routePath(prototype.list!),
      routePath(prototype.block!),
      routePath(prototype.unblock!),
    ]).toEqual(['/', ':identityId', ':identityId']);
  });

  it('leave every /blocks route to members, so a member whose handle is "identities" is read as that member', () => {
    const prototype = BlocksController.prototype as unknown as Record<
      string,
      object
    >;
    const blocksRoutePaths = Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => routePath(prototype[name]!));

    expect(routePath(BlocksController)).toBe('blocks');
    expect(blocksRoutePaths).toEqual(expect.arrayContaining(['/', ':slug']));
    expect(
      blocksRoutePaths.filter(
        (path) => typeof path === 'string' && path.includes('identities'),
      ),
    ).toEqual([]);
  });
});
