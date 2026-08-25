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
   * Called by `ListingClaimsService.review` INSIDE its existing transaction —
   * hence the `EntityManager` parameter rather than this service's own
   * repository. The revocation and the `owner_id` reassignment must commit or
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
    const listing = await this.loadManageableOr404(ref, actorUserId);

    const seats = await this.coManagers.find({
      where: {
        listingId: listing.id,
        status: In([...LIVE_LISTING_CO_MANAGER_STATUSES]),
      },
      order: { status: 'ASC', invitedAt: 'DESC' },
    });
    if (!seats.length) return [];

    // ONE batched profile lookup for every member named on the page (seat
    // holders and inviters together), never one per row.
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
   *  3. The target is not the owner. An owner already has strictly more access
   *     than a seat would give them, so a self-invite could only ever be a
   *     mistake or a way to burn a seat.
   *  4. Under a row lock on the listing: the seat is free and the cap has room.
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

    const invitedUserId = await new MemberLookup(this.profiles).userIdForSlug(
      dto.memberSlug,
    );
    if (!invitedUserId) {
      throw new NotFoundException('Member not found');
    }
    if (invitedUserId === listing.ownerId) {
      throw new BadRequestException(
        'You already own this listing, so you cannot invite yourself to co-manage it',
      );
    }

    const invitedAt = new Date();
    const seat = await this.dataSource.transaction(async (manager) => {
      const seatsRepo = manager.getRepository(ListingCoManager);
      // Serialises concurrent invitations on this listing so the cap below is
      // counted against a stable set of rows. See the method doc comment.
      await manager.getRepository(Listing).findOne({
        where: { id: listing.id },
        lock: { mode: 'pessimistic_write' },
      });

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
        existingSeat.invitedByUserId = ownerUserId;
        existingSeat.invitedAt = invitedAt;
        existingSeat.acceptedAt = null;
        existingSeat.endedAt = null;
        return seatsRepo.save(existingSeat);
      }
      return seatsRepo.save(
        seatsRepo.create({
          listingId: listing.id,
          userId: invitedUserId,
          invitedByUserId: ownerUserId,
          status: ListingCoManagerStatus.Invited,
          invitedAt,
          acceptedAt: null,
          endedAt: null,
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
        actorId: ownerUserId,
        source: 'listing',
        listingSlug: listing.slug,
        listingName: listing.name,
        inviteId: seat.id,
      },
      ownerUserId,
    );

    const refs = await new MemberLookup(this.profiles).byUserIds([
      invitedUserId,
      ownerUserId,
    ]);
    return toListingCoManagerDTO(
      seat,
      refs.get(invitedUserId) ?? null,
      refs.get(ownerUserId) ?? null,
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
    const targetUserId = await new MemberLookup(this.profiles).userIdForSlug(
      memberSlug,
    );
    if (!targetUserId) {
      throw new NotFoundException('Member not found');
    }
    await this.endSeat(listing, targetUserId, ownerUserId, 'revoked');
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

    const { seat, listing } = await this.dataSource.transaction(
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
        } else {
          current.status = ListingCoManagerStatus.Declined;
          current.acceptedAt = null;
          current.endedAt = respondedAt;
        }
        return { seat: current, listing: invitedListing };
      },
    );

    // Post-commit, best-effort, never rethrown. The owner sent this invitation
    // by hand and is the one person waiting on the answer.
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
    await this.dataSource.transaction(async (manager) => {
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
      }
    });
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
}
