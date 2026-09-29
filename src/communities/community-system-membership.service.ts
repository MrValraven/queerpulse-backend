import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  COMMUNITY_MEMBER_JOINED,
  COMMUNITY_MEMBER_LEFT,
  CommunityMemberJoinedEvent,
  CommunityMemberLeftEvent,
} from './community.events';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';

/**
 * Roster writes the platform makes on a member's behalf, with no human actor:
 * today, the ambassadors' circle, which a grant joins and a revoke leaves.
 *
 * Bypasses the tier gates of `join()` and the actor rules of `removeMember()`
 * on purpose, since the caller already holds the authority (a staff grant).
 * It still emits the same roster events, so the card listener issues and
 * revokes cards exactly as it does for a human join or leave.
 *
 * Only for communities with no spaces: removal does not cascade into spaces.
 * The circle is created with `allowsSubcommunities` false.
 */
@Injectable()
export class CommunitySystemMembershipService {
  constructor(
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Adds the member with `role`, or does nothing when they already hold any
   * row in this community (`ON CONFLICT DO NOTHING` on `UQ_community_members`).
   * An existing row keeps its role: a moderator is never demoted to member.
   * Returns true only when this call wrote the row.
   */
  async addMember(
    communityId: string,
    userId: string,
    role: RosterRole,
  ): Promise<boolean> {
    const result = await this.members
      .createQueryBuilder()
      .insert()
      .into(CommunityMember)
      .values({ communityId, userId, role })
      .orIgnore()
      .execute();
    // `raw` holds the rows Postgres actually returned, so it is empty exactly
    // when `ON CONFLICT DO NOTHING` absorbed the insert. `identifiers` is no
    // use here: TypeORM fills it from the values passed in whether or not the
    // row was written (see `MessageAnnotationsService.pinMessage`).
    const wasInserted = Array.isArray(result.raw) && result.raw.length > 0;
    if (wasInserted) {
      this.eventEmitter.emit(COMMUNITY_MEMBER_JOINED, {
        communityId,
        userId,
      } satisfies CommunityMemberJoinedEvent);
    }
    return wasInserted;
  }

  /**
   * Removes the member only when their row carries exactly `role`, so asking
   * to remove a `member` keeps a `mod` or owner seat in place. Returns true
   * only when this call deleted the row.
   */
  async removeMemberIfRole(
    communityId: string,
    userId: string,
    role: RosterRole,
  ): Promise<boolean> {
    const result = await this.members.delete({ communityId, userId, role });
    const wasRemoved = (result.affected ?? 0) > 0;
    if (wasRemoved) {
      this.eventEmitter.emit(COMMUNITY_MEMBER_LEFT, {
        communityId,
        userId,
      } satisfies CommunityMemberLeftEvent);
    }
    return wasRemoved;
  }
}
