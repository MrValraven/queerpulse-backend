import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository, SelectQueryBuilder } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { escapeLikeTerm } from '../common/like-escape';
import { MemberLookup, MemberRef } from '../common/member-ref';
import {
  DEFAULT_LIST_LIMIT,
  normalizePage,
  paginate,
  Paginated,
} from '../common/pagination';
import { MessagingService } from '../messaging/messaging.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import {
  BarterListingDTO,
  BarterMemberRef,
  BarterProposalAckDTO,
  BarterProposalDTO,
  MyBarterListingDTO,
  toBarterListingDTO,
  toBarterMemberRef,
  toBarterProposalDTO,
  toMyBarterListingDTO,
} from './barter-response';
import { CreateBarterListingDto } from './dto/create-barter-listing.dto';
import { CreateBarterProposalDto } from './dto/create-barter-proposal.dto';
import { ListBarterQuery } from './dto/list-barter.query';
import {
  BarterListing,
  BarterListingStatus,
  BarterMode,
} from './entities/barter-listing.entity';
import {
  BarterProposal,
  BarterProposalStatus,
} from './entities/barter-proposal.entity';

/** SQL column reference for the block/mute filters, already quoted and
 *  snake-cased to match the `listing` alias under `SnakeNamingStrategy`. */
const LISTING_OWNER_COLUMN = '"listing"."owner_id"';

@Injectable()
export class BarterService {
  private readonly logger = new Logger(BarterService.name);

  constructor(
    @InjectRepository(BarterListing)
    private readonly listings: Repository<BarterListing>,
    @InjectRepository(BarterProposal)
    private readonly proposals: Repository<BarterProposal>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
    private readonly blockFilter: BlockFilterService,
    private readonly messaging: MessagingService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * The public board. Open listings only, newest first, with the same three
   * controls the page already offers: category chips, offering/seeking tabs,
   * and free-text search.
   *
   * Block/mute is applied INSIDE the query (`excludeHidden`) rather than after
   * it, so a page of `PAGE_SIZE` comes back full instead of silently short —
   * the reason that method exists.
   */
  async list(
    viewerId: string,
    query: ListBarterQuery,
  ): Promise<Paginated<BarterListingDTO>> {
    const page = normalizePage(query.page);
    const qb = this.listings
      .createQueryBuilder('listing')
      .where('listing.status = :open', { open: BarterListingStatus.Open });

    this.blockFilter.excludeHidden(qb, viewerId, LISTING_OWNER_COLUMN);

    if (query.category) {
      qb.andWhere('listing.category = :category', { category: query.category });
    }
    this.applyModeFilter(qb, query.mode);
    this.applySearchFilter(qb, query.q);

    // `id` breaks ties so offset paging can never skip or repeat a row posted
    // in the same millisecond as its neighbour.
    qb.orderBy('listing.createdAt', 'DESC').addOrderBy('listing.id', 'DESC');

    return paginate(qb, page, (rows) => this.buildCards(rows, viewerId));
  }

  /**
   * One listing. A listing whose owner the viewer has blocked (either way)
   * reads as 404 rather than 403: the severance should not confirm that the
   * post exists.
   */
  async getById(id: string, viewerId: string): Promise<BarterListingDTO> {
    const listing = await this.loadOr404(id);
    if (
      listing.ownerId !== viewerId &&
      (await this.blockFilter.isBlockedEitherWay(viewerId, listing.ownerId))
    ) {
      throw new NotFoundException('Listing not found');
    }
    const [card] = await this.buildCards([listing], viewerId);
    if (!card) throw new NotFoundException('Listing not found');
    return card;
  }

  /** Post a swap. */
  async create(
    ownerId: string,
    dto: CreateBarterListingDto,
  ): Promise<BarterListingDTO> {
    const offer = (dto.offer ?? '').trim();
    const want = (dto.want ?? '').trim();
    this.assertSidesMatchMode(dto.mode, offer, want);

    const saved = await this.listings.save(
      this.listings.create({
        ownerId,
        category: dto.category,
        mode: dto.mode,
        offer,
        want,
        offerDetail: (dto.offerDetail ?? '').trim(),
        wantDetail: (dto.wantDetail ?? '').trim(),
        tags: this.normalizeTags(dto.tags),
        status: BarterListingStatus.Open,
      }),
    );

    const [card] = await this.buildCards([saved], ownerId);
    if (!card) throw new NotFoundException('Listing not found');
    return card;
  }

  /**
   * Take a listing off the board. Idempotent — re-closing an already-closed
   * listing re-saves the same status rather than 409ing (mirrors
   * `VolunteeringService.close`).
   */
  async close(id: string, ownerId: string): Promise<BarterListingDTO> {
    const listing = await this.loadOr404(id);
    if (listing.ownerId !== ownerId) {
      throw new ForbiddenException('Only the poster can close this listing');
    }
    listing.status = BarterListingStatus.Closed;
    const saved = await this.listings.save(listing);
    const [card] = await this.buildCards([saved], ownerId);
    if (!card) throw new NotFoundException('Listing not found');
    return card;
  }

  /** The caller's own listings, with how many proposals are still waiting on
   *  each. Bounded, not paginated — a member's own board is short. */
  async listMine(ownerId: string): Promise<MyBarterListingDTO[]> {
    const rows = await this.listings.find({
      where: { ownerId },
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    if (!rows.length) return [];

    const pendingCounts = await this.pendingCountsByListing(
      rows.map((row) => row.id),
    );
    const member = await this.ownerRefFor(ownerId);
    return rows.map((row) =>
      toMyBarterListingDTO(row, {
        member,
        pendingProposalCount: pendingCounts.get(row.id) ?? 0,
      }),
    );
  }

  /**
   * Propose a swap against someone else's listing.
   *
   * Two writes have to agree, so the row is written inside a transaction that
   * holds a pessimistic write lock on the listing: the lock is what stops a
   * listing being closed out from under a proposal, and what makes the
   * reactivate-a-declined-row path safe against a concurrent second attempt
   * (the UNIQUE constraint is still the last word — see the catch below).
   *
   * Delivery to the owner's inbox happens AFTER the commit, best-effort. This
   * is the same "notify the poster" step volunteering does through
   * `NotificationsService`, routed through messaging instead because a swap
   * proposal is a conversation opener — exactly what
   * `HousingListingsService.createEnquiry` does with a housing enquiry, and it
   * lands in a surface the member already reads. A delivery failure must never
   * surface as a failed proposal: the row is committed and already visible in
   * the owner's proposal list.
   */
  async createProposal(
    listingId: string,
    proposerId: string,
    dto: CreateBarterProposalDto,
  ): Promise<BarterProposalAckDTO> {
    const message = dto.message.trim();

    // Refusals that need no lock are answered first, so the pessimistic lock
    // below is held for the write alone and no second pool connection is
    // borrowed (for the blocks lookup) while it is open.
    const target = await this.loadOr404(listingId);
    const ownerId = target.ownerId;
    if (ownerId === proposerId) {
      throw new ForbiddenException(
        'You cannot propose a swap on your own listing',
      );
    }
    if (await this.blockFilter.isBlockedEitherWay(proposerId, ownerId)) {
      throw new ForbiddenException('You cannot contact this member');
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const listing = await manager.findOne(BarterListing, {
        where: { id: listingId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!listing) {
        throw new NotFoundException('Listing not found');
      }
      // Re-checked under the lock: the unlocked read above is only a fast
      // fail, and ownership could in principle have changed between the two.
      if (listing.ownerId === proposerId) {
        throw new ForbiddenException(
          'You cannot propose a swap on your own listing',
        );
      }
      if (listing.status !== BarterListingStatus.Open) {
        throw new ConflictException('This listing is no longer taking swaps');
      }

      const proposalRepo = manager.getRepository(BarterProposal);
      const existing = await proposalRepo.findOne({
        where: { listingId: listing.id, proposerId },
      });
      if (existing) {
        if (existing.status !== BarterProposalStatus.Declined) {
          throw new ConflictException(
            'You already have a proposal on this listing',
          );
        }
        // Reapply after a decline reactivates the same row — the UNIQUE
        // (listing, proposer) pair forbids a second one either way, and one
        // member can never stack proposals in an owner's inbox.
        existing.message = message;
        existing.status = BarterProposalStatus.Pending;
        existing.decidedAt = null;
        return proposalRepo.save(existing);
      }

      try {
        return await proposalRepo.save(
          proposalRepo.create({
            listingId: listing.id,
            proposerId,
            message,
            status: BarterProposalStatus.Pending,
          }),
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException(
            'You already have a proposal on this listing',
          );
        }
        throw error;
      }
    });

    let conversationId: string | null = null;
    try {
      const delivered = await this.messaging.deliverEnquiry(
        proposerId,
        ownerId,
        message,
      );
      conversationId = delivered.conversationId;
    } catch (error) {
      this.logger.error(
        `Barter proposal ${saved.id} saved but inbox delivery failed: ${String(error)}`,
      );
    }

    // The BELL half of the same delivery, best-effort after the commit for
    // exactly the reason the DM above is: the proposal row is already
    // committed and already visible in the owner's proposal list, so a
    // notification failure must never roll it back. Both channels are kept —
    // the DM is the conversation (and what carries push), this is what makes
    // the bell ring at all.
    //
    // The payload carries the listing's own PUBLIC headline and nothing the
    // proposer wrote: `message` is member-authored private text that belongs
    // in the DM thread. `PAYLOAD_ALLOWLIST` would strip it at the response
    // boundary regardless, but it is never written here in the first place.
    // The proposer goes in as the `actorId` argument so block/mute is honoured
    // at write time like any member-driven type.
    try {
      await this.notifications.create(
        ownerId,
        NotificationType.BarterProposalReceived,
        {
          source: 'barter',
          barterListingId: listingId,
          listingOffer: target.offer,
        },
        proposerId,
      );
    } catch (error) {
      this.logger.error(
        `Barter proposal ${saved.id} saved but notification failed: ${String(error)}`,
      );
    }

    const proposer = await this.memberRefFor(proposerId);
    return {
      proposal: toBarterProposalDTO(saved, proposer),
      conversationId,
    };
  }

  /**
   * What came in on one of your listings. Owner-only, bounded, newest first.
   * A proposer the owner has since blocked or muted is dropped here — the
   * post-query form of the filter, because this list has no `LIMIT` to
   * under-fill.
   */
  async listProposals(
    listingId: string,
    ownerId: string,
  ): Promise<BarterProposalDTO[]> {
    await this.loadOwnedOr403(listingId, ownerId);

    const rows = await this.proposals.find({
      where: { listingId },
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    if (!rows.length) return [];

    const hidden = await this.blockFilter.hiddenUserIds(
      ownerId,
      rows.map((row) => row.proposerId),
    );
    const visible = rows.filter((row) => !hidden.has(row.proposerId));
    if (!visible.length) return [];

    const refs = await new MemberLookup(this.profiles).byUserIds(
      visible.map((row) => row.proposerId),
    );
    return visible.map((row) =>
      toBarterProposalDTO(row, refs.get(row.proposerId) ?? null),
    );
  }

  /**
   * Say yes or no to a proposal. The guarded `status = 'pending'` UPDATE — not
   * the pre-check above it — is what closes the race between two concurrent
   * decisions (mirrors `VolunteeringService.decideSignup`).
   */
  async decideProposal(
    listingId: string,
    proposalId: string,
    ownerId: string,
    status: BarterProposalStatus.Accepted | BarterProposalStatus.Declined,
  ): Promise<BarterProposalDTO> {
    await this.loadOwnedOr403(listingId, ownerId);

    const proposal = await this.proposals.findOne({
      where: { id: proposalId, listingId },
    });
    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }
    if (proposal.status !== BarterProposalStatus.Pending) {
      throw new ConflictException('This proposal was already decided');
    }

    const decidedAt = new Date();
    const claim = await this.proposals
      .createQueryBuilder()
      .update(BarterProposal)
      .set({ status, decidedAt })
      .where('id = :id AND status = :pending', {
        id: proposal.id,
        pending: BarterProposalStatus.Pending,
      })
      .execute();
    if (claim.affected === 0) {
      throw new ConflictException('This proposal was already decided');
    }
    proposal.status = status;
    proposal.decidedAt = decidedAt;

    const proposer = await this.memberRefFor(proposal.proposerId);
    return toBarterProposalDTO(proposal, proposer);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * The mode tabs are inclusive of `both`: "Offering" means "has something to
   * give", which covers a `both` post, and the mirror holds for "Seeking".
   * This is the server-side twin of the board's own predicate, which drops a
   * pure `seeking` post under the Offering tab and vice versa.
   */
  private applyModeFilter(
    qb: SelectQueryBuilder<BarterListing>,
    mode: BarterMode | undefined,
  ): void {
    if (!mode) return;
    if (mode === BarterMode.Both) {
      qb.andWhere('listing.mode = :mode', { mode: BarterMode.Both });
      return;
    }
    qb.andWhere('listing.mode IN (:...modes)', {
      modes: [mode, BarterMode.Both],
    });
  }

  /** Free-text search over both sides of the swap and its tags. */
  private applySearchFilter(
    qb: SelectQueryBuilder<BarterListing>,
    rawQuery: string | undefined,
  ): void {
    const term = rawQuery?.trim();
    if (!term) return;
    qb.andWhere(
      `(listing.offer ILIKE :barterTerm
        OR listing.want ILIKE :barterTerm
        OR listing.offerDetail ILIKE :barterTerm
        OR listing.wantDetail ILIKE :barterTerm
        OR EXISTS (
          SELECT 1 FROM unnest("listing"."tags") AS "__tag"
          WHERE "__tag" ILIKE :barterTerm
        ))`,
      { barterTerm: `%${escapeLikeTerm(term)}%` },
    );
  }

  /**
   * A listing has to actually carry the side its mode advertises, or the board
   * renders an empty block. Enforced here rather than with conditional
   * validators so one clear message covers all three modes.
   */
  private assertSidesMatchMode(
    mode: BarterMode,
    offer: string,
    want: string,
  ): void {
    const needsOffer = mode !== BarterMode.Seeking;
    const needsWant = mode !== BarterMode.Offering;
    if (needsOffer && !offer) {
      throw new BadRequestException('Say what you are offering');
    }
    if (needsWant && !want) {
      throw new BadRequestException('Say what you are looking for');
    }
  }

  /** Trims, drops empties, and de-duplicates the chips. The DTO already caps
   *  the count and each label's length. */
  private normalizeTags(tags: string[] | undefined): string[] {
    if (!tags?.length) return [];
    const cleaned = tags.map((tag) => tag.trim()).filter(Boolean);
    return [...new Set(cleaned)];
  }

  /** Hydrates a batch of listings into cards: one profile lookup and one
   *  proposal lookup for the whole page, never per row. */
  private async buildCards(
    rows: BarterListing[],
    viewerId: string,
  ): Promise<BarterListingDTO[]> {
    if (!rows.length) return [];

    const [refs, proposedListingIds] = await Promise.all([
      this.ownerRefs(rows.map((row) => row.ownerId)),
      this.listingIdsProposedBy(
        viewerId,
        rows.map((row) => row.id),
      ),
    ]);

    return rows.map((row) =>
      toBarterListingDTO(row, {
        member: refs.get(row.ownerId) ?? null,
        isOwner: row.ownerId === viewerId,
        hasProposed: proposedListingIds.has(row.id),
      }),
    );
  }

  /** Which of `listingIds` the viewer already has a proposal on. */
  private async listingIdsProposedBy(
    viewerId: string,
    listingIds: string[],
  ): Promise<Set<string>> {
    if (!listingIds.length) return new Set();
    const rows = await this.proposals.find({
      where: { listingId: In(listingIds), proposerId: viewerId },
      select: { listingId: true },
    });
    return new Set(rows.map((row) => row.listingId));
  }

  /** listingId -> number of proposals still awaiting a decision. */
  private async pendingCountsByListing(
    listingIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!listingIds.length) return counts;

    const rows = await this.proposals
      .createQueryBuilder('proposal')
      .select('proposal.listing_id', 'listingId')
      .addSelect('COUNT(*)', 'count')
      .where('proposal.listing_id IN (:...listingIds)', { listingIds })
      .andWhere('proposal.status = :pending', {
        pending: BarterProposalStatus.Pending,
      })
      .groupBy('proposal.listing_id')
      .getRawMany<{ listingId: string; count: string }>();

    for (const row of rows) {
      counts.set(row.listingId, Number(row.count));
    }
    return counts;
  }

  private async loadOr404(id: string): Promise<BarterListing> {
    const listing = await this.listings.findOne({ where: { id } });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    return listing;
  }

  private async loadOwnedOr403(
    id: string,
    ownerId: string,
  ): Promise<BarterListing> {
    const listing = await this.loadOr404(id);
    if (listing.ownerId !== ownerId) {
      throw new ForbiddenException(
        'Only the poster can see proposals on this listing',
      );
    }
    return listing;
  }

  private async memberRefFor(userId: string): Promise<MemberRef | null> {
    const refs = await new MemberLookup(this.profiles).byUserIds([userId]);
    return refs.get(userId) ?? null;
  }

  /**
   * ownerId -> the card's owner ref (hood included), in ONE query for the
   * whole batch however many cards are on the page.
   *
   * Deliberately NOT `MemberLookup.byUserIds`: that hands back the shared
   * `MemberRef`, which carries no neighbourhood, so adding `hood` on top of it
   * would mean re-reading each owner's profile — an N+1 across the entire
   * board. The profile rows are read once here and both the ref and its
   * `hoodVisible`-gated hood are mapped off the same row (see
   * `toBarterMemberRef`). Same query count as before, one field richer.
   */
  private async ownerRefs(
    userIds: string[],
  ): Promise<Map<string, BarterMemberRef>> {
    const refs = new Map<string, BarterMemberRef>();
    const uniqueIds = [...new Set(userIds)];
    if (!uniqueIds.length) return refs;

    const rows = await this.profiles.find({
      where: { userId: In(uniqueIds) },
    });
    for (const row of rows) {
      const ref = toBarterMemberRef(row);
      if (ref) refs.set(row.userId, ref);
    }
    return refs;
  }

  /** Single-owner convenience over `ownerRefs`. */
  private async ownerRefFor(userId: string): Promise<BarterMemberRef | null> {
    const refs = await this.ownerRefs([userId]);
    return refs.get(userId) ?? null;
  }
}
