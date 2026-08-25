import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { MemberLookup } from '../common/member-ref';
import { MessagingService } from '../messaging/messaging.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { ListingClaimDTO, toListingClaimDTO } from './listing-claim-response';
import {
  ListingClaim,
  ListingClaimStatus,
} from './entities/listing-claim.entity';
import {
  ListingModerationAction,
  ListingModerationEvent,
} from './entities/listing-moderation-event.entity';
import { Listing } from './entities/listing.entity';
import { ListingCoManagersService } from './listing-co-managers.service';

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
  private readonly logger = new Logger(ListingClaimsService.name);

  constructor(
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
    @InjectRepository(ListingClaim)
    private readonly claims: Repository<ListingClaim>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    // Read-only: distinguishes a listing parked on the house/seed account from
    // one a real member owns (`assertClaimable`).
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    // Tells the OUTGOING owner their listing changed hands. There is no
    // notification type for an ownership transfer, and adding one would mean
    // editing the notifications domain, so this reuses the same cold-contact DM
    // seam `ListingsService.notifySubmitterBestEffort` already uses to reach a
    // listing's submitter from a moderation action.
    private readonly messaging: MessagingService,
    // Clears the listing's co-manager seats inside this service's own transfer
    // transaction (`revokeAllForOwnershipTransfer`). Injected rather than
    // reached through `ListingsService`, which this file does not depend on.
    private readonly coManagers: ListingCoManagersService,
  ) {}

  /**
   * A member requests ownership of an existing listing they don't currently
   * own. Rejects a self-claim on a listing the caller already owns, and
   * (BE-HSG-05) any claim on a listing a REAL member already owns: this flow
   * exists for the unowned entries the directory carries, never as a way to
   * take a live business away from the member running it. See
   * `assertClaimable` for what counts as unowned and why the alternative for
   * everything else is `POST /listings/:ref/dispute`. Dedupes
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

    await this.assertClaimable(listing);

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

  /**
   * The CALLER's own claims, newest first — the other half of telling somebody
   * how long a claim takes. Knowing the turnaround is only useful next to a
   * claim you can actually see, and until now a claimant had nowhere to look:
   * the queue is moderator-only and the filing response was the one and only
   * time they ever saw their claim. Every row carries the published turnaround,
   * the date a decision was promised by, and how many days it has been waiting
   * (see `listing-claim-policy.ts`).
   *
   * `claimant` is left null on every row: the caller IS the claimant, so
   * echoing their own member ref back at them would be noise. Bounded like
   * `listPending`, and one batched listing lookup rather than N+1.
   */
  async listMine(claimantId: string): Promise<ListingClaimDTO[]> {
    const rows = await this.claims.find({
      where: { claimantId },
      order: { createdAt: 'DESC' },
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

    // Same skip-the-orphan posture as `listPending`: `listingId` carries no FK,
    // so a hard-deleted listing leaves a claim with nothing to render against.
    return rows
      .map((row): ListingClaimDTO | null => {
        const listing = listingById.get(row.listingId);
        if (!listing) return null;
        return toListingClaimDTO(row, listing, null);
      })
      .filter((dto): dto is ListingClaimDTO => dto !== null);
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

      const previousOwnerId = listing.ownerId;
      const reassignedAt = new Date();
      if (status === ListingClaimStatus.Approved) {
        if (!current.claimantId) {
          throw new BadRequestException(
            'The claimant no longer has an account',
          );
        }
        // The listing may have changed hands or been claimed by someone else
        // between filing and review, so the eligibility check runs again here
        // against the CURRENT row, inside the transaction. Without it the queue
        // could still be holding a claim filed while the listing was unowned
        // and approve it long after a real member took it over.
        await this.assertClaimable(listing);
        listing.ownerId = current.claimantId;
        // BE-HSG-05: these five columns are the PREVIOUS owner's personal data
        // rather than the business's. `ListingDTO` hands `contactEmail`,
        // `ownerName` and `ownerBio` straight to whoever owns the listing, and
        // `consentOuting`/`consentGuide` are that person's consent decisions,
        // which cannot transfer to somebody else. Cleared so the new owner
        // enters their own rather than inheriting them. (`notify` was cleared
        // here too until it was retired: it is no longer collected or served,
        // so it is deliberately left alone now.)
        listing.contactEmail = '';
        listing.ownerName = '';
        listing.ownerBio = '';
        listing.consentOuting = false;
        listing.consentGuide = false;
        await listingsRepo.save(listing);
        // EVERY CO-MANAGER SEAT GOES, in this same transaction as the
        // reassignment above. A claim is adversarial by definition: it is filed
        // by somebody arguing the listing should be taken off its current
        // owner, and every co-manager on it was chosen by that owner. Carrying
        // them across would hand the contested party a standing team on a page
        // they just lost. The new owner starts clean and re-invites whoever
        // they actually want.
        //
        // Unanswered invitations go too, on the same reasoning: an invitation
        // sent by the previous owner is that owner's decision about who should
        // help run the business, and it has no more claim to survive the
        // transfer than an accepted seat does.
        //
        // Same transaction, and that is the point rather than an
        // implementation detail. A transfer that committed while the previous
        // owner's appointees kept write access would be worse than either
        // outcome on its own, and a losing concurrent reviewer's conditional
        // UPDATE below rolls this back along with everything else.
        const revokedCoManagerCount =
          await this.coManagers.revokeAllForOwnershipTransfer(
            manager,
            listing.id,
            reassignedAt,
          );
        // The audit trail for the transfer, written in the SAME transaction as
        // the reassignment so the two can never disagree. `fromStatus`/
        // `toStatus` stay null: a transfer changes who owns the listing, never
        // its moderation state.
        await manager.save(ListingModerationEvent, {
          listingId: listing.id,
          actorId: reviewerId,
          action: ListingModerationAction.OwnershipTransferred,
          fromStatus: null,
          toStatus: null,
          // The co-manager count rides in the SAME event rather than in a
          // burst of one `co_manager_removed` row per seat: one act, one row.
          // It is a count and never a name, so this reason stays as safe to
          // hold as it was — and it is on nobody's owner-visible allowlist
          // anyway, because it carries the claimant's own note verbatim.
          reason: [
            current.note
              ? `Ownership transferred on an approved claim. Claimant's note: ${current.note}`
              : 'Ownership transferred on an approved claim.',
            revokedCoManagerCount > 0
              ? `${revokedCoManagerCount} co-manager ${
                  revokedCoManagerCount === 1 ? 'seat was' : 'seats were'
                } revoked by the transfer.`
              : 'The listing had no co-managers to revoke.',
          ].join(' '),
        });
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
        listingName: listing.name,
        listingRef: listing.ref,
        // Only set on an approval that actually moved the listing — a decline
        // leaves the previous owner in place, with nothing to tell them.
        displacedOwnerId:
          status === ListingClaimStatus.Approved &&
          previousOwnerId !== current.claimantId
            ? previousOwnerId
            : null,
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
    // BE-HSG-05: the person who just lost the listing is told too. They used to
    // find out only by discovering that `GET/PATCH/DELETE /listings/:ref` had
    // started 403ing.
    if (result.displacedOwnerId) {
      await this.notifyDisplacedOwnerBestEffort(
        reviewerId,
        result.displacedOwnerId,
        result.listingName,
        result.listingRef,
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

  /**
   * Tells the outgoing owner, as a DM from the reviewing moderator, that their
   * listing was reassigned and how to contest it. Sent from the moderator (not
   * the claimant) so the outgoing owner replies to a human who can reverse it,
   * and deliberately WITHOUT naming the claimant: a contested transfer must not
   * hand one member the other's identity.
   *
   * Best-effort and post-commit, mirroring `notifyClaimantBestEffort` above:
   * the review has already committed by the time this runs.
   */
  private async notifyDisplacedOwnerBestEffort(
    reviewerId: string,
    displacedOwnerId: string,
    listingName: string,
    listingRef: string,
  ): Promise<void> {
    try {
      await this.messaging.deliverEnquiry(
        reviewerId,
        displacedOwnerId,
        `Your listing "${listingName}" (${listingRef}) has been transferred to ` +
          `another member after an approved ownership claim, so it no longer ` +
          `appears in your listings. Your contact details and consent settings ` +
          `were cleared from it rather than passed on. If this is wrong, reply ` +
          `here and a moderator will look at it again.`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to notify the displaced owner of listing ${listingRef}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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

  /**
   * BE-HSG-05: a claim may only target a listing nobody is actually running.
   *
   * `Listing.ownerId` is NOT NULL, so "unowned" is a product state rather than
   * a null: it is either a listing somebody else SUGGESTED (`path === 'suggest'`)
   * or one submitted as a "friendly" recommendation rather than an ownership
   * claim (`badge === 'friendly'`) — the exact two cases
   * `ListingsService.enqueueOwnerNotifyIfNeeded` already files an owner-outreach
   * task for, precisely so the named business can come and claim the entry — or
   * a listing parked on a non-human platform account (`users.is_system`, the
   * house account seeded content is attributed to). A listing whose owner row
   * has since been erased is treated as unowned too.
   *
   * Everything else has a member behind it, and approving a claim on it hands
   * an attacker that member's listing, its reviews, its ref and the personal
   * fields on it. That is a dispute, not a claim: `POST /listings/:ref/dispute`
   * files one through the report pipeline, where a moderator investigates
   * rather than reassigns with one click.
   */
  private async assertClaimable(listing: Listing): Promise<void> {
    // Checked FIRST, and it overrides everything below: once a claim on this
    // listing has been approved, the listing has found its real owner and is
    // closed to further claims. `path`/`badge` are the SUBMITTER's description
    // of the entry and are never rewritten by a transfer, so without this a
    // listing that started as a suggestion would stay permanently claimable and
    // the second claimant would take it from the business that just claimed it.
    const alreadyTransferred = await this.claims.exists({
      where: { listingId: listing.id, status: ListingClaimStatus.Approved },
    });
    if (!alreadyTransferred) {
      // Somebody else suggested this business, or recommended it as "friendly"
      // rather than claiming to run it. Both are exactly the cases
      // `ListingsService.enqueueOwnerNotifyIfNeeded` files an owner-outreach
      // task for, so that the named business can come and claim the entry.
      if (listing.path === 'suggest' || listing.badge === 'friendly') return;

      // Parked on a non-human platform account (the house account seeded
      // content is attributed to), or on an account that has since been erased.
      const owner = await this.users.findOne({
        where: { id: listing.ownerId },
        select: { id: true, isSystem: true },
      });
      if (!owner || owner.isSystem) return;
    }

    throw new BadRequestException(
      'This listing already has an owner. If it is wrong or misrepresents ' +
        'you, file a dispute instead and a moderator will look into it.',
    );
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
