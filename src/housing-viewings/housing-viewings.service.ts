import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { MemberLookup } from '../common/member-ref';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
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
  ) {}

  async request(
    requesterId: string,
    dto: RequestHousingViewingDto,
  ): Promise<HousingViewingDTO> {
    const listing = await this.listings.findOne({
      where: { ref: dto.listingRef, status: HousingListingStatus.Live },
    });
    if (!listing) {
      throw new NotFoundException('Housing listing not found');
    }
    if (listing.ownerId === requesterId) {
      throw new BadRequestException(
        'You cannot request a viewing on your own listing',
      );
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
      return await this.createRequest(listing, requesterId, dto);
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
    listing: HousingListing,
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
    return this.buildOne(saved, requesterId);
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
    const role = this.roleOf(viewing, userId);
    // You accept the OTHER side's proposal, never your own.
    if (viewing.proposedBy === role) {
      throw new ForbiddenException(
        'Wait for the other person to respond to your proposed times',
      );
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
    return this.saveAndBuild(viewing, userId);
  }

  async propose(
    id: string,
    userId: string,
    dto: ProposeHousingViewingDto,
  ): Promise<HousingViewingDTO> {
    const viewing = await this.loadParticipant(id, userId);
    this.assertPending(viewing);
    const role = this.roleOf(viewing, userId);
    if (viewing.proposedBy === role) {
      throw new ForbiddenException(
        'You already proposed these times — wait for a reply',
      );
    }
    viewing.proposedSlots = this.normalizeSlots(dto.slots);
    viewing.proposedBy = role;
    viewing.responseNote = dto.note ?? null;
    return this.saveAndBuild(viewing, userId);
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
    return this.saveAndBuild(viewing, userId);
  }

  /** Either participant may cancel while still pending. */
  async cancel(id: string, userId: string): Promise<HousingViewingDTO> {
    const viewing = await this.loadParticipant(id, userId);
    this.assertPending(viewing);
    viewing.status = HousingViewingStatus.Cancelled;
    return this.saveAndBuild(viewing, userId);
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
    return this.saveAndBuild(viewing, userId);
  }

  // --- cross-module reads (used by housing-listings + housing-reviews) ---

  /**
   * True when `userId` is an enquirer whose viewing on `listingId` has been
   * accepted (or already completed) — the signal the address gate ORs in so an
   * accepted enquirer unlocks the precise address without needing to be a full
   * connection.
   */
  async hasUnlockedViewing(
    listingId: string,
    userId: string,
  ): Promise<boolean> {
    return this.viewings.exists({
      where: {
        listingId,
        requesterId: userId,
        status: In([
          HousingViewingStatus.Accepted,
          HousingViewingStatus.Completed,
        ]),
      },
    });
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

  private roleOf(viewing: HousingViewing, userId: string): HousingViewingParty {
    return viewing.requesterId === userId
      ? HousingViewingParty.Requester
      : HousingViewingParty.Lister;
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
    const listings = await this.listings.find({
      where: { id: In(listingIds) },
    });
    const listingById = new Map<string, ListingSummary>(
      listings.map((listing) => [
        listing.id,
        { ref: listing.ref, slug: listing.slug, title: listing.title },
      ]),
    );
    // The counterparty is whoever the caller ISN'T on each row.
    const counterpartyIds = rows.map((row) =>
      row.requesterId === callerId ? row.listerId : row.requesterId,
    );
    const refs = await new MemberLookup(this.profiles).byUserIds(
      counterpartyIds,
    );
    return rows.map((row) => {
      const summary = listingById.get(row.listingId) ?? {
        ref: '',
        slug: '',
        title: '',
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
