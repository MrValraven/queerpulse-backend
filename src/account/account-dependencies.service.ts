import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { Listing, ListingStatus } from '../listings/entities/listing.entity';
import {
  AccountDependenciesResponse,
  AccountDependencyCommunityResponse,
  AccountDependencyListingResponse,
} from './account-dependencies.response';

/**
 * What the delete-account page warns about before erasure: the communities the
 * caller owns and the caller's own listings that are publicly live.
 *
 * ## Why this lives under `/account`
 *
 * The frontend used to compose these lists from `GET /me/communities` and
 * `GET /listings/mine`. Both controllers carry `ActiveMemberGuard`, so for a
 * banned or suspended member (whom the delete-account page still admits) both
 * answered 403, the lists came back empty and the ownership warning never
 * showed. `AccountController` has no `ActiveMemberGuard` on purpose, so this
 * read reaches every signed-in member, whatever their status.
 *
 * ## The rules it mirrors
 *
 * - Communities: the same membership rows `CommunitiesService.myCommunities`
 *   reads, narrowed to roster role `owner`. Archived communities drop out, as
 *   they do there. Private-tier communities and spaces stay IN: an owned
 *   private community is still one its sole owner would strand, and hiding it
 *   here would let them request erasure without ever seeing it named.
 * - Listings: the caller's OWN listings (`owner_id`) whose moderation status
 *   is `live`. A listing still in review is not publicly reachable, so it
 *   needs no step before erasure. A listing hidden by its owner is still live
 *   and still counts, because hiding it does not hand it to anybody. A listing
 *   the caller only co-manages is left out: its owner keeps it whatever
 *   happens to this account.
 *
 * Erasure itself reassigns or releases all of these in the backend (see
 * `CommunityOwnerOrphanService.handleOwnerErasure` and
 * `ContentOwnerErasureService`), so this is the honest warning before that
 * happens. Nothing here blocks erasure on the server.
 */
@Injectable()
export class AccountDependenciesService {
  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(Listing)
    private readonly listings: Repository<Listing>,
  ) {}

  async forUser(userId: string): Promise<AccountDependenciesResponse> {
    const [communities, listings] = await Promise.all([
      this.ownedCommunities(userId),
      this.liveOwnedListings(userId),
    ]);
    return { communities, listings };
  }

  private ownedCommunities(
    userId: string,
  ): Promise<AccountDependencyCommunityResponse[]> {
    // Joined by entity class: `CommunityMember` is registered by
    // `CommunitiesModule`, and a join needs only its metadata, which the
    // shared DataSource already holds.
    return this.communities
      .createQueryBuilder('c')
      .innerJoin(CommunityMember, 'm', 'm.community_id = c.id')
      .select('c.slug', 'slug')
      .addSelect('c.name', 'name')
      .where('m.user_id = :userId', { userId })
      .andWhere('m.role = :ownerRole', { ownerRole: RosterRole.Owner })
      .andWhere('c.archived_at IS NULL')
      .orderBy('c.name', 'ASC')
      .getRawMany<AccountDependencyCommunityResponse>();
  }

  private async liveOwnedListings(
    userId: string,
  ): Promise<AccountDependencyListingResponse[]> {
    const rows = await this.listings.find({
      select: { ref: true, name: true },
      where: { ownerId: userId, status: ListingStatus.Live },
      order: { createdAt: 'DESC' },
    });
    return rows.map((row) => ({ ref: row.ref, name: row.name }));
  }
}
