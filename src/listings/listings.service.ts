import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { DataSource, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { MessagingService } from '../messaging/messaging.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  DEFAULT_LIST_LIMIT,
  normalizePage,
  paginate,
  Paginated,
} from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { Profile } from '../users/entities/profile.entity';
import { CreateListingDto } from './dto/create-listing.dto';
import { ReplyToReviewDto } from './dto/reply-to-review.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { UpdateSafeSpaceDto } from './dto/update-safe-space.dto';
import { ListingReview } from './entities/listing-review.entity';
import {
  Listing,
  ListingDayHours,
  ListingPhotoSet,
  ListingSocial,
  ListingStatus,
  ListingWitLine,
  SafeSpaceStatus,
} from './entities/listing.entity';
import {
  ListingDTO,
  ReviewDTO,
  toListingDTO,
  toReviewDTO,
} from './listing-response';

// Postgres unique-violation SQLSTATE. Mirrors `CompaniesService`'s/
// `PartnersService`'s identical file-local helper (not shared/exported, kept
// consistent with that precedent).
function normalizeSocial(input?: Partial<ListingSocial>): ListingSocial {
  return {
    instagram: input?.instagram ?? '',
    website: input?.website ?? '',
    email: input?.email ?? '',
    phone: input?.phone ?? '',
  };
}

function normalizePhotoSet(input?: Partial<ListingPhotoSet>): ListingPhotoSet {
  return {
    wide: input?.wide ?? '',
    d1: input?.d1 ?? '',
    d2: input?.d2 ?? '',
    vibe: input?.vibe ?? '',
  };
}

/** Bridges `CreateListingDto`'s optional fields to `Listing`'s
 * fully-populated columns (mirrors `PartnersService.createWithUniqueSlug`'s
 * inline defaulting). */
function normalizeCreate(dto: CreateListingDto): Omit<
  Listing,
  | 'id'
  | 'ref'
  | 'slug'
  | 'ownerId'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
  // Partner-space fields are an ops/moderation concern, never part of the
  // member-submission wizard — they default at the DB level on create.
  | 'isPartneredWithQueerpulse'
  | 'spaceType'
  | 'capacity'
  | 'hostNote'
  // Safe-space fields are likewise an ops/moderation concern, never part of
  // the member-submission wizard — they default at the DB level on create.
  | 'safeSpaceStatus'
  | 'safeSpaceTier'
  | 'safeSpaceVerifier'
  | 'safeSpaceReVerifiedAt'
  | 'safeSpaceSub'
  | 'safeSpacePromises'
  | 'safeSpaceVouches'
  | 'safeSpaceRemoval'
> {
  return {
    path: dto.path ?? '',
    verify: dto.verify ?? '',
    name: dto.name,
    cats: dto.cats ?? [],
    hood: dto.hood ?? '',
    badge: dto.badge ?? '',
    evidence: dto.evidence ?? '',
    price: dto.price ?? '',
    blurb: dto.blurb ?? '',
    tagline: dto.tagline ?? '',
    whatItIs: (dto.whatItIs ?? []) as ListingWitLine[],
    tags: dto.tags ?? [],
    goodFor: dto.goodFor ?? [],
    langs: dto.langs ?? [],
    address: dto.address ?? '',
    geocoded: dto.geocoded ?? false,
    latitude: dto.latitude ?? null,
    longitude: dto.longitude ?? null,
    hours: (dto.hours ?? {}) as Record<string, ListingDayHours>,
    hoursNote: dto.hoursNote ?? '',
    social: normalizeSocial(dto.social),
    photos: normalizePhotoSet(dto.photos),
    alt: normalizePhotoSet(dto.alt),
    rel: dto.rel ?? '',
    ownerName: dto.ownerName ?? '',
    ownerRole: dto.ownerRole ?? '',
    ownerBio: dto.ownerBio ?? '',
    visibility: dto.visibility ?? '',
    linkToProfile: dto.linkToProfile ?? false,
    contactEmail: dto.contactEmail ?? '',
    notify: dto.notify ?? [],
    consentOuting: dto.consentOuting ?? false,
    consentGuide: dto.consentGuide ?? false,
  };
}

/** Applies only the fields present on a PATCH body, leaving everything else
 * untouched (mirrors `CompaniesService.update`'s conditional-spread idiom).
 * `social`/`photos`/`alt` merge per-subfield rather than replacing the whole
 * nested object outright, so a caller patching just `social.phone` doesn't
 * blank out `social.email`. */
function applyUpdate(listing: Listing, dto: UpdateListingDto): void {
  Object.assign(listing, {
    ...(dto.path !== undefined ? { path: dto.path } : {}),
    ...(dto.verify !== undefined ? { verify: dto.verify } : {}),
    ...(dto.name !== undefined ? { name: dto.name } : {}),
    ...(dto.cats !== undefined ? { cats: dto.cats } : {}),
    ...(dto.hood !== undefined ? { hood: dto.hood } : {}),
    ...(dto.badge !== undefined ? { badge: dto.badge } : {}),
    ...(dto.evidence !== undefined ? { evidence: dto.evidence } : {}),
    ...(dto.price !== undefined ? { price: dto.price } : {}),
    ...(dto.blurb !== undefined ? { blurb: dto.blurb } : {}),
    ...(dto.tagline !== undefined ? { tagline: dto.tagline } : {}),
    ...(dto.whatItIs !== undefined
      ? { whatItIs: dto.whatItIs as ListingWitLine[] }
      : {}),
    ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
    ...(dto.goodFor !== undefined ? { goodFor: dto.goodFor } : {}),
    ...(dto.langs !== undefined ? { langs: dto.langs } : {}),
    ...(dto.address !== undefined ? { address: dto.address } : {}),
    ...(dto.geocoded !== undefined ? { geocoded: dto.geocoded } : {}),
    // Persist a moved/cleared pin: applied when present (incl. explicit null to
    // clear), left untouched when the PATCH omits them.
    ...(dto.latitude !== undefined ? { latitude: dto.latitude } : {}),
    ...(dto.longitude !== undefined ? { longitude: dto.longitude } : {}),
    ...(dto.hours !== undefined
      ? { hours: dto.hours as Record<string, ListingDayHours> }
      : {}),
    ...(dto.hoursNote !== undefined ? { hoursNote: dto.hoursNote } : {}),
    ...(dto.social !== undefined
      ? { social: { ...listing.social, ...dto.social } }
      : {}),
    ...(dto.photos !== undefined
      ? { photos: { ...listing.photos, ...dto.photos } }
      : {}),
    ...(dto.alt !== undefined ? { alt: { ...listing.alt, ...dto.alt } } : {}),
    ...(dto.rel !== undefined ? { rel: dto.rel } : {}),
    ...(dto.ownerName !== undefined ? { ownerName: dto.ownerName } : {}),
    ...(dto.ownerRole !== undefined ? { ownerRole: dto.ownerRole } : {}),
    ...(dto.ownerBio !== undefined ? { ownerBio: dto.ownerBio } : {}),
    ...(dto.visibility !== undefined ? { visibility: dto.visibility } : {}),
    ...(dto.linkToProfile !== undefined
      ? { linkToProfile: dto.linkToProfile }
      : {}),
    ...(dto.contactEmail !== undefined
      ? { contactEmail: dto.contactEmail }
      : {}),
    ...(dto.notify !== undefined ? { notify: dto.notify } : {}),
    ...(dto.consentOuting !== undefined
      ? { consentOuting: dto.consentOuting }
      : {}),
    ...(dto.consentGuide !== undefined
      ? { consentGuide: dto.consentGuide }
      : {}),
  });
}

export interface ListMyListingsQueryInput {
  page?: number;
}

export interface ListListingQueueQueryInput {
  status?: ListingStatus;
  page?: number;
}

/**
 * Member-submitted business directory listings (spec §3 Tier 4 "listings").
 * `ref` (`QPL-<year>-<seq>`) is the frontend's path identifier for every
 * mutation (`listings.api.ts`); `GET/PATCH/DELETE /listings/:ref` are all
 * owner-gated (403 for a non-owner caller) — this is the caller's own
 * submission-tracking view, not a public directory browse.
 */
@Injectable()
export class ListingsService {
  constructor(
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(ListingReview)
    private readonly reviews: Repository<ListingReview>,
    private readonly dataSource: DataSource,
    private readonly messaging: MessagingService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(ownerId: string, dto: CreateListingDto): Promise<ListingDTO> {
    const ref = await this.nextRef();
    const saved = await this.createWithUniqueSlug(ownerId, ref, dto);
    return this.buildDTO(saved);
  }

  async listMine(
    ownerId: string,
    query: ListMyListingsQueryInput,
  ): Promise<Paginated<ListingDTO>> {
    const page = normalizePage(query.page);
    const qb = this.listings
      .createQueryBuilder('l')
      .where('l.owner_id = :ownerId', { ownerId })
      .orderBy('l.created_at', 'DESC');

    return paginate(qb, page, async (rows) => {
      if (!rows.length) return [];
      const refs = await new MemberLookup(this.profiles).byUserIds(
        rows.map((r) => r.ownerId),
      );
      return rows.map((r) => toListingDTO(r, refs.get(r.ownerId) ?? null));
    });
  }

  /** Moderator/admin-only (`ListingsController.listQueue`'s `RolesGuard`
   * gate): every member-submitted listing, optionally filtered by review
   * status, newest first — the moderation queue. Mirrors `listMine`'s
   * pagination + owner-ref mapping, minus the owner scope. */
  async listQueue(
    query: ListListingQueueQueryInput,
  ): Promise<Paginated<ListingDTO>> {
    const page = normalizePage(query.page);
    const qb = this.listings
      .createQueryBuilder('l')
      .orderBy('l.created_at', 'DESC');
    if (query.status) {
      qb.andWhere('l.status = :status', { status: query.status });
    }

    return paginate(qb, page, async (rows) => {
      if (!rows.length) return [];
      const refs = await new MemberLookup(this.profiles).byUserIds(
        rows.map((row) => row.ownerId),
      );
      return rows.map((row) =>
        toListingDTO(row, refs.get(row.ownerId) ?? null),
      );
    });
  }

  async getByRef(ref: string, userId: string): Promise<ListingDTO> {
    const listing = await this.loadOr404(ref);
    this.assertOwner(listing, userId);
    return this.buildDTO(listing);
  }

  async update(
    ref: string,
    userId: string,
    dto: UpdateListingDto,
  ): Promise<ListingDTO> {
    const listing = await this.loadOr404(ref);
    this.assertOwner(listing, userId);

    applyUpdate(listing, dto);

    const saved = await this.listings.save(listing);
    return this.buildDTO(saved);
  }

  async remove(ref: string, userId: string): Promise<void> {
    const listing = await this.loadOr404(ref);
    this.assertOwner(listing, userId);
    await this.listings.remove(listing);
  }

  /**
   * Owner-gated: post (or overwrite) the listing owner's single public reply
   * to one of the listing's reviews. Placed here alongside the other
   * owner-gated `:ref` mutations rather than `DirectoryService` (where
   * `addReview`/`listReviews` live) so the ownership check stays consistent
   * with `update`/`remove`/`getByRef`; `DirectoryService` never enforces
   * ownership. The review is scoped to this listing so a reply can't be
   * attached to a review on a different owner's listing via a guessed id.
   */
  async replyToReview(
    ref: string,
    userId: string,
    reviewId: string,
    dto: ReplyToReviewDto,
  ): Promise<ReviewDTO> {
    const listing = await this.loadOr404(ref);
    this.assertOwner(listing, userId);

    const review = await this.reviews.findOne({
      where: { id: reviewId, listingId: listing.id },
    });
    if (!review) {
      throw new NotFoundException('Review not found');
    }

    // `ReplyToReviewDto`'s `@IsNotEmpty` only rejects an empty string, not a
    // whitespace-only one — a body of `" "` passes validation, trims to `""`,
    // and would otherwise save a blank `ownerReplyText` alongside a real
    // `ownerRepliedAt`; `toReviewDTO`'s truthy check on `ownerReplyText` then
    // renders that as `ownerReply: null` everywhere, so the timestamp would
    // silently strand in the DB with no visible reply. Re-check post-trim.
    const text = dto.text.trim();
    if (!text) {
      throw new BadRequestException('Reply cannot be empty');
    }

    review.ownerReplyText = text;
    review.ownerRepliedAt = new Date();
    const saved = await this.reviews.save(review);
    return toReviewDTO(saved);
  }

  // Moderator/admin-only (`ListingsController.setStatus`'s `RolesGuard`
  // gate) — any of the three statuses is directly settable; there's no
  // narrower transition graph in the spec's contract.
  async setStatus(ref: string, status: ListingStatus): Promise<ListingDTO> {
    const listing = await this.loadOr404(ref);
    const wasLive = listing.status === ListingStatus.Live;
    listing.status = status;
    const saved = await this.listings.save(listing);
    // Approval = a submitted listing going Live. Notify the submitter once, on
    // the transition into Live (never on a re-save of an already-live listing).
    // No actor: the platform is telling the owner about their own listing.
    // Best-effort; guarded on a real submitter (`ownerId` can be null on
    // admin-seeded listings). Deep-links to the public detail page via `slug`.
    if (
      status === ListingStatus.Live &&
      !wasLive &&
      saved.ownerId
    ) {
      try {
        await this.notifications.create(
          saved.ownerId,
          NotificationType.ListingApproved,
          { source: 'listing', listingSlug: saved.slug },
        );
      } catch {
        // Intentionally ignored — the status change already committed.
      }
    }
    return this.buildDTO(saved);
  }

  // Moderator/admin-only (`ListingsController.askQuestion`'s `RolesGuard`
  // gate). Delivers the moderator's question to the listing's submitter as a
  // DM (reusing `deliverEnquiry`, the cold-contact path that does NOT require
  // an accepted connection), then moves the listing to `question` status. The
  // DM itself raises the standard new-message notification + push, so no
  // separate notification is emitted here.
  //
  // The DM and the status transition can't share one DB transaction (the DM is
  // written through `MessagingService`'s own repositories, and a posted message
  // isn't rollback-able), so we make them atomic-in-effect instead: persist the
  // status first, then send the DM as the last step, and revert the status if
  // the send throws. That way a moderator retry after a failure can never send
  // a duplicate DM, and the listing is never left in `question` with no
  // question actually delivered.
  async askQuestion(
    ref: string,
    moderatorUserId: string,
    body: string,
  ): Promise<ListingDTO> {
    const listing = await this.loadOr404(ref);
    if (!listing.ownerId) {
      throw new BadRequestException('This listing has no submitter to contact');
    }

    const previousStatus = listing.status;
    listing.status = ListingStatus.Question;
    const saved = await this.listings.save(listing);

    try {
      // Throws ForbiddenException on a block either way, or BadRequest if the
      // moderator somehow owns the listing — surfaced to the FE as a specific
      // reason. Sent last so nothing can fail after it and strand a duplicate.
      await this.messaging.deliverEnquiry(
        moderatorUserId,
        listing.ownerId,
        body,
      );
    } catch (error) {
      // DM failed — undo the status change so the state stays consistent and a
      // retry starts clean.
      saved.status = previousStatus;
      await this.listings.save(saved);
      throw error;
    }

    return this.buildDTO(saved);
  }

  // Moderator/admin-only (`ListingsController.setSafeSpace`'s `RolesGuard`
  // gate). Setting `status: none` clears every safe-space column back to its
  // entity default; any other status applies only the fields present on the
  // body (mirrors `applyUpdate`'s conditional-assign idiom). `removed`
  // composes `safeSpaceRemoval` from the admin UI's `reason` field, preserving
  // whatever richer sub-fields a seed already populated.
  async setSafeSpace(
    ref: string,
    dto: UpdateSafeSpaceDto,
  ): Promise<ListingDTO> {
    const listing = await this.loadOr404(ref);

    listing.safeSpaceStatus = dto.status;

    if (dto.status === SafeSpaceStatus.None) {
      listing.safeSpaceTier = null;
      listing.safeSpaceVerifier = '';
      listing.safeSpaceReVerifiedAt = null;
      listing.safeSpaceSub = '';
      listing.safeSpacePromises = [];
      listing.safeSpaceVouches = [];
      listing.safeSpaceRemoval = null;
    } else {
      if (dto.tier !== undefined) listing.safeSpaceTier = dto.tier;
      if (dto.verifier !== undefined) listing.safeSpaceVerifier = dto.verifier;
      if (dto.reVerifiedAt !== undefined)
        listing.safeSpaceReVerifiedAt = dto.reVerifiedAt;
      if (dto.sub !== undefined) listing.safeSpaceSub = dto.sub;
      if (dto.promises !== undefined) listing.safeSpacePromises = dto.promises;
      if (dto.vouches !== undefined) listing.safeSpaceVouches = dto.vouches;

      if (dto.status === SafeSpaceStatus.Removed) {
        listing.safeSpaceRemoval = {
          reason: dto.reason ?? listing.safeSpaceRemoval?.reason ?? '',
          removedDate: listing.safeSpaceRemoval?.removedDate ?? '',
          listedSince: listing.safeSpaceRemoval?.listedSince ?? '',
          flags: listing.safeSpaceRemoval?.flags ?? 0,
          reasonLong: listing.safeSpaceRemoval?.reasonLong ?? [],
          timeline: listing.safeSpaceRemoval?.timeline ?? [],
          whatNow: listing.safeSpaceRemoval?.whatNow ?? '',
        };
      }
    }

    const saved = await this.listings.save(listing);
    return this.buildDTO(saved);
  }

  /** Moderator/admin-only: every live listing plus its current safe-space
   * status, for the admin toggle UI's candidate picker. */
  async listSafeSpaceCandidates(): Promise<
    {
      ref: string;
      slug: string;
      name: string;
      hood: string;
      safeSpaceStatus: SafeSpaceStatus;
    }[]
  > {
    const liveListings = await this.listings.find({
      where: { status: ListingStatus.Live },
      order: { name: 'ASC' },
      // Bounded like the public directory lists — the candidate picker is a
      // whole-array (unpaginated) response, so cap it so it can never dump the
      // entire live-listings table.
      take: DEFAULT_LIST_LIMIT,
    });
    return liveListings.map((listing) => ({
      ref: listing.ref,
      slug: listing.slug,
      name: listing.name,
      hood: listing.hood,
      safeSpaceStatus: listing.safeSpaceStatus,
    }));
  }

  // --- internals ---

  private async loadOr404(ref: string): Promise<Listing> {
    const listing = await this.listings.findOne({ where: { ref } });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    return listing;
  }

  private assertOwner(listing: Listing, userId: string): void {
    if (listing.ownerId !== userId) {
      throw new ForbiddenException('Only the owner can do that');
    }
  }

  private async buildDTO(listing: Listing): Promise<ListingDTO> {
    const refs = await new MemberLookup(this.profiles).byUserIds([
      listing.ownerId,
    ]);
    return toListingDTO(listing, refs.get(listing.ownerId) ?? null);
  }

  /** `QPL-<year>-<4-digit seq>` (e.g. `QPL-2026-0007`), matching the
   * frontend's `PendingListing.ref` example verbatim. Backed by a dedicated
   * Postgres sequence (`listings_ref_seq`, created in the migration) so it's
   * atomic and monotonic — no retry loop needed, unlike the slug allocation
   * below (a sequence's `nextval()` can never collide). */
  private async nextRef(): Promise<string> {
    const year = new Date().getFullYear();
    const rows = await this.dataSource.query<{ seq: string }[]>(
      "SELECT nextval('listings_ref_seq') AS seq",
    );
    // invariant: `SELECT nextval(...)` always returns exactly one row.
    const seq = Number(rows[0]!.seq);
    return `QPL-${year}-${String(seq).padStart(4, '0')}`;
  }

  // The slug pre-check (`allocateUniqueSlug`) can lose a race to a concurrent
  // submission landing between the read and this INSERT; the unique index on
  // `slug` is the real backstop and turns that race into a 23505, forcing a
  // retry with a freshly recomputed slug (mirrors
  // `CompaniesService.createWithUniqueSlug`/
  // `PartnersService.createWithUniqueSlug`). `ref` is computed once by the
  // caller, outside this loop, since it can never collide.
  private async createWithUniqueSlug(
    ownerId: string,
    ref: string,
    dto: CreateListingDto,
  ): Promise<Listing> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const slug = await allocateUniqueSlug(slugify(dto.name, 'listing'), (s) =>
        this.listings.exists({ where: { slug: s } }),
      );

      try {
        return await this.listings.save(
          this.listings.create({
            ref,
            slug,
            ownerId,
            status: ListingStatus.Review,
            ...normalizeCreate(dto),
          }),
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          if (attempt < MAX_ATTEMPTS) {
            // Lost the slug race — recompute and retry.
            continue;
          }
          throw new ConflictException(
            'Could not allocate a unique listing slug',
          );
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns a saved listing or throws above.
    throw new ConflictException('Could not allocate a unique listing slug');
  }
}
