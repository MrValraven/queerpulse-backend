import { EntityManager } from 'typeorm';
import { RosterRole } from './entities/community-member.entity';
import {
  AccessTier,
  Community,
  CommunityFrozenReason,
} from './entities/community.entity';
import { SubcommunityCascadeService } from './subcommunity-cascade.service';

/**
 * Records every clause a cascade builds so each test can pin the exact rows
 * it touches. The builder resolves `{ affected, raw }` like Postgres does for
 * a `RETURNING id` write.
 */
interface RecordedQuery {
  kind: 'update' | 'delete' | null;
  setValues: Record<string, unknown> | null;
  whereClauses: { clause: string; params: Record<string, unknown> }[];
  returning: string | null;
}

function buildManagerMock(result: { affected: number; raw: unknown }) {
  const recorded: RecordedQuery = {
    kind: null,
    setValues: null,
    whereClauses: [],
    returning: null,
  };
  type BuilderMock = Record<
    | 'delete'
    | 'update'
    | 'from'
    | 'set'
    | 'where'
    | 'andWhere'
    | 'returning'
    | 'execute',
    jest.Mock
  >;
  const builder = {} as BuilderMock;
  builder.delete = jest.fn((): BuilderMock => {
    recorded.kind = 'delete';
    return builder;
  });
  builder.update = jest.fn((): BuilderMock => {
    recorded.kind = 'update';
    return builder;
  });
  builder.from = jest.fn((): BuilderMock => builder);
  builder.set = jest.fn((values: Record<string, unknown>): BuilderMock => {
    recorded.setValues = values;
    return builder;
  });
  const recordWhere = (
    clause: string,
    params: Record<string, unknown> = {},
  ): BuilderMock => {
    recorded.whereClauses.push({ clause, params });
    return builder;
  };
  builder.where = jest.fn(recordWhere);
  builder.andWhere = jest.fn(recordWhere);
  builder.returning = jest.fn((columns: string): BuilderMock => {
    recorded.returning = columns;
    return builder;
  });
  builder.execute = jest.fn(() => Promise.resolve(result));
  // The space roster repository `assignSpaceOwner` upserts through.
  const membersRepository = {
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    create: jest.fn((row: unknown) => row),
    save: jest.fn((row: unknown) => Promise.resolve(row)),
  };
  const manager = {
    createQueryBuilder: jest.fn((): BuilderMock => builder),
    find: jest.fn(),
    findOne: jest.fn().mockResolvedValue({ id: 'space-1', rules: [] }),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    getRepository: jest.fn(() => membersRepository),
  };
  return { manager, membersRepository, recorded };
}

describe('SubcommunityCascadeService', () => {
  const service = new SubcommunityCascadeService();

  it('removeFromSpaces deletes only the user rows under the parent', async () => {
    const { manager, recorded } = buildManagerMock({
      affected: 2,
      raw: [{ community_id: 'space-1' }, { community_id: 'space-2' }],
    });

    const removedSpaceIds = await service.removeFromSpaces(
      manager as unknown as EntityManager,
      'parent-1',
      'user-1',
    );

    expect(removedSpaceIds).toEqual(['space-1', 'space-2']);
    expect(recorded.returning).toBe('community_id');
    expect(recorded.kind).toBe('delete');
    expect(recorded.whereClauses).toEqual([
      { clause: 'user_id = :userId', params: { userId: 'user-1' } },
      {
        clause:
          'community_id IN (SELECT id FROM communities WHERE parent_id = :parentId)',
        params: { parentId: 'parent-1' },
      },
    ]);
  });

  it('freezeSpaces touches only unfrozen spaces and stamps parent_frozen', async () => {
    const { manager, recorded } = buildManagerMock({
      affected: 1,
      raw: [{ id: 'space-1' }],
    });

    const frozenIds = await service.freezeSpaces(
      manager as unknown as EntityManager,
      'parent-1',
      'actor-1',
    );

    expect(frozenIds).toEqual(['space-1']);
    expect(recorded.kind).toBe('update');
    expect(recorded.whereClauses).toEqual([
      {
        clause: 'parent_id = :parentId AND frozen_at IS NULL',
        params: { parentId: 'parent-1' },
      },
    ]);
    expect(recorded.setValues).toEqual(
      expect.objectContaining({
        frozenReason: CommunityFrozenReason.ParentFrozen,
        frozenByUserId: 'actor-1',
        frozenNote: null,
      }),
    );
    expect(recorded.returning).toBe('id');
  });

  it('unfreezeSpaces clears only spaces frozen by the parent cascade', async () => {
    const { manager, recorded } = buildManagerMock({
      affected: 1,
      raw: [{ id: 'space-1' }],
    });

    const unfrozenIds = await service.unfreezeSpaces(
      manager as unknown as EntityManager,
      'parent-1',
    );

    expect(unfrozenIds).toEqual(['space-1']);
    expect(recorded.whereClauses).toEqual([
      {
        clause: 'parent_id = :parentId AND frozen_reason = :reason',
        params: {
          parentId: 'parent-1',
          reason: CommunityFrozenReason.ParentFrozen,
        },
      },
    ]);
    expect(recorded.setValues).toEqual({
      frozenAt: null,
      frozenReason: null,
      frozenByUserId: null,
      frozenNote: null,
    });
  });

  it('archiveSpaces archives only live spaces and marks them archived with the parent', async () => {
    const archivedAt = new Date('2026-09-22T00:00:00.000Z');
    const { manager, recorded } = buildManagerMock({
      affected: 1,
      raw: [{ id: 'space-1' }],
    });

    const archivedIds = await service.archiveSpaces(
      manager as unknown as EntityManager,
      'parent-1',
      archivedAt,
    );

    expect(archivedIds).toEqual(['space-1']);
    expect(recorded.whereClauses).toEqual([
      {
        clause: 'parent_id = :parentId AND archived_at IS NULL',
        params: { parentId: 'parent-1' },
      },
    ]);
    expect(recorded.setValues).toEqual({
      archivedAt,
      archivedWithParent: true,
    });
  });

  it('unarchiveSpaces restores only spaces archived with the parent', async () => {
    const { manager, recorded } = buildManagerMock({
      affected: 1,
      raw: [{ id: 'space-1' }],
    });

    const restoredIds = await service.unarchiveSpaces(
      manager as unknown as EntityManager,
      'parent-1',
    );

    expect(restoredIds).toEqual(['space-1']);
    expect(recorded.whereClauses).toEqual([
      {
        clause: 'parent_id = :parentId AND archived_with_parent = true',
        params: { parentId: 'parent-1' },
      },
    ]);
    expect(recorded.setValues).toEqual({
      archivedAt: null,
      archivedWithParent: false,
    });
  });

  it('raiseSpaceTiers updates only spaces more open than the parent', async () => {
    const { manager } = buildManagerMock({ affected: 0, raw: [] });
    manager.find.mockResolvedValue([
      { id: 'space-public', accessTier: AccessTier.Public },
      { id: 'space-request', accessTier: AccessTier.Request },
      { id: 'space-invite', accessTier: AccessTier.Invite },
      { id: 'space-private', accessTier: AccessTier.Private },
    ]);

    const raised = await service.raiseSpaceTiers(
      manager as unknown as EntityManager,
      'parent-1',
      AccessTier.Invite,
    );

    expect(raised).toEqual([
      { id: 'space-public', from: AccessTier.Public },
      { id: 'space-request', from: AccessTier.Request },
    ]);
    expect(manager.update).toHaveBeenCalledTimes(2);
    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'space-public' },
      { accessTier: AccessTier.Invite },
    );
    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'space-request' },
      { accessTier: AccessTier.Invite },
    );
  });

  describe('owner reassignment', () => {
    it("reassignSpacesOwnedBy hands a space the member owned to the parent's owner", async () => {
      const { manager, membersRepository } = buildManagerMock({
        affected: 0,
        raw: [],
      });
      manager.find.mockResolvedValue([{ id: 'space-1' }]);

      const reassignedSpaceIds = await service.reassignSpacesOwnedBy(
        manager as unknown as EntityManager,
        { id: 'parent-1', ownerId: 'parent-owner' },
        'space-owner',
      );

      expect(reassignedSpaceIds).toEqual(['space-1']);
      expect(manager.find).toHaveBeenCalledWith(
        Community,
        expect.objectContaining({
          where: { parentId: 'parent-1', ownerId: 'space-owner' },
        }),
      );
      expect(manager.update).toHaveBeenCalledWith(
        Community,
        { id: 'space-1' },
        { ownerId: 'parent-owner', needsOwnerReviewAt: null },
      );
      expect(membersRepository.save).toHaveBeenCalledWith({
        communityId: 'space-1',
        userId: 'parent-owner',
        role: RosterRole.Owner,
      });
    });

    it('reassignSpacesOwnedBy flags the space for owner review when the parent has no owner', async () => {
      const { manager, membersRepository } = buildManagerMock({
        affected: 0,
        raw: [],
      });
      manager.find.mockResolvedValue([{ id: 'space-1' }]);

      await service.reassignSpacesOwnedBy(
        manager as unknown as EntityManager,
        { id: 'parent-1', ownerId: null },
        'space-owner',
      );

      expect(manager.update).toHaveBeenCalledWith(
        Community,
        { id: 'space-1' },
        { ownerId: null, needsOwnerReviewAt: expect.any(Date) as unknown },
      );
      expect(membersRepository.save).not.toHaveBeenCalled();
    });

    it('assignSpaceOwner stamps the rules acceptance on a new row when the space has rules', async () => {
      const { manager, membersRepository } = buildManagerMock({
        affected: 0,
        raw: [],
      });
      manager.findOne.mockResolvedValue({
        id: 'space-1',
        rules: ['Be kind'],
        rulesVersion: 4,
      });

      const previousRole = await service.assignSpaceOwner(
        manager as unknown as EntityManager,
        'space-1',
        'parent-owner',
      );

      expect(previousRole).toBeNull();
      expect(membersRepository.save).toHaveBeenCalledWith({
        communityId: 'space-1',
        userId: 'parent-owner',
        role: RosterRole.Owner,
        rulesAcceptedAt: expect.any(Date) as unknown,
        rulesVersionAccepted: 4,
      });
    });

    it('assignSpaceOwner raises an existing row and reports its previous role', async () => {
      const { manager, membersRepository } = buildManagerMock({
        affected: 0,
        raw: [],
      });
      membersRepository.findOne.mockResolvedValue({
        id: 'row-1',
        role: RosterRole.Mod,
      });

      const previousRole = await service.assignSpaceOwner(
        manager as unknown as EntityManager,
        'space-1',
        'parent-owner',
      );

      expect(previousRole).toBe(RosterRole.Mod);
      expect(membersRepository.update).toHaveBeenCalledWith('row-1', {
        role: RosterRole.Owner,
      });
      expect(membersRepository.save).not.toHaveBeenCalled();
    });

    it('removeParentMemberFromSpaces reports the cleared and the reassigned spaces', async () => {
      const { manager } = buildManagerMock({
        affected: 2,
        raw: [{ community_id: 'space-1' }, { community_id: 'space-2' }],
      });
      manager.find.mockResolvedValue([{ id: 'space-2' }]);

      const outcome = await service.removeParentMemberFromSpaces(
        manager as unknown as EntityManager,
        { id: 'parent-1', ownerId: 'parent-owner' },
        'member-1',
      );

      expect(outcome).toEqual({
        removedSpaceIds: ['space-1', 'space-2'],
        reassignedSpaceIds: ['space-2'],
      });
    });
  });
});
