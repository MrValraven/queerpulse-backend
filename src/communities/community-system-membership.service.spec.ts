import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import {
  COMMUNITY_MEMBER_JOINED,
  COMMUNITY_MEMBER_LEFT,
} from './community.events';
import { CommunitySystemMembershipService } from './community-system-membership.service';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';

/**
 * The platform's own roster writes. The events matter as much as the rows:
 * the membership-card listener keys off them, so an insert that emits nothing
 * leaves an ambassador without a card, and a skipped insert that emits anyway
 * would issue a second one.
 */
describe('CommunitySystemMembershipService', () => {
  function buildService(options: {
    insertedRows?: unknown[];
    deletedCount?: number;
  }) {
    const insertBuilder = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({
        identifiers: [{ id: 'row-1' }],
        raw: options.insertedRows ?? [],
      }),
    };
    const membersRepository = {
      createQueryBuilder: jest.fn(() => insertBuilder),
      delete: jest
        .fn()
        .mockResolvedValue({ affected: options.deletedCount ?? 0, raw: [] }),
    };
    const eventEmitter = { emit: jest.fn() };
    const service = new CommunitySystemMembershipService(
      membersRepository as unknown as Repository<CommunityMember>,
      eventEmitter as unknown as EventEmitter2,
    );
    return { service, insertBuilder, membersRepository, eventEmitter };
  }

  it('inserts with ON CONFLICT DO NOTHING and emits the join event when a row was written', async () => {
    const { service, insertBuilder, eventEmitter } = buildService({
      insertedRows: [{ id: 'row-1' }],
    });

    const wasInserted = await service.addMember(
      'community-1',
      'user-1',
      RosterRole.Member,
    );

    expect(wasInserted).toBe(true);
    expect(insertBuilder.values).toHaveBeenCalledWith({
      communityId: 'community-1',
      userId: 'user-1',
      role: RosterRole.Member,
    });
    expect(insertBuilder.orIgnore).toHaveBeenCalled();
    expect(eventEmitter.emit).toHaveBeenCalledWith(COMMUNITY_MEMBER_JOINED, {
      communityId: 'community-1',
      userId: 'user-1',
    });
  });

  it('treats a second add as a no-op with no event, even though identifiers is filled', async () => {
    const { service, eventEmitter } = buildService({ insertedRows: [] });

    const wasInserted = await service.addMember(
      'community-1',
      'user-1',
      RosterRole.Member,
    );

    expect(wasInserted).toBe(false);
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('deletes only the row with the named role and emits the leave event', async () => {
    const { service, membersRepository, eventEmitter } = buildService({
      deletedCount: 1,
    });

    const wasRemoved = await service.removeMemberIfRole(
      'community-1',
      'user-1',
      RosterRole.Member,
    );

    expect(wasRemoved).toBe(true);
    expect(membersRepository.delete).toHaveBeenCalledWith({
      communityId: 'community-1',
      userId: 'user-1',
      role: RosterRole.Member,
    });
    expect(eventEmitter.emit).toHaveBeenCalledWith(COMMUNITY_MEMBER_LEFT, {
      communityId: 'community-1',
      userId: 'user-1',
    });
  });

  it('keeps a mod row when asked to remove a member, and emits nothing', async () => {
    // The role sits in the DELETE's WHERE clause, so a mod row matches
    // nothing and Postgres reports zero rows affected.
    const { service, membersRepository, eventEmitter } = buildService({
      deletedCount: 0,
    });

    const wasRemoved = await service.removeMemberIfRole(
      'community-1',
      'staff-1',
      RosterRole.Member,
    );

    expect(wasRemoved).toBe(false);
    expect(membersRepository.delete).toHaveBeenCalledWith(
      expect.objectContaining({ role: RosterRole.Member }),
    );
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });
});
