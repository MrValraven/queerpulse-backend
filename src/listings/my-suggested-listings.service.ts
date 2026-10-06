import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { Listing } from './entities/listing.entity';
import {
  MySuggestedListingDTO,
  toMySuggestedListingDTO,
} from './my-suggested-listing-response';

/**
 * PRD-434. The places a member suggested for the directory, so they can see
 * what came of them.
 *
 * A suggestion is stored as a listing the platform holds (`ownerId` null) with
 * the member on `suggestedByUserId`. `GET /listings/mine` reads ownership and
 * co-management, so it skipped every suggestion. Until this read the only
 * trace a suggester had was whichever bell rows a moderator's decision
 * produced.
 *
 * Its own small service, for the reason `ListingOwnerPendingService` gives:
 * `ListingsService` is already the largest class in the domain. It reads
 * `listings` alone with no join, so `paginate`'s plain `skip`/`take` is safe
 * here.
 */
@Injectable()
export class MySuggestedListingsService {
  constructor(
    @InjectRepository(Listing)
    private readonly listings: Repository<Listing>,
  ) {}

  /**
   * The caller's suggestions, newest first. A listing stays here after a claim
   * hands it to its business, because the member did suggest it and that is
   * the outcome they are owed; `holder` says who has it now.
   */
  async listMine(
    userId: string,
    requestedPage?: number,
  ): Promise<Paginated<MySuggestedListingDTO>> {
    const page = normalizePage(requestedPage);
    const queryBuilder = this.listings
      .createQueryBuilder('listing')
      .where('listing.suggestedByUserId = :userId', { userId })
      .orderBy('listing.createdAt', 'DESC');

    return paginate(queryBuilder, page, (rows) =>
      rows.map((row) => toMySuggestedListingDTO(row, userId)),
    );
  }
}
