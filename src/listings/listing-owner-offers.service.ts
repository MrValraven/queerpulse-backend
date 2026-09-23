import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { CreateListingOwnerOfferDto } from './dto/create-listing-owner-offer.dto';
import {
  ListingOwnerOffer,
  ListingOwnerOfferStatus,
} from './entities/listing-owner-offer.entity';
import { Listing } from './entities/listing.entity';
import {
  ListingOwnerOfferDTO,
  toListingOwnerOfferDTO,
} from './listing-owner-offer-response';
import {
  ListingOwnershipService,
  OwnershipTransferResult,
} from './listing-ownership.service';

/** The partial unique index from `ListingOwnerOffer`, which permits one row at
 * `offered` per listing. Named here so the catch below distinguishes a lost
 * race for the open-offer slot from any other unique violation. */
const OPEN_OFFER_UNIQUE_INDEX = 'UQ_listing_owner_offers_open';

const ALREADY_OWNED_MESSAGE =
  'This listing already has an owner, so it cannot be offered. Use a claim or a dispute instead.';

const OPEN_OFFER_MESSAGE =
  'This listing already has an open offer. Revoke it before offering to somebody else.';

const ALREADY_ANSWERED_MESSAGE = 'This offer has already been answered';

const CLAIMED_SINCE_MESSAGE =
  'This listing has been claimed by somebody else since the offer was made, so it can no longer be accepted. Decline it to clear it from your list.';

/**
 * Admin-authored listings and the offer that hands one to the member who runs
 * the place: staff nominate, the member accepts or declines.
 *
 * WHY THE OFFER EXISTS AT ALL. Staff can write a listing for a queer venue
 * that has never heard of QueerPulse, which is how the directory gets useful
 * before the businesses arrive. What staff cannot do is put somebody's name
 * on a public page about a queer business without asking. So ownership is
 * never written when the listing is authored. The row sits at `offered` until
 * the member answers, and only their accept reaches `listings.owner_id`.
 *
 * SIBLING OF `ListingCoManagersService.invite` / `respondToInvite`, and
 * deliberately shaped the same way: a terminal row is reused on a re-offer,
 * the flip is a conditional UPDATE so a double-tap cannot resolve an offer
 * twice, and the member's response is scoped by `{ id, offereeId }` so an
 * offer addressed to somebody else 404s. Where the two differ is who may act
 * and what an accept grants. An invitation comes from an owner and grants a
 * seat; an offer comes from staff and grants the listing itself.
 *
 * THE OWNERSHIP WRITE LIVES IN `ListingOwnershipService`. This service never
 * touches `listings.owner_id`. `respond` calls `transferOwnership` inside its
 * own transaction, so the reassignment, the cleared personal fields and the
 * `ownership_transferred` audit row are identical to the claim-approval path
 * and roll back with the offer if anything after them fails.
 *
 * Kept as its own service for the reason `ListingClaimsService` and
 * `ListingCoManagersService` are: it owns a table `ListingsService` does not,
 * and `ListingsService` is already the largest class in the domain. It follows
 * the same file-local `loadOr404` copy convention those services document.
 */
@Injectable()
export class ListingOwnerOffersService {
  private readonly logger = new Logger(ListingOwnerOffersService.name);

  constructor(
    @InjectRepository(ListingOwnerOffer)
    private readonly offers: Repository<ListingOwnerOffer>,
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly ownership: ListingOwnershipService,
    private readonly notifications: NotificationsService,
    private readonly dataSource: DataSource,
  ) {}

  // ---------------------------------------------------------------------------
  // Staff side.
  // ---------------------------------------------------------------------------

  /**
   * STAFF ONLY: nominate `dto.memberSlug` as the owner of an unowned listing.
   *
   * Refuses a listing that already has an owner. Moving a business away from
   * the person holding it is what claims and disputes are for, both of which
   * are reviewed and leave a trail; a one-step staff reassignment would be a
   * quieter way to do the same thing. That check runs twice: once here for a
   * fast 409, and again on the row held by the lock below, which is the one
   * that decides. `respond` re-checks it a third time, because an offer can
   * sit open for days while the listing changes hands elsewhere.
   *
   * ONE OPEN OFFER PER LISTING, enforced by the partial unique index. A count
   * would be the wrong tool: under READ COMMITTED two concurrent offers would
   * both read zero and both write. The `pessimistic_write` lock on the listing
   * row serialises the terminal-row reuse below against a second offer to the
   * SAME member; the index is what answers a second offer to a DIFFERENT one,
   * and its violation comes back as the same 409 either way.
   */
  async offer(
    ref: string,
    adminUserId: string,
    dto: CreateListingOwnerOfferDto,
  ): Promise<ListingOwnerOfferDTO> {
    const listing = await this.loadByRefOr404(ref);
    if (listing.ownerId !== null) {
      throw new ConflictException(ALREADY_OWNED_MESSAGE);
    }

    const lookup = new MemberLookup(this.profiles);
    const offereeId = await lookup.userIdForSlug(dto.memberSlug);
    if (!offereeId) {
      throw new NotFoundException('Member not found');
    }

    const offeredAt = new Date();
    const offer = await this.insertOrReuseOffer(
      listing.id,
      offereeId,
      adminUserId,
      dto.note ?? null,
      offeredAt,
    );

    // Post-commit and best effort, the module's standing pattern for every
    // secondary write. A failed notification is swallowed: the offer has
    // committed and shows up on the member's offers list either way.
    await this.notifyBestEffort(
      offereeId,
      NotificationType.ListingOwnerOffer,
      {
        actorId: adminUserId,
        source: 'listing',
        listingSlug: listing.slug,
        listingName: listing.name,
      },
      adminUserId,
    );

    return this.toDTO(offer, listing);
  }

  /**
   * STAFF ONLY: withdraw the open offer on a listing.
   *
   * The UPDATE is conditional on the row still being `offered`, so a revoke
   * that races the member's own accept loses cleanly with `affected === 0`
   * and 404s, and the accept that already landed keeps the listing.
   *
   * No notification. A revoked offer the member never opened is not news, and
   * telling somebody they have just lost something they did not know they had
   * is worse than silence.
   */
  async revoke(
    ref: string,
    adminUserId: string,
  ): Promise<ListingOwnerOfferDTO> {
    const listing = await this.loadByRefOr404(ref);
    const openOffer = await this.offers.findOne({
      where: { listingId: listing.id, status: ListingOwnerOfferStatus.Offered },
    });
    if (!openOffer) {
      throw new NotFoundException('No open offer on this listing');
    }

    const respondedAt = new Date();
    const updated = await this.offers.update(
      { id: openOffer.id, status: ListingOwnerOfferStatus.Offered },
      { status: ListingOwnerOfferStatus.Revoked, respondedAt },
    );
    if (updated.affected !== 1) {
      throw new NotFoundException('No open offer on this listing');
    }
    openOffer.status = ListingOwnerOfferStatus.Revoked;
    openOffer.respondedAt = respondedAt;

    // A revoke writes no moderation event, because nothing about the listing
    // changed. This line is the only record of which staff member withdrew
    // the offer, so it names them.
    this.logger.log(
      `Staff ${adminUserId} revoked the open owner offer on listing ${listing.ref}`,
    );

    return this.toDTO(openOffer, listing);
  }

  /**
   * STAFF: the open offer on a listing, or `null` when it has none.
   *
   * The delegation panel needs this on a cold open. Without it an admin can
   * only see an offer they extended in the same session, from their own
   * mutation result, and an offer sent yesterday stays invisible until they
   * try to send a second one and are handed the open-offer 409.
   *
   * A SINGLE VALUE, and the return type says so. The partial unique index
   * `UQ_listing_owner_offers_open` permits one row at `offered` per listing,
   * so an array would be inviting every caller to handle a case the database
   * forbids.
   *
   * `null` WITH A 200, because having no open offer is the ordinary state of
   * almost every listing in the directory. A 404 here would make the normal
   * case read as an error and leave the caller unable to tell it apart from
   * a `ref` that does not exist, which is the one thing this method does
   * raise 404 for, through `loadByRefOr404`.
   *
   * Mapped through the same `toDTO` the write paths use, so a panel that has
   * rendered the POST response can render this without a second shape.
   */
  async findOpenForListing(ref: string): Promise<ListingOwnerOfferDTO | null> {
    const listing = await this.loadByRefOr404(ref);
    const openOffer = await this.offers.findOne({
      where: { listingId: listing.id, status: ListingOwnerOfferStatus.Offered },
    });
    if (!openOffer) return null;
    return this.toDTO(openOffer, listing);
  }

  // ---------------------------------------------------------------------------
  // Member side.
  // ---------------------------------------------------------------------------

  /** Every open offer addressed to this member, newest first. */
  async listForMember(userId: string): Promise<ListingOwnerOfferDTO[]> {
    const offers = await this.offers.find({
      where: { offereeId: userId, status: ListingOwnerOfferStatus.Offered },
      order: { offeredAt: 'DESC' },
    });
    if (!offers.length) return [];

    // Two batched lookups total: the listings the offers are about, and the
    // members involved. One query per row is what this shape exists to avoid.
    const listings = await this.listings.find({
      where: { id: In(offers.map((offer) => offer.listingId)) },
    });
    const listingById = new Map(
      listings.map((listing) => [listing.id, listing]),
    );
    const refs = await new MemberLookup(this.profiles).byUserIds([
      userId,
      ...offers
        .map((offer) => offer.offeredByUserId)
        .filter(
          (offeredByUserId): offeredByUserId is string =>
            offeredByUserId !== null,
        ),
    ]);

    return offers
      .map((offer): ListingOwnerOfferDTO | null => {
        const listing = listingById.get(offer.listingId);
        if (!listing) return null;
        return toListingOwnerOfferDTO(
          offer,
          listing,
          refs.get(offer.offereeId) ?? null,
          offer.offeredByUserId
            ? (refs.get(offer.offeredByUserId) ?? null)
            : null,
        );
      })
      .filter((dto): dto is ListingOwnerOfferDTO => dto !== null);
  }

  /**
   * The offered member answers: accept and the listing becomes theirs,
   * decline and the offer ends there.
   *
   * Scoped by `{ id, offereeId }`, so an offer addressed to somebody else
   * comes back as a 404. An offer id would otherwise be an oracle for "which
   * listings is staff trying to give away".
   *
   * THE UNOWNED CHECK RUNS AGAIN HERE, against the listing row as it stands
   * now. An accept can arrive days after the offer, by which time an approved
   * claim may have given the listing to somebody else, and the offer row
   * would know nothing about it.
   *
   * ONE TRANSACTION covers the status flip, the affirming-baseline stamp and
   * the ownership transfer. The flip is CONDITIONAL on the row still being
   * `offered`, which is what settles two concurrent accepts: exactly one sees
   * `affected === 1`, the loser raises 409, and the loser's transaction takes
   * its half-finished ownership write down with it.
   *
   * The new owner and the actor are the SAME person here. A claim is approved
   * by a moderator on the claimant's behalf; an offer is accepted by the
   * member themselves, so they are both the party gaining the listing and the
   * party performing the act that gives it to them.
   */
  async respond(
    offerId: string,
    userId: string,
    isAccepted: boolean,
  ): Promise<ListingOwnerOfferDTO> {
    const respondedAt = new Date();

    const { offer, listing, transfer } = await this.dataSource.transaction(
      async (manager) => {
        const offersRepo = manager.getRepository(ListingOwnerOffer);
        const current = await offersRepo.findOne({
          where: { id: offerId, offereeId: userId },
        });
        if (!current) {
          throw new NotFoundException('Offer not found');
        }
        if (current.status !== ListingOwnerOfferStatus.Offered) {
          throw new ConflictException(ALREADY_ANSWERED_MESSAGE);
        }

        const offeredListing = await manager
          .getRepository(Listing)
          .findOne({ where: { id: current.listingId } });
        if (!offeredListing) {
          throw new NotFoundException('The listing no longer exists');
        }
        // RE-CHECKED against the CURRENT listing row, inside the transaction,
        // for the reason `ListingClaimsService.review` re-runs
        // `assertClaimable` before it approves a claim. The unowned check in
        // `offer` ran days ago, and nothing closes an open offer when a
        // listing changes hands by another route. Without this line an
        // approved claim could be undone by a stale accept, which would take
        // the listing off the member holding it and wipe their contact
        // details. A DECLINE stays allowed: closing a stale offer takes
        // nothing from anybody and clears the row off the member's list.
        if (isAccepted && offeredListing.ownerId !== null) {
          throw new ConflictException(CLAIMED_SINCE_MESSAGE);
        }

        const updated = await offersRepo.update(
          { id: offerId, status: ListingOwnerOfferStatus.Offered },
          {
            status: isAccepted
              ? ListingOwnerOfferStatus.Accepted
              : ListingOwnerOfferStatus.Declined,
            respondedAt,
          },
        );
        if (updated.affected !== 1) {
          throw new ConflictException(ALREADY_ANSWERED_MESSAGE);
        }
        current.status = isAccepted
          ? ListingOwnerOfferStatus.Accepted
          : ListingOwnerOfferStatus.Declined;
        current.respondedAt = respondedAt;

        let transfer: OwnershipTransferResult | null = null;
        if (isAccepted) {
          // Stamped BEFORE the transfer, because `transferOwnership` is what
          // saves the listing row. The baseline is accepted by the person it
          // binds, at the moment they take the listing on, so a staff-authored
          // listing stops being the one row in the table whose acceptance
          // stamp means something different from everybody else's.
          offeredListing.affirmingBaselineAcceptedAt = respondedAt;
          // THE ONLY WRITE TO `listings.owner_id` in this service, shared with
          // the claim-approval path so the personal-field clearing, the
          // co-manager revocation rule and the audit row cannot drift apart.
          transfer = await this.ownership.transferOwnership(
            manager,
            offeredListing,
            userId,
            userId,
            'Ownership accepted from a staff offer.',
            respondedAt,
          );
        }

        return { offer: current, listing: offeredListing, transfer };
      },
    );

    // The transfer's mailbox changes go out only now that the transaction
    // has committed. A rolled-back accept never reaches this line.
    if (transfer) {
      this.ownership.emitTransferChanges(transfer);
    }

    return this.toDTO(offer, listing);
  }

  // ---------------------------------------------------------------------------
  // Internals.
  // ---------------------------------------------------------------------------

  /**
   * Writes the `offered` row, reusing a terminal row for the same
   * `(listing, member)` pair so one pair holds one row across every offer it
   * ever sees.
   *
   * Every field describing the PREVIOUS offer is rewritten, so nothing about
   * the offer that ended can be read back as if it belonged to this one.
   *
   * A lost race for the open-offer slot surfaces as a Postgres unique
   * violation on the partial index, which becomes the same 409 a caller would
   * have got had they arrived second in a quiet moment.
   */
  private async insertOrReuseOffer(
    listingId: string,
    offereeId: string,
    adminUserId: string,
    note: string | null,
    offeredAt: Date,
  ): Promise<ListingOwnerOffer> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const offersRepo = manager.getRepository(ListingOwnerOffer);
        // Serialises concurrent offers on this listing, so the reuse branch
        // below reads a stable row. See the `offer` doc comment.
        //
        // The locked row is BOUND and re-asserted, because the unowned check
        // in `offer` read a row that nothing was holding. Between that read
        // and this lock an approved claim can have handed the listing to a
        // real member, and the guard has to be the one that saw the row
        // nobody else can move.
        const lockedListing = await manager.getRepository(Listing).findOne({
          where: { id: listingId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!lockedListing) {
          throw new NotFoundException('Listing not found');
        }
        if (lockedListing.ownerId !== null) {
          throw new ConflictException(ALREADY_OWNED_MESSAGE);
        }

        const existingOffer = await offersRepo.findOne({
          where: { listingId, offereeId },
        });
        if (existingOffer?.status === ListingOwnerOfferStatus.Offered) {
          throw new ConflictException(OPEN_OFFER_MESSAGE);
        }
        if (existingOffer) {
          existingOffer.status = ListingOwnerOfferStatus.Offered;
          existingOffer.offeredByUserId = adminUserId;
          existingOffer.note = note;
          existingOffer.offeredAt = offeredAt;
          existingOffer.respondedAt = null;
          return offersRepo.save(existingOffer);
        }
        return offersRepo.save(
          offersRepo.create({
            listingId,
            offereeId,
            offeredByUserId: adminUserId,
            note,
            status: ListingOwnerOfferStatus.Offered,
            offeredAt,
            respondedAt: null,
          }),
        );
      });
    } catch (error) {
      if (isUniqueViolation(error, OPEN_OFFER_UNIQUE_INDEX)) {
        throw new ConflictException(OPEN_OFFER_MESSAGE);
      }
      throw error;
    }
  }

  /** One offer plus the two member refs it displays. The list path resolves
   * its refs in a single batch of its own and calls the mapper directly. */
  private async toDTO(
    offer: ListingOwnerOffer,
    listing: Listing,
  ): Promise<ListingOwnerOfferDTO> {
    const userIds = [offer.offereeId];
    if (offer.offeredByUserId) userIds.push(offer.offeredByUserId);
    const refs: Map<string, MemberRef> = await new MemberLookup(
      this.profiles,
    ).byUserIds(userIds);
    return toListingOwnerOfferDTO(
      offer,
      listing,
      refs.get(offer.offereeId) ?? null,
      offer.offeredByUserId ? (refs.get(offer.offeredByUserId) ?? null) : null,
    );
  }

  private async notifyBestEffort(
    recipientUserId: string,
    type: NotificationType,
    payload: Record<string, unknown>,
    actorId: string,
  ): Promise<void> {
    try {
      await this.notifications.create(recipientUserId, type, payload, actorId);
    } catch (error) {
      this.logger.warn(
        `Failed to send ${type} notification: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * This service's own copy of the by-`ref` load, matching the file-local
   * `loadOr404` convention `ListingCoManagersService` and
   * `ListingClaimsService` each document. No ownership is folded into the
   * query: the routes that reach here are staff routes, and the listing they
   * address is by definition one nobody owns yet.
   */
  private async loadByRefOr404(ref: string): Promise<Listing> {
    const listing = await this.listings.findOne({ where: { ref } });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    return listing;
  }
}
