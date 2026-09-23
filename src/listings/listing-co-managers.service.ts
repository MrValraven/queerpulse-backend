import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentityMailboxSyncService } from '../identities/identity-mailbox-sync.service';
import { IdentitiesService } from '../identities/identities.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { InviteListingCoManagerDto } from './dto/invite-listing-co-manager.dto';
import {
  LIVE_LISTING_CO_MANAGER_STATUSES,
  ListingCoManager,
  ListingCoManagerStatus,
} from './entities/listing-co-manager.entity';
import {
  ListingModerationAction,
  ListingModerationEvent,
} from './entities/listing-moderation-event.entity';
import { Listing } from './entities/listing.entity';
import {
  ListingCoManagerDTO,
  ListingCoManagerInviteDTO,
  toListingCoManagerDTO,
  toListingCoManagerInviteDTO,
} from './listing-co-manager-response';

/** How a seat that was ACTIVE came to an end. Decides the `reason` sentence on
 * the `co_manager_removed` event and which member is recorded as the actor. */
type CoManagerRemovalKind = 'revoked' | 'left';

/**
 * Co-manager seats on a business directory listing: invite, accept, decline,
 * revoke, leave, and the access predicate the rest of the module gates on.
 *
 * SIBLING OF `community_members.role = 'co_owner'`, ON PURPOSE. Communities hit
 * this problem first and answered it the same way: a second person gets
 * day-to-day powers inside one community without ever being written into
 * `communities.owner_id`, and only the owner may grant or revoke that role. The
 * two should read as one idea applied twice. Where this one deliberately goes
 * further is consent: a community co-owner is promoted by the owner in one
 * move, whereas a co-manager is INVITED and grants nothing until they accept.
 * A community roster is something the member already joined; a business listing
 * is a public page about a queer venue, and appearing behind it is not a thing
 * that should happen to someone without their say-so.
 *
 * WHAT A CO-MANAGER CAN DO lives in `ListingsService`, not here: this service
 * owns the seat, and `ListingsService.loadOwnedOrCoManagedOr404` is the gate
 * that consults it. The split matters because there are two gates now, and the
 * one that opens a route wider should be the one a reviewer can find.
 *
 * Kept as its own service rather than folded into `ListingsService` for exactly
 * the reason `ListingClaimsService` and `ListingOwnerPendingService` are: it
 * owns a table `ListingsService` does not, and `ListingsService` is already the
 * largest class in the domain. It follows the same file-local `loadOr404` copy
 * convention those services document rather than importing a private helper.
 */
@Injectable()
export class ListingCoManagersService {
  private readonly logger = new Logger(ListingCoManagersService.name);

  /**
   * How many co-manager seats one listing may hold at once, counting both
   * `active` seats and unanswered `invited` ones.
   *
   * FIVE. A business page needs to cover the shapes that actually exist: two
   * co-founders, a manager, whoever handles the socials, and one spare. Above
   * that the number stops describing a team and starts describing a mailing
   * list, and three things get worse at once. The owner-only revoke list is
   * something one person is expected to keep reviewed, and a list nobody reads
   * is not a control. Every seat is a full write path onto a public page about
   * a queer venue, so the cap is also the blast radius of one compromised
   * member account. And an unanswered invitation holds a seat, which is what
   * makes the cap bite on invite spam rather than only on accepted access.
   *
   * The owner is not a seat. A listing tops out at the owner plus five.
   */
  static readonly MAX_CO_MANAGERS_PER_LISTING = 5;

  constructor(
    @InjectRepository(ListingCoManager)
    private readonly coManagers: Repository<ListingCoManager>,
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly notifications: NotificationsService,
    private readonly dataSource: DataSource,
    // Resolves the listing's mailbox identity and keeps its
    // `conversation_participants` seats in step with who currently holds
    // ACCESS here. See `respondToInvite`, where an invitation turns into
    // access, and `endSeat`, where access ends.
    private readonly identities: IdentitiesService,
    private readonly identityMailboxSync: IdentityMailboxSyncService,
  ) {}

  // ---------------------------------------------------------------------------
  // Access predicates — read by `ListingsService` and
  // `ListingOwnerPendingService`, never by a controller directly.
  // ---------------------------------------------------------------------------

  /**
   * Does this member hold an ACTIVE seat on this listing?
   *
   * `active` only. An unanswered invitation is not access, and treating it as
   * access would mean an owner could grant someone write powers over a business
   * page by sending them a notification they never opened.
   *
   * One indexed lookup on `(user_id, status)`, run on the miss path of the
   * ownership check, so an owner's own request never pays for it.
   */
  async isActiveCoManager(listingId: string, userId: string): Promise<boolean> {
    const count = await this.coManagers.count({
      where: { listingId, userId, status: ListingCoManagerStatus.Active },
    });
    return count > 0;
  }

  /** Every listing id this member currently co-manages. Feeds
   * `ListingsService.listMine`, which unions it with the ids they own. */
  async listingIdsCoManagedBy(userId: string): Promise<string[]> {
    const rows = await this.coManagers.find({
      where: { userId, status: ListingCoManagerStatus.Active },
      select: { listingId: true },
    });
    return rows.map((row) => row.listingId);
  }

  /**
   * Clears every live seat on a listing whose ownership has just been
   * reassigned, and reports how many it cleared.
   *
   * Called by `ListingOwnershipService.transferOwnership` INSIDE the caller's
   * existing transaction, so it takes an `EntityManager` and joins that
   * transaction. The revocation and the `owner_id` reassignment must commit or
   * roll back together: a transfer that committed while the previous owner's
   * appointees kept write access would be the worst of both outcomes.
   *
   * WHY EVERY SEAT GOES, including a seat the new owner might have held. A
   * claim is adversarial by definition. It is filed by somebody arguing the
   * listing should be taken off its current owner, and the people sitting on it
   * were chosen by that owner. Carrying them across would hand the contested
   * party a standing team on a page they just lost. The new owner starts clean
   * and re-invites whoever they actually want, which costs them a few clicks
   * and costs nobody their safety.
   *
   * A seat carrying `isStaffAttached` is the one exception, and the reason it
   * is a stored flag: `owner_id` being null cannot tell "staff attached this
   * for the incoming owner" apart from "the owner erased their account", and
   * `SetNullContentAuthorFksOnUserErasure1794610000000` produces the second.
   * An erased owner's appointees therefore still lose their seats here.
   *
   * `Repository.update` returns an `UpdateResult` whose `affected` is the row
   * count. This is the QueryBuilder path, so it is NOT the raw `.query()` shape
   * that hands back `[rows, affectedCount]`; there is no tuple to destructure
   * here.
   */
  async revokeAllForOwnershipTransfer(
    manager: EntityManager,
    listingId: string,
    revokedAt: Date,
  ): Promise<number> {
    const result = await manager.getRepository(ListingCoManager).update(
      {
        listingId,
        status: In([...LIVE_LISTING_CO_MANAGER_STATUSES]),
        // Seats STAFF attached to an unowned listing are spared. They were
        // put there for the incoming owner and exist so the delegation
        // survives the handover, which is the opposite provenance from a seat
        // an owner appointed. See `ListingCoManager.isStaffAttached`.
        isStaffAttached: false,
      },
      { status: ListingCoManagerStatus.Revoked, endedAt: revokedAt },
    );
    return result.affected ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Roster read — owner OR active co-manager.
  // ---------------------------------------------------------------------------

  /**
   * The listing's co-manager roster, live seats first, newest invitation first
   * within each group.
   *
   * Readable by the owner AND by an active co-manager. Reading is not managing:
   * the owner-only rule covers inviting and revoking, and someone who can
   * already edit the page needs to know who else can. Terminal rows (declined,
   * revoked, left) are excluded — the roster answers "who has access", and the
   * record of who used to lives in the listing's history.
   *
   * Not public, and there is no public route that reaches this method.
   */
  async listSeats(
    ref: string,
    actorUserId: string,
  ): Promise<ListingCoManagerDTO[]> {
    return this.listSeatsForListing(
      await this.loadManageableOr404(ref, actorUserId),
    );
  }

  // ---------------------------------------------------------------------------
  // Owner-only writes.
  // ---------------------------------------------------------------------------

  /**
   * OWNER ONLY: invite one active member to co-manage this listing.
   *
   * The whole check sequence, in the order it runs and why that order:
   *
   *  1. The caller owns the listing (`loadOwnedOr404`). A co-manager inviting
   *     another co-manager would let the owner's own appointee grow the team
   *     around them, which is the escalation `CommunitiesService.setMemberRole`
   *     rule 6 forbids for `co_owner` in the same words.
   *  2. The slug resolves to an ACTIVE member. `MemberLookup.userIdForSlug`
   *     joins on `users.status = 'active'`, so a suspended or waitlisted
   *     account resolves to nothing and this 404s.
   *  3. Under a row lock on the listing, reading the LOCKED row: the target
   *     is somebody other than the owner, the seat is free, and the cap has
   *     room. An owner already has strictly more access than a seat would
   *     give them, so a self-invite could only ever be a mistake or a way to
   *     burn a seat, and the ownership it is checked against has to be the
   *     ownership the lock is holding still.
   *
   * Steps 2 and 3 live in `inviteToLoadedListing`, shared with the staff
   * path.
   *
   * The lock is what makes the cap real. Two invitations racing at four seats
   * would both read four under READ COMMITTED and both write, and no constraint
   * would stop them, because the cap is a count rather than a key. Taking a
   * `pessimistic_write` lock on the listing row serialises invitations
   * per-listing, which is the narrowest scope that works and contends with
   * nothing else. The unique constraint stays the backstop for the different
   * race of the same member being invited twice at once.
   */
  async invite(
    ref: string,
    ownerUserId: string,
    dto: InviteListingCoManagerDto,
  ): Promise<ListingCoManagerDTO> {
    const listing = await this.loadOwnedOr404(ref, ownerUserId);
    return this.inviteToLoadedListing(listing, ownerUserId, dto, {
      isStaffInvite: false,
    });
  }

  /**
   * The whole invitation, on a listing the caller has already been cleared
   * for. Both the owner-gated `invite` and the staff-gated
   * `staffInviteCoManager` run through here, so the lock, the cap, the
   * duplicate-seat conflicts and the terminal-row reuse are one body, with
   * one set of invariants that both paths inherit.
   *
   * `isStaffInvite` is the only option. It names the path, and leaves both
   * consequences to be decided inside the transaction from the LOCKED
   * listing row:
   *
   *  - `isStaffAttached` on the seat is `isStaffInvite && ownerId === null`.
   *    The flag records that the listing was UNOWNED at attach time, which is
   *    what `revokeAllForOwnershipTransfer` reads to spare the seat on a
   *    handover. A seat staff attach to a listing that already has an owner
   *    belongs to that owner's arrangement and leaves with them, so it takes
   *    the `false` every member-invited seat takes. A seat outliving every
   *    owner is a platform-steward concept this model does not have; if it is
   *    ever wanted it needs a column of its own.
   *  - the owner may not also hold a seat. An owner already has strictly more
   *    access than a seat gives, so seating them could only be a mistake or a
   *    way to burn one of the five. On the member path the target and the
   *    owner are the caller, which makes it a self-invite guard; on the staff
   *    path the check applies whenever the listing has an owner at all.
   *
   * BOTH ARE READ FROM THE ROW UNDER THE LOCK. The `listing` argument is a
   * pre-transaction snapshot, and a concurrent claim approval or offer
   * accept can reassign `owner_id` between the two reads. Stamping
   * provenance from that stale copy is precisely the race the
   * `pessimistic_write` lock is here to close, so the locked row is bound
   * and its `ownerId` is the one consulted.
   */
  private async inviteToLoadedListing(
    listing: Listing,
    inviterUserId: string,
    dto: InviteListingCoManagerDto,
    options: { isStaffInvite: boolean },
  ): Promise<ListingCoManagerDTO> {
    const invitedUserId = await new MemberLookup(this.profiles).userIdForSlug(
      dto.memberSlug,
    );
    if (!invitedUserId) {
      throw new NotFoundException('Member not found');
    }

    const invitedAt = new Date();
    const seat = await this.dataSource.transaction(async (manager) => {
      const seatsRepo = manager.getRepository(ListingCoManager);
      // Serialises concurrent invitations on this listing so the cap below is
      // counted against a stable set of rows. See `invite`'s doc comment.
      // The row is BOUND, because the two ownership decisions below have to
      // read the value the lock is holding still.
      const lockedListing = await manager.getRepository(Listing).findOne({
        where: { id: listing.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedListing) {
        throw new NotFoundException('Listing not found');
      }
      const ownerIdUnderLock = lockedListing.ownerId;

      // On the member path the caller IS the owner, so this reads as the
      // self-invite guard it has always been. On the staff path it bites
      // whenever the listing has an owner, and a listing with none has
      // nobody to compare against.
      const shouldRejectOwnerAsSeatHolder = options.isStaffInvite
        ? ownerIdUnderLock !== null
        : true;
      if (shouldRejectOwnerAsSeatHolder && invitedUserId === ownerIdUnderLock) {
        throw new BadRequestException(
          options.isStaffInvite
            ? 'That member already owns this listing, so they cannot also hold a co-manager seat on it'
            : 'You already own this listing, so you cannot invite yourself to co-manage it',
        );
      }

      // Unowned AT ATTACH TIME, decided under the lock. See the method doc.
      const isStaffAttached =
        options.isStaffInvite && ownerIdUnderLock === null;

      const existingSeat = await seatsRepo.findOne({
        where: { listingId: listing.id, userId: invitedUserId },
      });
      if (existingSeat?.status === ListingCoManagerStatus.Active) {
        throw new ConflictException(
          'That member already co-manages this listing',
        );
      }
      if (existingSeat?.status === ListingCoManagerStatus.Invited) {
        throw new ConflictException(
          'That member already has an unanswered invitation to co-manage this listing',
        );
      }

      const liveSeatCount = await seatsRepo.count({
        where: {
          listingId: listing.id,
          status: In([...LIVE_LISTING_CO_MANAGER_STATUSES]),
        },
      });
      if (
        liveSeatCount >= ListingCoManagersService.MAX_CO_MANAGERS_PER_LISTING
      ) {
        throw new ConflictException(
          `A listing can have at most ${ListingCoManagersService.MAX_CO_MANAGERS_PER_LISTING} co-managers, including unanswered invitations`,
        );
      }

      if (existingSeat) {
        // A member who declined, was revoked, or stepped down can be invited
        // again, and reuses their row. Every field describing the PREVIOUS
        // invitation is rewritten, so nothing about the seat that ended can be
        // read back as if it belonged to this one.
        existingSeat.status = ListingCoManagerStatus.Invited;
        existingSeat.invitedByUserId = inviterUserId;
        existingSeat.invitedAt = invitedAt;
        existingSeat.acceptedAt = null;
        existingSeat.endedAt = null;
        // Written explicitly on the reuse path. A seat an owner appointed and
        // later revoked, re-attached by staff to a listing that has since
        // lost its owner, is a STAFF-attached seat now, and the reverse case
        // has to clear the flag just as plainly.
        existingSeat.isStaffAttached = isStaffAttached;
        return seatsRepo.save(existingSeat);
      }
      return seatsRepo.save(
        seatsRepo.create({
          listingId: listing.id,
          userId: invitedUserId,
          invitedByUserId: inviterUserId,
          status: ListingCoManagerStatus.Invited,
          invitedAt,
          acceptedAt: null,
          endedAt: null,
          isStaffAttached,
        }),
      );
    });

    // Post-commit, best-effort, never rethrown — the module's standing pattern
    // for every secondary write. The invitation has already committed and shows
    // up on the member's invites list either way.
    await this.notifyBestEffort(
      invitedUserId,
      NotificationType.ListingCoManagerInvite,
      {
        actorId: inviterUserId,
        source: 'listing',
        listingSlug: listing.slug,
        listingName: listing.name,
        inviteId: seat.id,
      },
      inviterUserId,
    );

    const refs = await new MemberLookup(this.profiles).byUserIds([
      invitedUserId,
      inviterUserId,
    ]);
    return toListingCoManagerDTO(
      seat,
      refs.get(invitedUserId) ?? null,
      refs.get(inviterUserId) ?? null,
    );
  }

  /**
   * OWNER ONLY: take a seat back, whether it is an accepted co-manager or an
   * invitation that has not been answered.
   *
   * Idempotent in effect: a seat that is already terminal 404s, so a
   * double-click cannot write a second removal event.
   */
  async revoke(
    ref: string,
    ownerUserId: string,
    memberSlug: string,
  ): Promise<void> {
    const listing = await this.loadOwnedOr404(ref, ownerUserId);
    await this.revokeSeatOnLoadedListing(listing, ownerUserId, memberSlug);
  }

  /** The seat removal itself, on a listing the caller has already been cleared
   * for. Shared by the owner-gated `revoke` and the staff-gated
   * `staffRevokeCoManager`, so both write the same conditional flip and the
   * same audit row through `endSeat`. */
  private async revokeSeatOnLoadedListing(
    listing: Listing,
    actorUserId: string,
    memberSlug: string,
  ): Promise<void> {
    const targetUserId = await new MemberLookup(this.profiles).userIdForSlug(
      memberSlug,
    );
    if (!targetUserId) {
      throw new NotFoundException('Member not found');
    }
    await this.endSeat(listing, targetUserId, actorUserId, 'revoked');
  }

  // ---------------------------------------------------------------------------
  // Staff writes, for a listing the house authored and nobody has accepted yet.
  // ---------------------------------------------------------------------------

  /**
   * STAFF: the same roster read the owner gets, for any listing.
   *
   * The owner-facing `listSeats` gates on owner-or-co-manager. An admin
   * arranging the delegation on a house-authored listing is neither, and the
   * route carries its own admin gate, so the listing is looked up by ref
   * alone.
   */
  async staffListCoManagers(ref: string): Promise<ListingCoManagerDTO[]> {
    return this.listSeatsForListing(await this.loadForStaffOr404(ref));
  }

  /**
   * STAFF: seat somebody on a listing the house wrote, so the business has
   * people running its page before anybody has accepted ownership of it.
   *
   * ON AN UNOWNED LISTING the seat is stamped `isStaffAttached`, which is the
   * whole point of the flag: `revokeAllForOwnershipTransfer` spares exactly
   * these seats, so the delegation staff arranged survives the moment an
   * owner accepts. A staff invite that left the flag at its default would
   * have its seat revoked by that accept, which is the failure the column was
   * added to prevent.
   *
   * ON AN OWNED LISTING the same call seats somebody alongside an existing
   * owner, and the flag stays `false`. That seat belongs to the owner's own
   * arrangement and leaves with them on a transfer, like every seat the owner
   * appointed. The decision is made inside `inviteToLoadedListing` from the
   * LOCKED row, so a claim landing mid-flight cannot get the wrong provenance
   * written.
   *
   * Everything else is the member path's body, reached through
   * `inviteToLoadedListing`: the row lock, the five-seat cap, the two
   * duplicate-seat conflicts, the owner-may-not-hold-a-seat rule and the
   * terminal-row reuse all hold identically.
   */
  async staffInviteCoManager(
    ref: string,
    adminUserId: string,
    dto: InviteListingCoManagerDto,
  ): Promise<ListingCoManagerDTO> {
    const listing = await this.loadForStaffOr404(ref);
    return this.inviteToLoadedListing(listing, adminUserId, dto, {
      isStaffInvite: true,
    });
  }

  /** STAFF: take back a seat on any listing, accepted or still unanswered.
   * Writes the same `co_manager_removed` audit row the owner's own revoke
   * writes, naming the acting admin as the actor. */
  async staffRevokeCoManager(
    ref: string,
    adminUserId: string,
    memberSlug: string,
  ): Promise<void> {
    const listing = await this.loadForStaffOr404(ref);
    await this.revokeSeatOnLoadedListing(listing, adminUserId, memberSlug);
  }

  // ---------------------------------------------------------------------------
  // Member self-service.
  // ---------------------------------------------------------------------------

  /** A co-manager steps down from a listing they co-manage. Never reaches the
   * owner: an owner is not a seat, and `loadOwnedOr404` is not consulted here. */
  async leave(ref: string, userId: string): Promise<void> {
    const listing = await this.loadOr404(ref);
    await this.endSeat(listing, userId, userId, 'left');
  }

  /** Every unanswered invitation addressed to this member, newest first. */
  async listMyInvites(userId: string): Promise<ListingCoManagerInviteDTO[]> {
    const seats = await this.coManagers.find({
      where: { userId, status: ListingCoManagerStatus.Invited },
      order: { invitedAt: 'DESC' },
    });
    if (!seats.length) return [];

    // Two batched lookups total: the listings the invitations are about, and
    // the owners who sent them.
    const listings = await this.listings.find({
      where: { id: In(seats.map((seat) => seat.listingId)) },
    });
    const listingById = new Map(
      listings.map((listing) => [listing.id, listing]),
    );
    const refs = await new MemberLookup(this.profiles).byUserIds(
      seats
        .map((seat) => seat.invitedByUserId)
        .filter(
          (invitedByUserId): invitedByUserId is string =>
            invitedByUserId !== null,
        ),
    );

    return seats
      .map((seat): ListingCoManagerInviteDTO | null => {
        const listing = listingById.get(seat.listingId);
        if (!listing) return null;
        return toListingCoManagerInviteDTO(
          seat,
          listing,
          seat.invitedByUserId
            ? (refs.get(seat.invitedByUserId) ?? null)
            : null,
        );
      })
      .filter((dto): dto is ListingCoManagerInviteDTO => dto !== null);
  }

  /**
   * The invited member answers: accept and the seat becomes `active`, decline
   * and it becomes `declined`.
   *
   * Scoped by `{ id, userId }`, so an invitation addressed to somebody else
   * 404s rather than 403s — a seat id would otherwise be an oracle for "is this
   * a real invitation", exactly the reason `loadOwnedOr404` folds ownership
   * into its query.
   *
   * The status flip and the `co_manager_added` audit row are two writes with no
   * external I/O between them, so they run in one transaction, matching how
   * `ListingsService.update` pairs a save with its own event. The flip is
   * CONDITIONAL on the row still being `invited`, so a double-tap from two tabs
   * cannot write two audit rows: the loser sees `affected === 0` and is
   * rejected.
   */
  async respondToInvite(
    inviteId: string,
    userId: string,
    decision: 'accept' | 'decline',
  ): Promise<ListingCoManagerInviteDTO> {
    const isAccepted = decision === 'accept';
    const respondedAt = new Date();
    // Resolved BEFORE the transaction opens. It is a read on an unrelated table
    // and there is no reason to hold a write transaction open across it.
    const responderName = await this.resolveDisplayName(userId);

    const { seat, listing, mailboxChanges } = await this.dataSource.transaction(
      async (manager) => {
        const seatsRepo = manager.getRepository(ListingCoManager);
        const current = await seatsRepo.findOne({
          where: { id: inviteId, userId },
        });
        if (!current) {
          throw new NotFoundException('Invitation not found');
        }
        if (current.status !== ListingCoManagerStatus.Invited) {
          throw new ConflictException(
            'This invitation has already been answered',
          );
        }

        const invitedListing = await manager
          .getRepository(Listing)
          .findOne({ where: { id: current.listingId } });
        if (!invitedListing) {
          throw new NotFoundException('The listing no longer exists');
        }

        const updated = await seatsRepo.update(
          { id: inviteId, status: ListingCoManagerStatus.Invited },
          isAccepted
            ? {
                status: ListingCoManagerStatus.Active,
                acceptedAt: respondedAt,
                endedAt: null,
              }
            : {
                status: ListingCoManagerStatus.Declined,
                acceptedAt: null,
                endedAt: respondedAt,
              },
        );
        if (updated.affected !== 1) {
          throw new ConflictException(
            'This invitation has already been answered',
          );
        }

        if (isAccepted) {
          current.status = ListingCoManagerStatus.Active;
          current.acceptedAt = respondedAt;
          current.endedAt = null;
          await manager.save(ListingModerationEvent, {
            listingId: invitedListing.id,
            actorId: userId,
            action: ListingModerationAction.CoManagerAdded,
            fromStatus: null,
            toStatus: null,
            reason: `${responderName} accepted an invitation to co-manage this listing.`,
          });
          // Acceptance is the moment this seat becomes ACCESS. Seat the new
          // co-manager into every thread of the listing's mailbox, in this
          // same transaction, so a failure below rolls the acceptance back
          // with it. The staffing frame waits for the commit (below).
          const identity = await this.identities.ensureIdentityFor(
            IdentityKind.Listing,
            invitedListing.id,
          );
          const acceptedMailboxChanges =
            await this.identityMailboxSync.onStaffAdded(
              identity.id,
              userId,
              manager,
              { shouldDeferEmission: true },
            );
          return {
            seat: current,
            listing: invitedListing,
            mailboxChanges: acceptedMailboxChanges,
          };
        }
        current.status = ListingCoManagerStatus.Declined;
        current.acceptedAt = null;
        current.endedAt = respondedAt;
        return { seat: current, listing: invitedListing, mailboxChanges: null };
      },
    );
    // Task 25: the new co-manager hears their new mailbox only once the
    // acceptance has committed, so a rollback never announces a seat.
    if (mailboxChanges) {
      this.identityMailboxSync.emitSeatChanges(mailboxChanges);
    }

    // Post-commit, best-effort, never rethrown. The owner sent this invitation
    // by hand and is the one person waiting on the answer. A NULL `ownerId`
    // is an entry whose owner erased their account
    // (`SetNullContentAuthorFksOnUserErasure1794610000000`) between sending
    // the invite and its answer, so there is nobody left to tell.
    if (listing.ownerId !== null) {
      await this.notifyBestEffort(
        listing.ownerId,
        isAccepted
          ? NotificationType.ListingCoManagerInviteAccepted
          : NotificationType.ListingCoManagerInviteDeclined,
        {
          actorId: userId,
          source: 'listing',
          listingSlug: listing.slug,
          listingName: listing.name,
        },
        userId,
      );
    }

    const invitedBy = seat.invitedByUserId
      ? ((
          await new MemberLookup(this.profiles).byUserIds([
            seat.invitedByUserId,
          ])
        ).get(seat.invitedByUserId) ?? null)
      : null;
    return toListingCoManagerInviteDTO(seat, listing, invitedBy);
  }

  // ---------------------------------------------------------------------------
  // Internals.
  // ---------------------------------------------------------------------------

  /**
   * Ends one member's seat on one listing, writing the audit row only when
   * something was actually taken away.
   *
   * A seat still at `invited` ends silently: nothing had been granted, so
   * `co_manager_removed` would be describing the withdrawal of an offer rather
   * than the loss of access, and the listing's history is not the place for
   * invite churn.
   *
   * The status flip is conditional on the seat still being live, so two
   * concurrent removals produce one event, not two.
   */
  private async endSeat(
    listing: Listing,
    targetUserId: string,
    actorUserId: string,
    kind: CoManagerRemovalKind,
  ): Promise<void> {
    const endedAt = new Date();
    // Resolved before the transaction opens, same reason as in
    // `respondToInvite`: no unrelated read inside a write transaction.
    const targetName = await this.resolveDisplayName(targetUserId);
    const identity = await this.identities.ensureIdentityFor(
      IdentityKind.Listing,
      listing.id,
    );
    const mailboxChanges = await this.dataSource.transaction(
      async (manager) => {
        const seatsRepo = manager.getRepository(ListingCoManager);
        const seat = await seatsRepo.findOne({
          where: { listingId: listing.id, userId: targetUserId },
        });
        if (!seat || !this.isLiveSeat(seat)) {
          throw new NotFoundException('Co-manager not found');
        }
        const wasActive = seat.status === ListingCoManagerStatus.Active;

        const updated = await seatsRepo.update(
          {
            id: seat.id,
            status: In([...LIVE_LISTING_CO_MANAGER_STATUSES]),
          },
          {
            status:
              kind === 'left'
                ? ListingCoManagerStatus.Left
                : ListingCoManagerStatus.Revoked,
            endedAt,
          },
        );
        if (updated.affected !== 1) {
          throw new NotFoundException('Co-manager not found');
        }

        if (wasActive) {
          await manager.save(ListingModerationEvent, {
            listingId: listing.id,
            actorId: actorUserId,
            action: ListingModerationAction.CoManagerRemoved,
            fromStatus: null,
            toStatus: null,
            reason: `${targetName} ${
              kind === 'left'
                ? 'stepped down as a co-manager of this listing.'
                : 'was removed as a co-manager of this listing.'
            }`,
          });
          // Only an ACTIVE seat was ever access. Ending it here, in the same
          // transaction, so a failure rolls the removal back with it. The
          // live-room eviction event is deferred to after this transaction
          // resolves (below), mirroring `GroupsService.leaveGroup`'s
          // post-commit fan-out, so a rollback can never leave a client
          // believing it lost a room it still has.
          return this.identityMailboxSync.onStaffRemoved(
            identity.id,
            targetUserId,
            manager,
            { shouldDeferEmission: true },
          );
        }
        return null;
      },
    );
    // Best-effort live fan-out AFTER commit: see the comment above. Task 25:
    // this also carries the departing member's claim releases and their
    // staffing change.
    if (mailboxChanges) {
      this.identityMailboxSync.emitSeatChanges(mailboxChanges);
    }
  }

  /** The roster itself, once the caller has been cleared for this listing.
   * Shared by the owner-or-co-manager `listSeats` and the staff
   * `staffListCoManagers`, so both return the same live seats in the same
   * order with the same batched profile lookup. */
  private async listSeatsForListing(
    listing: Listing,
  ): Promise<ListingCoManagerDTO[]> {
    const seats = await this.coManagers.find({
      where: {
        listingId: listing.id,
        status: In([...LIVE_LISTING_CO_MANAGER_STATUSES]),
      },
      order: { status: 'ASC', invitedAt: 'DESC' },
    });
    if (!seats.length) return [];

    // ONE batched profile lookup covering every member named on the page,
    // seat holders and inviters together. One query at any seat count.
    const refs = await new MemberLookup(this.profiles).byUserIds([
      ...seats.map((seat) => seat.userId),
      ...seats
        .map((seat) => seat.invitedByUserId)
        .filter((userId): userId is string => userId !== null),
    ]);
    return seats.map((seat) =>
      toListingCoManagerDTO(
        seat,
        refs.get(seat.userId) ?? null,
        seat.invitedByUserId ? (refs.get(seat.invitedByUserId) ?? null) : null,
      ),
    );
  }

  private isLiveSeat(seat: ListingCoManager): boolean {
    return LIVE_LISTING_CO_MANAGER_STATUSES.includes(seat.status);
  }

  /**
   * A member's display name for the `reason` on a co-manager audit row.
   *
   * The reason string is entirely platform-composed: this name plus one of
   * three fixed sentences. No caller supplies any part of it, which is what
   * puts both co-manager actions on
   * `OWNER_VISIBLE_MODERATION_REASON_ACTIONS` — there is no path by which a
   * member's typed words could reach an owner through that field. A member with
   * no resolvable profile reads as "A QueerPulse member", the same fallback
   * `DirectoryService` uses for a reviewer or an asker.
   */
  private async resolveDisplayName(memberUserId: string): Promise<string> {
    const ref: MemberRef | undefined = (
      await new MemberLookup(this.profiles).byUserIds([memberUserId])
    ).get(memberUserId);
    if (!ref) return 'A QueerPulse member';
    const name = `${ref.firstName} ${ref.lastName}`.trim();
    return name || 'A QueerPulse member';
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

  /** Mirrors `ListingsService.loadOwnedOr404` exactly: ownership folded into
   * the query, so a real `ref` owned by somebody else 404s like a missing one
   * rather than 403-ing and confirming it exists. */
  private async loadOwnedOr404(ref: string, userId: string): Promise<Listing> {
    const listing = await this.listings.findOne({
      where: { ref, ownerId: userId },
    });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    return listing;
  }

  /** The roster read's gate: owner OR active co-manager, still 404-shaped for
   * anyone who is neither. Mirrors
   * `ListingsService.loadOwnedOrCoManagedOr404`, which is the same rule applied
   * to the listing routes. */
  private async loadManageableOr404(
    ref: string,
    userId: string,
  ): Promise<Listing> {
    const listing = await this.loadOr404(ref);
    if (listing.ownerId === userId) return listing;
    if (await this.isActiveCoManager(listing.id, userId)) return listing;
    throw new NotFoundException('Listing not found');
  }

  private async loadOr404(ref: string): Promise<Listing> {
    const listing = await this.listings.findOne({ where: { ref } });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    return listing;
  }

  /**
   * Load a listing for a staff-driven delegation change.
   *
   * The owner-scoped sibling folds ownership into the query so a foreign
   * listing 404s. Staff routes carry their own admin guard, so this one looks
   * the listing up by ref alone, which is what the unscoped `loadOr404`
   * already does. It carries its own name because the name is the
   * documentation: a reader of `staffInviteCoManager` should see at the call
   * site that no ownership narrowing happens here and that the gate is on
   * the route.
   */
  private async loadForStaffOr404(ref: string): Promise<Listing> {
    return this.loadOr404(ref);
  }
}
