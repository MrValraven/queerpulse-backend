import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { IdentityKind } from '../identities/entities/identity.entity';
import {
  IdentityMailboxSyncService,
  MailboxSeatChanges,
} from '../identities/identity-mailbox-sync.service';
import { IdentitiesService } from '../identities/identities.service';
import { Listing } from './entities/listing.entity';
import {
  ListingModerationAction,
  ListingModerationEvent,
} from './entities/listing-moderation-event.entity';
import {
  ListingOwnerOffer,
  ListingOwnerOfferStatus,
} from './entities/listing-owner-offer.entity';
import { ListingCoManagersService } from './listing-co-managers.service';

export interface OwnershipTransferResult {
  previousOwnerId: string | null;
  revokedCoManagerCount: number;
  /** What the mailbox reconcile changed, held back until the caller's
   * transaction commits. The caller passes this result to
   * `emitTransferChanges` once its own `dataSource.transaction(...)` call has
   * resolved. */
  seatChanges: MailboxSeatChanges;
}

/**
 * The one place a listing changes hands.
 *
 * Both routes into ownership call this: a moderator approving a member's
 * claim, and a member accepting an offer an admin extended. Keeping the
 * mechanics here is what stops the two drifting, because the personal-field
 * clearing and the audit row are easy to forget on a second path.
 */
@Injectable()
export class ListingOwnershipService {
  constructor(
    @InjectRepository(Listing)
    private readonly listings: Repository<Listing>,
    private readonly coManagers: ListingCoManagersService,
    // Resolves the listing's mailbox identity and reconciles its seats
    // against the fresh staff set once ownership has moved, so an appointee
    // whose seat provenance says they leave with the previous owner does not
    // keep reading customer conversation after `revokeAllForOwnershipTransfer`
    // has already ended their `listing_co_managers` row.
    private readonly identities: IdentitiesService,
    private readonly identityMailboxSync: IdentityMailboxSyncService,
  ) {}

  /**
   * Hand `listing` to `newOwnerId`, inside the caller's transaction.
   *
   * `manager` joins the caller's transaction the way
   * `revokeAllForOwnershipTransfer` already does, so a failure anywhere in
   * the caller rolls the transfer back with it. The listing save goes through
   * `manager.withRepository` for exactly that reason: the reassignment, the
   * seat revocations and the audit row commit together or roll back together.
   *
   * `reasonPrefix` opens the audit row's reason. The caller owns that
   * sentence because only it knows what happened: a claim embeds the
   * claimant's verbatim note, while an offer carries a fixed sentence of its
   * own.
   *
   * Three writes ride along with the reassignment, all inside `manager`: the
   * co-manager seats go, any open owner offer is swept (see
   * `sweepOpenOwnerOffers`), and the audit row is written.
   */
  async transferOwnership(
    manager: EntityManager,
    listing: Listing,
    newOwnerId: string,
    actorId: string,
    reasonPrefix: string,
    transferredAt: Date,
  ): Promise<OwnershipTransferResult> {
    const previousOwnerId = listing.ownerId;

    // The personal fields belong to whoever holds the listing, so they leave
    // with the previous holder. `notify` is a retired column and stays as is.
    listing.ownerId = newOwnerId;
    listing.contactEmail = '';
    listing.ownerName = '';
    listing.ownerBio = '';
    listing.consentOuting = false;
    listing.consentGuide = false;
    await manager.withRepository(this.listings).save(listing);

    // Every transfer runs the same revoke. Which seats actually go is decided
    // by their provenance inside `revokeAllForOwnershipTransfer`: a seat an
    // owner appointed leaves with that owner, and a seat staff attached to an
    // unowned listing stays, because it was put there for the incoming owner.
    // Whether `previousOwnerId` is set is the wrong question to ask here, as
    // an erased owner leaves a null `ownerId` behind together with all of
    // their appointees.
    const revokedCoManagerCount =
      await this.coManagers.revokeAllForOwnershipTransfer(
        manager,
        listing.id,
        transferredAt,
      );

    // Reconcile the mailbox against the fresh staff set, in this same
    // transaction so it reads the ownership reassignment and the seat
    // revocations above as already applied. `resyncMailbox` reads BOTH sides
    // through `manager`: the staff set (`IdentitiesService.staffUserIds`
    // with `{ manager }`) and the seats. A staff read on its own pool
    // connection would see the pre-transfer owner and appointees, end
    // nobody's seat and seat nobody new. This call recomputes the staff
    // set from source, so it needs no branch for the ownerless-listing case:
    // `IdentitiesService.staffUserIds` already returns the owner plus every
    // active co-manager, whatever that set happens to be.
    //
    // Running this BEFORE `sweepOpenOwnerOffers` below is safe regardless:
    // `staffUserIds` is computed from `listings.owner_id` and
    // `listing_co_managers` alone, and never reads `listing_owner_offers`,
    // so the sweep below has nothing this call could see stale.
    const listingIdentity = await this.identities.ensureIdentityFor(
      IdentityKind.Listing,
      listing.id,
    );
    //
    // Emission is deferred. This call rides the caller's still-open
    // transaction, so an immediate emit would tell sockets about seat
    // endings, claim releases and staffing changes that a rollback can still
    // undo, and the claim-release audience would be read outside the
    // transaction, while the old owner's seat still looks live. The changes
    // come back on the result, and the caller sends them through
    // `emitTransferChanges` after its transaction commits.
    const seatChanges = await this.identityMailboxSync.resyncMailbox(
      listingIdentity.id,
      manager,
      { shouldDeferEmission: true },
    );

    // The swept count comes back and is deliberately left here. It does NOT
    // join the audit reason: the three seat sentences below are the exact
    // strings the claim path has written since `ownership_transferred` was
    // introduced, and they are read as history, so a fourth clause would
    // change what the older rows appear to say. A caller that wants the
    // number can have it from this method's return.
    await this.sweepOpenOwnerOffers(manager, listing.id, transferredAt);

    // The seat sentence keeps the exact grammar the claim path has written
    // since the audit action was introduced, so the history reads the same
    // either side of this extraction.
    const seatSentence =
      revokedCoManagerCount > 0
        ? `${revokedCoManagerCount} co-manager ${
            revokedCoManagerCount === 1 ? 'seat was' : 'seats were'
          } revoked by the transfer.`
        : 'The listing had no co-managers to revoke.';

    // The audit trail for the transfer, written in the SAME transaction as
    // the reassignment so the two can never disagree. `fromStatus`/`toStatus`
    // stay null, because a transfer changes who owns the listing and leaves
    // its moderation state alone.
    await manager.save(ListingModerationEvent, {
      listingId: listing.id,
      actorId,
      action: ListingModerationAction.OwnershipTransferred,
      fromStatus: null,
      toStatus: null,
      reason: [reasonPrefix, seatSentence].join(' '),
    });

    return { previousOwnerId, revokedCoManagerCount, seatChanges };
  }

  /**
   * Sends what a transfer's mailbox reconcile changed: the room evictions,
   * the claim releases and the staffing changes. Call it only after the
   * transaction `transferOwnership` rode in has committed, so a rolled-back
   * transfer tells nobody anything.
   */
  emitTransferChanges(result: OwnershipTransferResult): void {
    this.identityMailboxSync.emitSeatChanges(result.seatChanges);
  }

  /**
   * Close any owner offer still sitting at `offered` on a listing that has
   * just changed hands, in the caller's transaction.
   *
   * WHY THE SWEEP EXISTS. A claim approval reassigns `owner_id` without ever
   * touching `listing_owner_offers`, so an offer extended before the claim
   * landed stays open forever. Two things go wrong while it sits there. The
   * partial unique index `UQ_listing_owner_offers_open` permits one `offered`
   * row per listing, so the dead row keeps the slot and every later offer on
   * that listing is refused. And if `owner_id` returns to NULL later through
   * owner erasure, that row becomes acceptable again, handing the listing to
   * somebody who was offered it under circumstances that no longer hold.
   *
   * WHY THE ACCEPT PATH IS SAFE. `ListingOwnerOffersService.respond` flips
   * its own row to `accepted` BEFORE it calls `transferOwnership`, so the row
   * being accepted is out of `offered` by the time this runs and the
   * predicate below skips it. A competing offer to a different member, still
   * at `offered`, is exactly what should be closed.
   *
   * The repository comes from `manager.getRepository` directly.
   * `ListingOwnerOffersService` already injects this service, so taking that
   * dependency back would close a cycle, and it would buy only a method whose
   * fast-path checks do not apply here.
   *
   * No moderation event and no notification. Nothing about the offer's
   * subject changed for the member holding it beyond the listing finding an
   * owner, and telling somebody they have lost something they never opened is
   * the same silence `revoke` keeps for the same reason.
   */
  private async sweepOpenOwnerOffers(
    manager: EntityManager,
    listingId: string,
    sweptAt: Date,
  ): Promise<number> {
    const result = await manager.getRepository(ListingOwnerOffer).update(
      { listingId, status: ListingOwnerOfferStatus.Offered },
      {
        status: ListingOwnerOfferStatus.Revoked,
        respondedAt: sweptAt,
      },
    );
    return result.affected ?? 0;
  }
}
