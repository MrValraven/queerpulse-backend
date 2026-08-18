import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { MemberLookup } from '../common/member-ref';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { ListingClaimDTO, toListingClaimDTO } from './listing-claim-response';
import {
  ListingClaim,
  ListingClaimStatus,
} from './entities/listing-claim.entity';
import { Listing } from './entities/listing.entity';

/**
 * "Claim this existing listing" — a member's request to take ownership of a
 * listing they don't currently own (spec item #13's counterpart to
 * `dispute`), landing in a moderator-reviewable queue. Kept as its own
 * service (not folded into `ListingsService`), the same call
 * `ListingEditSuggestionsService` already makes for a distinct sub-entity
 * with its own resolution model and no overlap with the listing CRUD/
 * moderation methods there. Mirrors `JoinRequestsService`'s
 * transaction/conditional-claim shape for `review` (`membership` being the
 * closest precedent for "member submits, moderator reviews, approval mutates
 * a related record atomically").
 */
@Injectable()
export class ListingClaimsService {
  constructor(
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
    @InjectRepository(ListingClaim)
    private readonly claims: Repository<ListingClaim>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * A member requests ownership of an existing listing they don't currently
   * own. Rejects a self-claim on a listing the caller already owns. Dedupes
   * on a repeat call while a claim is still open — mirrors
   * `ReportsService.create`'s "return the existing open one" behavior — so a
   * member spamming the button doesn't pile rows on the mods' desk; the
   * partial unique index `UQ_listing_claims_pending_claimant` is the real
   * backstop against the same check-then-insert race `ReportsService.create`
   * documents.
   */
  async requestClaim(
    ref: string,
    claimantId: string,
    note?: string,
  ): Promise<ListingClaimDTO> {
    const listing = await this.loadOr404(ref);

    if (listing.ownerId === claimantId) {
      throw new BadRequestException('You already own this listing');
    }

    const existing = await this.findOpenClaim(listing.id, claimantId);
    if (existing) {
      return this.buildDTO(existing, listing);
    }

    try {
      const saved = await this.claims.save(
        this.claims.create({
          listingId: listing.id,
          claimantId,
          note: note ?? null,
          status: ListingClaimStatus.Pending,
        }),
      );
      return this.buildDTO(saved, listing);
    } catch (error) {
      // Lost the insert race against a concurrent identical request — the
      // partial unique index rejected the duplicate open claim. Converge on
      // the same idempotent outcome as the pre-check above.
      if (isUniqueViolation(error, 'UQ_listing_claims_pending_claimant')) {
        const winner = await this.findOpenClaim(listing.id, claimantId);
        if (winner) {
          return this.buildDTO(winner, listing);
        }
      }
      throw error;
    }
  }

  /** Moderator/admin-only: every pending claim, oldest first — the review
   * queue. Bounded like `ListingEditSuggestionsService.listForAdmin` so it
   * can never dump an unbounded table. Resolves every distinct listing/
   * claimant in ONE batched lookup each, never N+1. */
  async listPending(): Promise<ListingClaimDTO[]> {
    const rows = await this.claims.find({
      where: { status: ListingClaimStatus.Pending },
      order: { createdAt: 'ASC' },
      take: DEFAULT_LIST_LIMIT,
    });
    if (!rows.length) return [];

    const listingIds = [...new Set(rows.map((row) => row.listingId))];
    const listingRows = await this.listings.find({
      where: { id: In(listingIds) },
    });
    const listingById = new Map(
      listingRows.map((listing) => [listing.id, listing]),
    );

    const claimantIds = rows
      .map((row) => row.claimantId)
      .filter((id): id is string => id !== null);
    const refs = await new MemberLookup(this.profiles).byUserIds(claimantIds);

    // A claim whose listing has since been hard-deleted has nothing left to
    // render a queue row against — skip it rather than throw (mirrors
    // `ListingEditSuggestionsService.listForAdmin`'s identical precedent;
    // `listingId` deliberately carries no FK, so this can happen in practice).
    return rows
      .map((row): ListingClaimDTO | null => {
        const listing = listingById.get(row.listingId);
        if (!listing) return null;
        return toListingClaimDTO(
          row,
          listing,
          row.claimantId ? (refs.get(row.claimantId) ?? null) : null,
        );
      })
      .filter((dto): dto is ListingClaimDTO => dto !== null);
  }

  /**
   * Moderator/admin-only: approve or decline a pending claim. The listing's
   * `ownerId` reassignment (on approval) happens BEFORE the conditional
   * claim-status UPDATE — mirrors `JoinRequestsService.review`'s "mint a
   * related record on approval, before the status flip" ordering — and the
   * whole thing runs in one transaction, so a losing concurrent reviewer's
   * ownership reassignment rolls back along with everything else once its own
   * conditional UPDATE affects zero rows.
   */
  async review(
    id: string,
    reviewerId: string,
    decision: 'approved' | 'declined',
  ): Promise<ListingClaimDTO> {
    // `decision` mirrors `ReviewListingClaimDto`'s plain string-literal shape
    // (`TriageJoinRequestDto`'s precedent); `ListingClaimStatus` shares the
    // same underlying string values, so this is the one place the two are
    // reconciled.
    const status =
      decision === 'approved'
        ? ListingClaimStatus.Approved
        : ListingClaimStatus.Declined;

    const result = await this.dataSource.transaction(async (manager) => {
      const claimsRepo = manager.getRepository(ListingClaim);
      const current = await claimsRepo.findOne({ where: { id } });
      if (!current) {
        throw new NotFoundException('Listing claim not found');
      }
      if (current.status !== ListingClaimStatus.Pending) {
        throw new ConflictException('This claim has already been reviewed');
      }

      const listingsRepo = manager.getRepository(Listing);
      const listing = await listingsRepo.findOne({
        where: { id: current.listingId },
      });
      if (!listing) {
        throw new NotFoundException('The claimed listing no longer exists');
      }

      if (status === ListingClaimStatus.Approved) {
        if (!current.claimantId) {
          throw new BadRequestException(
            'The claimant no longer has an account',
          );
        }
        listing.ownerId = current.claimantId;
        await listingsRepo.save(listing);
      }

      const reviewedAt = new Date();
      // Conditional claim: only the reviewer who flips it out of pending
      // wins; a concurrent reviewer sees affected === 0 and is rejected — the
      // transaction then rolls back the owner reassignment above too.
      const claimUpdate = await claimsRepo.update(
        { id, status: ListingClaimStatus.Pending },
        { status, reviewedBy: reviewerId, reviewedAt },
      );
      if (claimUpdate.affected !== 1) {
        throw new ConflictException('This claim has already been reviewed');
      }
      current.status = status;
      current.reviewedBy = reviewerId;
      current.reviewedAt = reviewedAt;

      return {
        dto: toListingClaimDTO(current, listing, null),
        claimantId: current.claimantId,
        listingSlug: listing.slug,
      };
    });

    // Sent AFTER the transaction has committed, never inside it — mirrors
    // `JoinRequestsService.review`'s identical post-commit notify ordering.
    // Best-effort: the review has already happened by the time this runs.
    if (result.claimantId) {
      await this.notifyClaimantBestEffort(
        result.claimantId,
        result.dto.status,
        result.listingSlug,
      );
    }

    return result.dto;
  }

  /** Best-effort notification for a just-reviewed claim (mirrors
   * `ListingsService.notifyApprovedBestEffort`'s no-actor, never-throw
   * shape — the platform is telling the claimant about their own claim). */
  private async notifyClaimantBestEffort(
    claimantId: string,
    status: ListingClaimStatus,
    listingSlug: string,
  ): Promise<void> {
    try {
      await this.notifications.create(
        claimantId,
        status === ListingClaimStatus.Approved
          ? NotificationType.ListingClaimApproved
          : NotificationType.ListingClaimDeclined,
        { source: 'listing', listingSlug },
      );
    } catch {
      // Intentionally ignored — the review already committed.
    }
  }

  private async findOpenClaim(
    listingId: string,
    claimantId: string,
  ): Promise<ListingClaim | null> {
    return this.claims.findOne({
      where: {
        listingId,
        claimantId,
        status: ListingClaimStatus.Pending,
      },
    });
  }

  private buildDTO(claim: ListingClaim, listing: Listing): ListingClaimDTO {
    return toListingClaimDTO(claim, listing, null);
  }

  /** Mirrors `ListingsService.loadOr404` exactly — kept as a local copy
   * rather than a shared import, same as `ListingEditSuggestionsService`'s
   * identical precedent. */
  private async loadOr404(ref: string): Promise<Listing> {
    const listing = await this.listings.findOne({ where: { ref } });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    return listing;
  }
}
