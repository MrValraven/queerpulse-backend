import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  FindOptionsWhere,
  In,
  MoreThanOrEqual,
  Not,
  Repository,
} from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { MemberLookup } from '../common/member-ref';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  HousingListing,
  HousingListingStatus,
} from '../housing-listings/entities/housing-listing.entity';
import { RequestHousingViewingDto } from './dto/request-housing-viewing.dto';
import {
  AcceptHousingViewingDto,
  DeclineHousingViewingDto,
  ProposeHousingViewingDto,
} from './dto/respond-housing-viewing.dto';
import {
  HousingViewing,
  HousingViewingParty,
  HousingViewingStatus,
} from './entities/housing-viewing.entity';
import {
  HousingViewingDTO,
  ListingSummary,
  toHousingViewingDTO,
} from './housing-viewing-response';

/** The content-moderation subject type housing listings are filed under,
 * keyed by slug (`HousingDirectoryService.SUBJECT_TYPE`). */
const HOUSING_MODERATION_SUBJECT = 'housing';

/** The statuses a viewing is still open in: something the two people may yet
 * act on, and something a block, a filled home or a deleted home calls off. */
const OPEN_VIEWING_STATUSES = [
  HousingViewingStatus.Requested,
  HousingViewingStatus.Accepted,
];

/** Extra context for `hasUnlockedViewing`, supplied by the listing detail read
 * that already holds the listing row. */
export interface UnlockedViewingOptions {
  /** The lister. A block either way between the viewer and the lister closes
   * the address again. */
  listerId?: string | null;
  /** When the lister last put a filled home back on the board. A completed
   * viewing keeps the address unlocked only when its agreed slot falls on or
   * after this moment, so a viewing from an earlier letting stops counting once
   * the home is relisted. */
  relistedAt?: Date | null;
}

/**
 * Viewing scheduling for member housing listings (P2.3). Requesting a viewing
 * is a CONTACT action, so it carries the same two gates a cold enquiry does:
 * the mandatory LGBTQ+ affirming pledge (the universal baseline every housing
 * write/contact surface enforces) and the phone-verification step-up. No one
 * can request a viewing on their own listing. The state machine lives here;
 * transitions are guarded on the caller's role AND the current status.
 *
 * Only `request()` carries the pledge gate, and that is complete coverage for
 * the flow: the requester cannot reach `accept`/`propose`/`decline`/`complete`
 * without first passing through `request()`, and the lister already accepted
 * the pledge when they posted the listing (`HousingListingsService.create`).
 */
@Injectable()
export class HousingViewingsService {
  private readonly logger = new Logger(HousingViewingsService.name);

  constructor(
    @InjectRepository(HousingViewing)
    private readonly viewings: Repository<HousingViewing>,
    // Read-only reference to resolve a listing by ref and its owner. Registered
    // via forFeature here so this module never depends on HousingListingsModule.
    @InjectRepository(HousingListing)
    private readonly listings: Repository<HousingListing>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly verification: VerificationService,
    private readonly affirmingPledge: AffirmingPledgeService,
    // PRD-240. The whole viewing lifecycle was silent before this: no bell for
    // the lister when a request arrived, and none for the requester when they
    // were accepted (which is also the moment the exact address unlocks, see
    // `hasUnlockedViewing`).
    private readonly notifications: NotificationsService,
    // ENG-468 / ENG-467. A block either way stops a viewing being requested,
    // answered or used to unlock the exact address, the same guard the
    // enquiry path applies (`MessageRequestsService`).
    private readonly blockFilter: BlockFilterService,
    // ENG-471. A home a moderator hid or removed is off the board for viewings
    // as well as for browse and detail.
    private readonly contentModeration: ContentModerationService,
  ) {}

  async request(
    requesterId: string,
    dto: RequestHousingViewingDto,
  ): Promise<HousingViewingDTO> {
    const listing = await this.listings.findOne({
      where: { ref: dto.listingRef, status: HousingListingStatus.Live },
    });
    // ENG-471. A live status alone still let a filled, expired or taken-down
    // home take viewing requests. The 404 matches what the public detail read
    // answers for the same home, so the client reads it as "not bookable".
    if (!listing || !(await this.isOnBoard(listing))) {
      throw new NotFoundException('Housing listing not found');
    }
    // NULL once the lister erased their account
    // (`SetNullContentAuthorFksOnUserErasure1794610000000`). Nobody can show
    // the home, so the request is refused rather than filed against no one.
    if (listing.ownerId === null) {
      throw new BadRequestException(
        'This listing no longer has a lister to arrange a viewing with',
      );
    }
    if (listing.ownerId === requesterId) {
      throw new BadRequestException(
        'You cannot request a viewing on your own listing',
      );
    }
    // ENG-468. A viewing request delivers a note to the lister and can unlock
    // their address, so a block either way refuses it. LOC-F1: the refusal is
    // the same 404 the public detail read gives a blocked pair
    // (`HousingDirectoryService.detail`, ENG-470), so the response never
    // confirms the home exists. Checked before the pledge and step-up so a
    // blocked pair is never walked through either.
    if (
      await this.blockFilter.isBlockedEitherWay(requesterId, listing.ownerId)
    ) {
      throw new NotFoundException('Housing listing not found');
    }
    // Baseline gate: arranging to view someone's home is the most direct
    // contact action in the module (it delivers the requester's note to the
    // lister and, once accepted, unlocks the precise address), so it commits to
    // the affirming pledge exactly like an enquiry, a flatmate hello, a landlord
    // intro and a group listing already do. Checked BEFORE the verification
    // step-up so a member who has done neither is asked for the pledge first,
    // matching `HousingListingsService.create`/`createEnquiry`'s ordering.
    await this.affirmingPledge.requireAccepted(requesterId);
    // Same step-up as enquiries — arranging to view a home needs a real phone.
    await this.verification.requireLevel(requesterId, VerificationLevel.Phone);

    // One open viewing per (listing, requester) at a time (BE-HSG-09). There
    // was no dedupe of any kind, so the same member could open an unbounded
    // number of viewings on one listing, and each one that a lister accepted
    // became another reviewable "interaction". The partial unique index
    // `UQ_housing_viewings_open` is the real backstop against the check-then-
    // insert race; this pre-check exists to give a readable message rather than
    // a 23505 (mirroring `ListingClaimsService.requestClaim`'s shape).
    const open = await this.viewings.findOne({
      where: [
        {
          listingId: listing.id,
          requesterId,
          status: HousingViewingStatus.Requested,
        },
        {
          listingId: listing.id,
          requesterId,
          status: HousingViewingStatus.Accepted,
        },
      ],
    });
    if (open) {
      throw new ConflictException(
        'You already have a viewing open on this listing',
      );
    }

    try {
      return await this.createRequest(
        listing as HousingListing & { ownerId: string },
        requesterId,
        dto,
      );
    } catch (error) {
      // Lost the insert race against a concurrent identical request.
      if (isUniqueViolation(error, 'UQ_housing_viewings_open')) {
        throw new ConflictException(
          'You already have a viewing open on this listing',
        );
      }
      throw error;
    }
  }

  /** The insert half of `request`, split out so the unique-violation retry
   * boundary above stays readable. */
  private async createRequest(
    // `listing.ownerId` is already proven non-null by `request`'s guard; the
    // narrowed lister id is passed in rather than re-derived so this half
    // keeps its own type guarantee.
    listing: HousingListing & { ownerId: string },
    requesterId: string,
    dto: RequestHousingViewingDto,
  ): Promise<HousingViewingDTO> {
    const saved = await this.viewings.save(
      this.viewings.create({
        listingId: listing.id,
        requesterId,
        listerId: listing.ownerId,
        mode: dto.mode,
        status: HousingViewingStatus.Requested,
        proposedBy: HousingViewingParty.Requester,
        proposedSlots: this.normalizeSlots(dto.proposedSlots),
        acceptedSlot: null,
        note: dto.note ?? '',
        responseNote: null,
      }),
    );
    const view = await this.buildOne(saved, requesterId);
    // PRD-240. Tell the lister somebody wants to see the home. The listing row
    // is already in hand, so its slug and title cost no extra query.
    await this.notify(
      listing.ownerId,
      requesterId,
      NotificationType.HousingViewingRequested,
      { viewingId: saved.id, slug: listing.slug, title: listing.title },
    );
    return view;
  }

  /** Every viewing the caller is part of, either side, newest first. */
  async listMine(userId: string): Promise<HousingViewingDTO[]> {
    const rows = await this.viewings.find({
      where: [{ requesterId: userId }, { listerId: userId }],
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return this.buildMany(rows, userId);
  }

  async accept(
    id: string,
    userId: string,
    dto: AcceptHousingViewingDto,
  ): Promise<HousingViewingDTO> {
    const viewing = await this.loadParticipant(id, userId);
    this.assertPending(viewing);
    await this.assertNotBlocked(viewing);
    const role = this.roleOf(viewing, userId);
    // You accept the OTHER side's proposal, never your own.
    if (viewing.proposedBy === role) {
      throw new ForbiddenException(
        'Wait for the other person to respond to your proposed times',
      );
    }
    // ENG-471. Accepting unlocks the exact address, so the home has to still
    // be bookable: live, unfilled, unexpired and clear of any takedown. Load
    // with `withDeleted` so a deleted home answers with this same message.
    const listing = await this.listings.findOne({
      where: { id: viewing.listingId },
      withDeleted: true,
    });
    if (!listing || !(await this.isOnBoard(listing))) {
      throw new BadRequestException('This home is no longer on the board');
    }
    const slotMs = new Date(dto.slot).getTime();
    const match = viewing.proposedSlots.find(
      (proposed) => new Date(proposed).getTime() === slotMs,
    );
    if (!match) {
      throw new BadRequestException(
        'That time is not one of the proposed slots',
      );
    }
    const acceptedSlot = new Date(dto.slot);
    // A proposal made days ago can still be sitting in the inbox after its
    // slots have passed. Accepting one would create an "accepted" viewing that
    // `complete()` lets either side tick off immediately, which is exactly the
    // zero-calendar-time review mint BE-HSG-09 closed.
    if (acceptedSlot.getTime() <= Date.now()) {
      throw new BadRequestException(
        'That time has already passed. Propose a new time instead',
      );
    }
    await this.assertSlotFree(viewing, acceptedSlot);
    viewing.status = HousingViewingStatus.Accepted;
    viewing.acceptedSlot = acceptedSlot;
    const view = await this.saveAndBuild(viewing, userId);
    // PRD-240. The single most important row of the five: acceptance is also
    // the moment the exact address unlocks for the requester
    // (`hasUnlockedViewing`), so without this they never learn to go and look.
    await this.notifyDecision(viewing, userId, view, 'accepted');
    return view;
  }

  async propose(
    id: string,
    userId: string,
    dto: ProposeHousingViewingDto,
  ): Promise<HousingViewingDTO> {
    const viewing = await this.loadParticipant(id, userId);
    this.assertPending(viewing);
    await this.assertNotBlocked(viewing);
    const role = this.roleOf(viewing, userId);
    if (viewing.proposedBy === role) {
      throw new ForbiddenException(
        'You already proposed these times — wait for a reply',
      );
    }
    viewing.proposedSlots = this.normalizeSlots(dto.slots);
    viewing.proposedBy = role;
    viewing.responseNote = dto.note ?? null;
    const view = await this.saveAndBuild(viewing, userId);
    // PRD-240. A counter-proposal is a decision with `decision: 'proposed'`.
    // Either side can make one (the guard above only forbids proposing twice in
    // a row), so the recipient is computed from the caller rather than assumed
    // to be the requester.
    await this.notifyDecision(viewing, userId, view, 'proposed');
    return view;
  }

  async decline(
    id: string,
    userId: string,
    dto: DeclineHousingViewingDto,
  ): Promise<HousingViewingDTO> {
    const viewing = await this.loadParticipant(id, userId);
    this.assertPending(viewing);
    const role = this.roleOf(viewing, userId);
    // The party being asked declines; the proposer withdraws via `cancel`.
    if (viewing.proposedBy === role) {
      throw new ForbiddenException(
        'Withdraw your own request with cancel instead',
      );
    }
    viewing.status = HousingViewingStatus.Declined;
    viewing.responseNote = dto.note ?? null;
    const view = await this.saveAndBuild(viewing, userId);
    // PRD-240. Usually the lister turning down the original request, but a
    // requester can also decline the lister's counter-proposal, so the
    // recipient is the party who did NOT decline.
    await this.notifyDecision(viewing, userId, view, 'declined');
    return view;
  }

  /** Either participant may cancel a requested or an accepted viewing
   * (ENG-467). Plans change after a time is agreed, and an accepted viewing
   * that only one side knows is off keeps the address unlocked for someone who
   * is no longer coming. A completed viewing is history and stays as it is. */
  async cancel(id: string, userId: string): Promise<HousingViewingDTO> {
    const viewing = await this.loadParticipant(id, userId);
    if (!OPEN_VIEWING_STATUSES.includes(viewing.status)) {
      throw new BadRequestException('This viewing can no longer be cancelled');
    }
    viewing.status = HousingViewingStatus.Cancelled;
    const view = await this.saveAndBuild(viewing, userId);
    // PRD-240. Either side may cancel, so the recipient is whichever
    // participant did not. Somebody is otherwise about to keep a slot free, or
    // travel, for a viewing that is no longer happening.
    await this.notify(
      this.counterpartyOf(viewing, userId),
      userId,
      NotificationType.HousingViewingCancelled,
      {
        viewingId: viewing.id,
        slug: view.listingSlug,
        title: view.listingTitle,
      },
    );
    return view;
  }

  /** Mark an accepted viewing as having happened — the real recorded
   * interaction the two-sided blind reviews (P2.4) require. Either participant
   * may confirm it, but NOT before the accepted slot has actually come round
   * (BE-HSG-09).
   *
   * That time check is the whole interaction gate. `complete()` used to check
   * only `status === Accepted`, so a requester could ask for a viewing, have it
   * accepted, mark it completed the same second and publish a review minutes
   * later. Repeat with a friendly lister and a listing accumulates unlimited
   * five-star "guest" reviews, each costing one accept click. Requiring the
   * slot to have passed means minting a review costs real calendar time. */
  async complete(id: string, userId: string): Promise<HousingViewingDTO> {
    const viewing = await this.loadParticipant(id, userId);
    if (viewing.status !== HousingViewingStatus.Accepted) {
      throw new BadRequestException(
        'Only an accepted viewing can be marked completed',
      );
    }
    if (
      viewing.acceptedSlot === null ||
      viewing.acceptedSlot.getTime() > Date.now()
    ) {
      throw new BadRequestException(
        'This viewing has not happened yet — you can mark it completed once the agreed time has passed',
      );
    }
    viewing.status = HousingViewingStatus.Completed;
    // PRD-240 deliberately emits NOTHING here, and it is the only transition
    // that does not. Completion can only be ticked once the agreed slot has
    // passed, so both people were already there: a bell saying "the viewing
    // happened" tells its recipient something they know better than the sender.
    return this.saveAndBuild(viewing, userId);
  }

  // --- cross-module reads (used by housing-listings + housing-reviews) ---

  /**
   * True when `userId` is an enquirer whose viewing on `listingId` has been
   * accepted (or already completed) — the signal the address gate ORs in so an
   * accepted enquirer unlocks the precise address without needing to be a full
   * connection.
   *
   * ENG-467 narrows it in two ways when the caller passes the listing's
   * context. A block either way with `options.listerId` closes the address
   * outright. And once a filled home is relisted, only viewings that belong to
   * the current letting count: an accepted viewing must have been requested on
   * or after `options.relistedAt`, and a completed one must have had its agreed
   * slot on or after it. The rule holds on its own, so it also covers accepted
   * viewings that outlived a fill, such as fills made before
   * `closeOpenForListing` existed.
   */
  async hasUnlockedViewing(
    listingId: string,
    userId: string,
    options: UnlockedViewingOptions = {},
  ): Promise<boolean> {
    if (
      options.listerId &&
      (await this.blockFilter.isBlockedEitherWay(userId, options.listerId))
    ) {
      return false;
    }
    const acceptedWhere: FindOptionsWhere<HousingViewing> = {
      listingId,
      requesterId: userId,
      status: HousingViewingStatus.Accepted,
    };
    const completedWhere: FindOptionsWhere<HousingViewing> = {
      listingId,
      requesterId: userId,
      status: HousingViewingStatus.Completed,
    };
    if (options.relistedAt) {
      acceptedWhere.createdAt = MoreThanOrEqual(options.relistedAt);
      completedWhere.acceptedSlot = MoreThanOrEqual(options.relistedAt);
    }
    return this.viewings.exists({ where: [acceptedWhere, completedWhere] });
  }

  /**
   * ENG-466 / ENG-467. Calls off every requested or accepted viewing on a home
   * the lister has just filled or deleted, and tells each requester with the
   * same `HousingViewingCancelled` bell a manual cancel sends, the lister as
   * actor. Called by `HousingListingsService.markFilled` and `remove` after
   * their own write has committed, so the whole pass is best-effort: a failure
   * is logged and the lister's action stands.
   *
   * One guarded UPDATE with RETURNING, so the bells go to exactly the rows this
   * write changed. A viewing completed or cancelled a moment earlier keeps its
   * status and its requester hears nothing from here.
   */
  async closeOpenForListing(listingId: string, actorId: string): Promise<void> {
    try {
      const result = await this.viewings
        .createQueryBuilder()
        .update()
        .set({ status: HousingViewingStatus.Cancelled })
        .where('listing_id = :listingId', { listingId })
        .andWhere('status IN (:...openStatuses)', {
          openStatuses: OPEN_VIEWING_STATUSES,
        })
        .returning(['id', 'requesterId'])
        .execute();
      const cancelled = (
        (result.raw ?? []) as { id?: unknown; requester_id?: unknown }[]
      ).filter(
        (row): row is { id: string; requester_id: string } =>
          typeof row.id === 'string' && typeof row.requester_id === 'string',
      );
      if (!cancelled.length) return;
      // `withDeleted`: on the delete path the listing is already soft-removed,
      // and the bell still needs its slug and title.
      const listing = await this.listings.findOne({
        where: { id: listingId },
        withDeleted: true,
      });
      for (const row of cancelled) {
        await this.notify(
          row.requester_id,
          actorId,
          NotificationType.HousingViewingCancelled,
          {
            viewingId: row.id,
            slug: listing?.slug ?? '',
            title: listing?.title ?? '',
          },
        );
      }
    } catch (error) {
      this.logger.warn(
        `Closing open viewings for listing ${listingId} failed: ${String(error)}`,
      );
    }
  }

  /**
   * PRD-444. Calls off every REQUESTED viewing on homes the daily expiry sweep
   * has just hidden, and tells each requester with the `HousingViewingCancelled`
   * bell. A requested viewing on a hidden home can never be accepted (accept
   * answers 400 "no longer on the board"), so leaving it open strands the
   * requester waiting on a lister who cannot say yes.
   *
   * Accepted viewings stay: the lister may still show the home, and `extend`
   * puts it back up. The lister is passed as the block/mute gate actor, the
   * same party `closeOpenForListing` passes, so a requester who blocked them
   * hears nothing.
   *
   * One guarded UPDATE with RETURNING, so the bells go to exactly the rows this
   * write changed. Best-effort: called after the sweep's own write committed,
   * so a failure is logged and the sweep stands.
   */
  async closeRequestedForListings(listingIds: string[]): Promise<void> {
    if (!listingIds.length) return;
    try {
      const result = await this.viewings
        .createQueryBuilder()
        .update()
        .set({ status: HousingViewingStatus.Cancelled })
        .where('listing_id IN (:...listingIds)', { listingIds })
        .andWhere('status = :requested', {
          requested: HousingViewingStatus.Requested,
        })
        .returning(['id', 'requesterId', 'listerId', 'listingId'])
        .execute();
      const cancelled = (
        (result.raw ?? []) as {
          id?: unknown;
          requester_id?: unknown;
          lister_id?: unknown;
          listing_id?: unknown;
        }[]
      ).filter(
        (
          row,
        ): row is {
          id: string;
          requester_id: string;
          lister_id: string;
          listing_id: string;
        } =>
          typeof row.id === 'string' &&
          typeof row.requester_id === 'string' &&
          typeof row.lister_id === 'string' &&
          typeof row.listing_id === 'string',
      );
      if (!cancelled.length) return;
      const affectedListingIds = [
        ...new Set(cancelled.map((row) => row.listing_id)),
      ];
      const listings = await this.listings.find({
        where: { id: In(affectedListingIds) },
        select: { id: true, slug: true, title: true },
      });
      const listingById = new Map(
        listings.map((listing) => [listing.id, listing]),
      );
      for (const row of cancelled) {
        const listing = listingById.get(row.listing_id);
        await this.notify(
          row.requester_id,
          row.lister_id,
          NotificationType.HousingViewingCancelled,
          {
            viewingId: row.id,
            slug: listing?.slug ?? '',
            title: listing?.title ?? '',
          },
        );
      }
    } catch (error) {
      this.logger.warn(
        `Closing requested viewings for ${listingIds.length} swept listing(s) failed: ${String(error)}`,
      );
    }
  }

  /** Load a COMPLETED viewing the caller took part in, for the review gate.
   * 404 if absent, 403 if the caller wasn't part of it, 400 if not completed. */
  async loadCompletedForReview(
    viewingId: string,
    userId: string,
  ): Promise<HousingViewing> {
    const viewing = await this.loadParticipant(viewingId, userId);
    if (viewing.status !== HousingViewingStatus.Completed) {
      throw new BadRequestException(
        'You can only review after a completed viewing',
      );
    }
    return viewing;
  }

  /** Load a viewing the caller took part in (any status) — the reviews read
   * path validates participation with this before disclosing anything. */
  async loadParticipantViewing(
    viewingId: string,
    userId: string,
  ): Promise<HousingViewing> {
    return this.loadParticipant(viewingId, userId);
  }

  // --- internals ---

  /** Neither participant may hold two accepted viewings at the same instant.
   * The proposal ping-pong is per-viewing, so without this a lister with five
   * live listings can be booked five times over at 18:00 on Saturday and only
   * discover it when five people arrive. Checked for both sides because a
   * requester touring four flats has the same problem. */
  private async assertSlotFree(
    viewing: HousingViewing,
    slot: Date,
  ): Promise<void> {
    const clash = await this.viewings.findOne({
      where: [
        {
          id: Not(viewing.id),
          status: HousingViewingStatus.Accepted,
          acceptedSlot: slot,
          listerId: viewing.listerId,
        },
        {
          id: Not(viewing.id),
          status: HousingViewingStatus.Accepted,
          acceptedSlot: slot,
          requesterId: viewing.requesterId,
        },
      ],
    });
    if (clash) {
      throw new ConflictException(
        'One of you already has a viewing booked at that time. Pick another slot',
      );
    }
  }

  /** Proposed slots must be in the future and distinct. The DTO guarantees each
   * string is a full ISO-8601 instant with an offset; this turns them into
   * `Date`s, drops exact duplicates (two identical slots would render as one
   * choice offered twice) and refuses times that have already gone. */
  private normalizeSlots(slots: string[]): Date[] {
    const now = Date.now();
    const byInstant = new Map<number, Date>();
    for (const slot of slots) {
      const parsed = new Date(slot);
      if (parsed.getTime() <= now) {
        throw new BadRequestException('Proposed times must be in the future');
      }
      if (!byInstant.has(parsed.getTime())) {
        byInstant.set(parsed.getTime(), parsed);
      }
    }
    return [...byInstant.values()];
  }

  private async loadParticipant(
    id: string,
    userId: string,
  ): Promise<HousingViewing> {
    const viewing = await this.viewings.findOne({ where: { id } });
    if (!viewing) {
      throw new NotFoundException('Viewing not found');
    }
    if (viewing.requesterId !== userId && viewing.listerId !== userId) {
      throw new ForbiddenException('You are not part of this viewing');
    }
    return viewing;
  }

  private assertPending(viewing: HousingViewing): void {
    if (viewing.status !== HousingViewingStatus.Requested) {
      throw new BadRequestException(
        'This viewing is no longer awaiting a response',
      );
    }
  }

  /** ENG-468. A block either way between the two participants freezes the
   * viewing for both: the block listener cancels it, and this refuses any
   * answer that races in before the listener runs. Both sides already hold
   * this viewing (it lists in their own `listMine`), so the 403 reveals no
   * home they could not already see; LOC-F1's 404 covers the request only. */
  private async assertNotBlocked(viewing: HousingViewing): Promise<void> {
    if (
      await this.blockFilter.isBlockedEitherWay(
        viewing.requesterId,
        viewing.listerId,
      )
    ) {
      throw new ForbiddenException('You cannot contact this member');
    }
  }

  /** ENG-471. True while the home can still be booked: live, unfilled,
   * unexpired, present and clear of a moderator takedown. The same rules the
   * public detail read applies before it shows the home to anyone else. */
  private async isOnBoard(listing: HousingListing): Promise<boolean> {
    if (!this.isListedAndCurrent(listing)) return false;
    const moderation = await this.contentModeration.stateFor(
      HOUSING_MODERATION_SUBJECT,
      listing.slug,
    );
    return !moderation.hidden && !moderation.removed;
  }

  /** The row-level half of `isOnBoard`: live, unfilled, unexpired and present.
   * `buildMany` pairs it with one batched moderation read for a whole page. */
  private isListedAndCurrent(listing: HousingListing): boolean {
    if (listing.status !== HousingListingStatus.Live) return false;
    if (listing.filledAt !== null) return false;
    if (new Date(listing.expiresAt).getTime() <= Date.now()) return false;
    return !listing.deletedAt;
  }

  private roleOf(viewing: HousingViewing, userId: string): HousingViewingParty {
    return viewing.requesterId === userId
      ? HousingViewingParty.Requester
      : HousingViewingParty.Lister;
  }

  /** The participant on this viewing who is NOT `actorId`. Every viewing bell
   * goes to them, because the actor already knows what they just did. */
  private counterpartyOf(viewing: HousingViewing, actorId: string): string {
    return viewing.requesterId === actorId
      ? viewing.listerId
      : viewing.requesterId;
  }

  /**
   * PRD-240. One `HousingViewingDecided` row for accept, propose and decline,
   * discriminated by `decision` (the frontend branches its copy on it).
   *
   * The recipient is the counterparty rather than a fixed side. All three
   * transitions are symmetric in the state machine: the guard on each is
   * `viewing.proposedBy === role`, so the acting party is always whoever did
   * not make the proposal on the table. That is the lister on the first pass,
   * and the REQUESTER once the lister has counter-proposed. Hard-coding the
   * requester as the recipient would send a lister's own accept back to them
   * and leave the other side silent, which is the bug this row exists to fix.
   */
  private async notifyDecision(
    viewing: HousingViewing,
    actorId: string,
    view: HousingViewingDTO,
    decision: 'accepted' | 'declined' | 'proposed',
  ): Promise<void> {
    await this.notify(
      this.counterpartyOf(viewing, actorId),
      actorId,
      NotificationType.HousingViewingDecided,
      {
        viewingId: viewing.id,
        slug: view.listingSlug,
        title: view.listingTitle,
        decision,
      },
    );
  }

  /**
   * Best-effort delivery of one viewing notification. The domain write is
   * already committed by the time this runs, so a notification failure must
   * never turn a completed transition into a 500 the member retries into a
   * second one.
   *
   * `actorId` is passed as well as being implied by the payload allowlist's
   * `actorId` key map: it is the block/mute gate, so a member who blocked their
   * counterparty is not reached by the row.
   */
  private async notify(
    recipientId: string | null,
    actorId: string,
    type: NotificationType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // Defensive: both participant columns are NOT NULL today, but an erasure
    // sweep that starts setting them null must skip rather than throw.
    if (!recipientId) return;
    try {
      await this.notifications.create(
        recipientId,
        type,
        { source: 'housing', ...payload },
        actorId,
      );
    } catch (error) {
      this.logger.warn(
        `Housing viewing notification ${type} failed for ${String(
          payload.viewingId,
        )}: ${String(error)}`,
      );
    }
  }

  private async saveAndBuild(
    viewing: HousingViewing,
    callerId: string,
  ): Promise<HousingViewingDTO> {
    const saved = await this.viewings.save(viewing);
    return this.buildOne(saved, callerId);
  }

  private async buildOne(
    viewing: HousingViewing,
    callerId: string,
  ): Promise<HousingViewingDTO> {
    const [dto] = await this.buildMany([viewing], callerId);
    // invariant: buildMany preserves order and length.
    return dto!;
  }

  private async buildMany(
    rows: HousingViewing[],
    callerId: string,
  ): Promise<HousingViewingDTO[]> {
    if (!rows.length) return [];
    const listingIds = [...new Set(rows.map((row) => row.listingId))];
    // ENG-466. `withDeleted` so a viewing on a home the lister has since
    // deleted keeps its title and slug in the member's history.
    const listings = await this.listings.find({
      where: { id: In(listingIds) },
      withDeleted: true,
    });
    // `isListingOpen` per home, batched: one moderation read for every slug
    // and one block read against every lister, whatever the page size.
    const [moderationBySlug, blockedListerIds] = await Promise.all([
      this.contentModeration.statesFor(
        HOUSING_MODERATION_SUBJECT,
        listings.map((listing) => listing.slug),
      ),
      this.blockFilter.blockedUserIds(
        callerId,
        listings
          .map((listing) => listing.ownerId)
          .filter((ownerId): ownerId is string => ownerId !== null),
      ),
    ]);
    const listingById = new Map<string, ListingSummary>(
      listings.map((listing) => {
        const moderation = moderationBySlug.get(listing.slug);
        const isOpen =
          this.isListedAndCurrent(listing) &&
          !moderation?.hidden &&
          !moderation?.removed &&
          listing.ownerId !== null &&
          !blockedListerIds.has(listing.ownerId);
        return [
          listing.id,
          {
            ref: listing.ref,
            slug: listing.slug,
            title: listing.title,
            isOpen,
            isDeleted: Boolean(listing.deletedAt),
          },
        ];
      }),
    );
    // The counterparty is whoever the caller ISN'T on each row.
    const counterpartyIds = rows.map((row) =>
      row.requesterId === callerId ? row.listerId : row.requesterId,
    );
    const refs = await new MemberLookup(this.profiles).byUserIds(
      counterpartyIds,
    );
    return rows.map((row) => {
      // A listing row missing even with `withDeleted` is gone for good, so it
      // reads as deleted and closed.
      const summary = listingById.get(row.listingId) ?? {
        ref: '',
        slug: '',
        title: '',
        isOpen: false,
        isDeleted: true,
      };
      const counterpartyId =
        row.requesterId === callerId ? row.listerId : row.requesterId;
      return toHousingViewingDTO(
        row,
        callerId,
        summary,
        refs.get(counterpartyId) ?? null,
      );
    });
  }
}
