import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { DataSource, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import {
  DEFAULT_LIST_LIMIT,
  normalizePage,
  paginate,
  Paginated,
} from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { MessagingService } from '../messaging/messaging.service';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import { CreateHousingEnquiryDto } from './dto/create-housing-enquiry.dto';
import { CreateHousingListingDto } from './dto/create-housing-listing.dto';
import { UpdateHousingListingDto } from './dto/update-housing-listing.dto';
import {
  HousingListerKind,
  HousingListing,
  HousingListingStatus,
} from './entities/housing-listing.entity';
import {
  AdminHousingListingDTO,
  HousingListingDTO,
  toAdminHousingListingDTO,
  toHousingListingDTO,
} from './housing-listing-response';
import { assessHousingRisk, HousingRiskAssessment } from './housing-risk';
import { deriveListingVerified } from './housing-verified';
import {
  HOUSING_LISTING_WENT_LIVE,
  HousingListingWentLiveEvent,
} from './housing-listing.events';

// Postgres unique-violation SQLSTATE. Mirrors the file-local helper each
// service (`ListingsService`, `CompaniesService`) keeps by convention.
/** Applies only the fields present on a PATCH body (mirrors
 * `ListingsService.applyUpdate`'s conditional-spread idiom). */
function applyUpdate(
  listing: HousingListing,
  dto: UpdateHousingListingDto,
): void {
  Object.assign(listing, {
    ...(dto.type !== undefined ? { type: dto.type } : {}),
    ...(dto.title !== undefined ? { title: dto.title } : {}),
    ...(dto.blurb !== undefined ? { blurb: dto.blurb } : {}),
    ...(dto.city !== undefined ? { city: dto.city } : {}),
    ...(dto.area !== undefined ? { area: dto.area } : {}),
    ...(dto.rentEuros !== undefined ? { rentEuros: dto.rentEuros } : {}),
    ...(dto.bedrooms !== undefined ? { bedrooms: dto.bedrooms } : {}),
    ...(dto.billsIncluded !== undefined
      ? { billsIncluded: dto.billsIncluded }
      : {}),
    ...(dto.lgbtqFriendly !== undefined
      ? { lgbtqFriendly: dto.lgbtqFriendly }
      : {}),
    ...(dto.accessibilityInfo !== undefined
      ? { accessibilityInfo: dto.accessibilityInfo }
      : {}),
    ...(dto.listerKind !== undefined ? { listerKind: dto.listerKind } : {}),
    ...(dto.availableFrom !== undefined
      ? { availableFrom: dto.availableFrom }
      : {}),
    ...(dto.minStayMonths !== undefined
      ? { minStayMonths: dto.minStayMonths }
      : {}),
    ...(dto.description !== undefined ? { description: dto.description } : {}),
    ...(dto.features !== undefined ? { features: dto.features } : {}),
    ...(dto.idealFor !== undefined ? { idealFor: dto.idealFor } : {}),
    ...(dto.gallery !== undefined ? { gallery: dto.gallery } : {}),
    ...(dto.virtualTourUrl !== undefined
      ? { virtualTourUrl: dto.virtualTourUrl }
      : {}),
  });
}

export interface ListMyHousingQueryInput {
  page?: number;
}

/**
 * Member-submitted housing listings. `ref` (`QPH-<year>-<seq>`) is the owner
 * mutation identifier; `GET/PATCH/DELETE /housing-listings/:ref` are all
 * owner-gated (403 for a non-owner caller). Public browse lives in
 * `HousingDirectoryService`.
 */
@Injectable()
export class HousingListingsService {
  constructor(
    @InjectRepository(HousingListing)
    private readonly listings: Repository<HousingListing>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
    private readonly messaging: MessagingService,
    private readonly verification: VerificationService,
    private readonly affirmingPledge: AffirmingPledgeService,
    // Fire-and-forget domain events (global EventEmitter2). Used to announce a
    // listing going live so the saved-search alerts listener can match + notify.
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(
    ownerId: string,
    dto: CreateHousingListingDto,
  ): Promise<HousingListingDTO> {
    // Baseline gate: posting a home means committing to the LGBTQ+ affirming
    // pledge (throws a typed AFFIRMING_PLEDGE_REQUIRED 403 until accepted).
    await this.affirmingPledge.requireAccepted(ownerId);
    // Step-up gate: posting a publicly-browsable listing needs at least a
    // phone-verified account (throws a typed VERIFICATION_REQUIRED 403).
    await this.verification.requireLevel(ownerId, VerificationLevel.Phone);
    // The lister's real assurance level is a risk signal — fetch it once so the
    // deterministic score reflects who is posting, not just the text.
    const level = await this.verification.levelForUser(ownerId);
    const ref = await this.nextRef();
    const saved = await this.createWithUniqueSlug(ownerId, ref, dto, level);
    return this.buildDTO(saved);
  }

  async listMine(
    ownerId: string,
    query: ListMyHousingQueryInput,
  ): Promise<Paginated<HousingListingDTO>> {
    const page = normalizePage(query.page);
    const qb = this.listings
      .createQueryBuilder('l')
      .where('l.owner_id = :ownerId', { ownerId })
      .orderBy('l.created_at', 'DESC');

    return paginate(qb, page, (rows) => this.mapRows(rows));
  }

  async getByRef(ref: string, userId: string): Promise<HousingListingDTO> {
    const listing = await this.loadOr404(ref);
    this.assertOwner(listing, userId);
    return this.buildDTO(listing);
  }

  async update(
    ref: string,
    userId: string,
    dto: UpdateHousingListingDto,
  ): Promise<HousingListingDTO> {
    const listing = await this.loadOr404(ref);
    this.assertOwner(listing, userId);
    applyUpdate(listing, dto);
    // Re-score on every edit — a listing that was clean can be edited to add
    // off-platform payment language or an implausible rent, and the queue must
    // reflect its current content, not what it looked like at create time.
    const level = await this.verification.levelForUser(listing.ownerId);
    const assessment = this.riskForListing(listing, level);
    listing.riskScore = assessment.score;
    listing.riskReasons = assessment.reasons;
    const saved = await this.listings.save(listing);
    return this.buildDTO(saved);
  }

  async remove(ref: string, userId: string): Promise<void> {
    const listing = await this.loadOr404(ref);
    this.assertOwner(listing, userId);
    await this.listings.remove(listing);
  }

  /**
   * Sends an enquiry about a LIVE listing to its lister's inbox (via the
   * messaging module), returning the conversation id so the client can deep-link
   * to the thread. A member cannot enquire on their own listing.
   */
  async createEnquiry(
    ref: string,
    fromUserId: string,
    dto: CreateHousingEnquiryDto,
  ): Promise<{ conversationId: string }> {
    const listing = await this.loadLiveOr404(ref);
    if (listing.ownerId === fromUserId) {
      throw new BadRequestException(
        'You cannot send an enquiry on your own listing',
      );
    }
    // Baseline gate: reaching out about a home requires the affirming pledge.
    await this.affirmingPledge.requireAccepted(fromUserId);
    // Step-up gate: reaching out about a home needs a phone-verified account.
    await this.verification.requireLevel(fromUserId, VerificationLevel.Phone);
    return this.messaging.deliverEnquiry(fromUserId, listing.ownerId, dto.body);
  }

  /** Moderator/admin: every listing incl. non-live, RISKIEST first (P0.6), then
   * newest — so the human review queue leads with the listings most likely to
   * be a scam/discrimination/off-platform problem, reasons attached. */
  async listAllForAdmin(): Promise<AdminHousingListingDTO[]> {
    const rows = await this.listings.find({
      order: { riskScore: 'DESC', createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return this.mapRowsForAdmin(rows);
  }

  /** Moderator/admin only — any status is directly settable. */
  async setStatus(
    ref: string,
    status: HousingListingStatus,
  ): Promise<HousingListingDTO> {
    const listing = await this.loadOr404(ref);
    const wasLive = listing.status === HousingListingStatus.Live;
    listing.status = status;
    const saved = await this.listings.save(listing);
    // A listing transitioning INTO live (a new listing clearing review, or a
    // re-approval) is the moment saved-search alerts fire. Compute the verified
    // state once here — it needs the lister's assurance level — and hand it to
    // the alerts listener so it never re-derives per saved search.
    if (!wasLive && saved.status === HousingListingStatus.Live) {
      const level = await this.verification.levelForUser(saved.ownerId);
      const listingVerified = deriveListingVerified(saved, level).verified;
      const event: HousingListingWentLiveEvent = {
        listing: saved,
        listingVerified,
      };
      this.eventEmitter.emit(HOUSING_LISTING_WENT_LIVE, event);
    }
    return this.buildDTO(saved);
  }

  /** Loads a listing that must be publicly live (used by the enquiry flow). */
  async loadLiveOr404(ref: string): Promise<HousingListing> {
    const listing = await this.listings.findOne({
      where: { ref, status: HousingListingStatus.Live },
    });
    if (!listing) {
      throw new NotFoundException('Housing listing not found');
    }
    return listing;
  }

  // --- internals ---

  private async loadOr404(ref: string): Promise<HousingListing> {
    const listing = await this.listings.findOne({ where: { ref } });
    if (!listing) {
      throw new NotFoundException('Housing listing not found');
    }
    return listing;
  }

  private assertOwner(listing: HousingListing, userId: string): void {
    if (listing.ownerId !== userId) {
      throw new ForbiddenException('Only the owner can do that');
    }
  }

  private async mapRows(rows: HousingListing[]): Promise<HousingListingDTO[]> {
    if (!rows.length) return [];
    const ownerIds = rows.map((r) => r.ownerId);
    const refs = await new MemberLookup(this.profiles).byUserIds(ownerIds);
    const levels = await this.verification.levelsForUsers(ownerIds);
    // Owner-facing (`listMine`) + moderator (`listAllForAdmin`) reads: the exact
    // point + address are theirs to see, so map with `precise: true`.
    return rows.map((r) =>
      toHousingListingDTO(
        r,
        refs.get(r.ownerId) ?? null,
        levels.get(r.ownerId) ?? VerificationLevel.Email,
        true,
      ),
    );
  }

  /** Admin rows: same hydration as `mapRows`, but through the admin mapper so
   * `riskScore`/`riskReasons` ride along for the risk-sorted queue. */
  private async mapRowsForAdmin(
    rows: HousingListing[],
  ): Promise<AdminHousingListingDTO[]> {
    if (!rows.length) return [];
    const ownerIds = rows.map((row) => row.ownerId);
    const refs = await new MemberLookup(this.profiles).byUserIds(ownerIds);
    const levels = await this.verification.levelsForUsers(ownerIds);
    return rows.map((row) =>
      toAdminHousingListingDTO(
        row,
        refs.get(row.ownerId) ?? null,
        levels.get(row.ownerId) ?? VerificationLevel.Email,
      ),
    );
  }

  /** Builds the deterministic risk assessment from a listing entity's current
   * fields plus the lister's assurance level (see `housing-risk.ts`). */
  private riskForListing(
    listing: HousingListing,
    level: VerificationLevel,
  ): HousingRiskAssessment {
    return assessHousingRisk({
      type: listing.type,
      title: listing.title,
      blurb: listing.blurb,
      description: listing.description,
      rentEuros: listing.rentEuros,
      accessibilityInfo: listing.accessibilityInfo,
      gallery: listing.gallery,
      features: listing.features,
      listerVerificationLevel: level,
    });
  }

  private async buildDTO(listing: HousingListing): Promise<HousingListingDTO> {
    const refs = await new MemberLookup(this.profiles).byUserIds([
      listing.ownerId,
    ]);
    const level = await this.verification.levelForUser(listing.ownerId);
    // Every caller of `buildDTO` is owner- or moderator-gated (create / getByRef
    // / setStatus), so the precise location is always disclosable here.
    return toHousingListingDTO(
      listing,
      refs.get(listing.ownerId) ?? null,
      level,
      true,
    );
  }

  /** `QPH-<year>-<4-digit seq>`, backed by the `housing_listings_ref_seq`
   * sequence (created in the migration) — atomic, no retry loop. */
  private async nextRef(): Promise<string> {
    const year = new Date().getFullYear();
    const rows = await this.dataSource.query<{ seq: string }[]>(
      "SELECT nextval('housing_listings_ref_seq') AS seq",
    );
    // invariant: `SELECT nextval(...)` always returns exactly one row.
    const seq = Number(rows[0]!.seq);
    return `QPH-${year}-${String(seq).padStart(4, '0')}`;
  }

  // Slug pre-check can lose a race to a concurrent insert; the unique index is
  // the backstop (23505 -> recompute + retry). Mirrors
  // `ListingsService.createWithUniqueSlug`.
  private async createWithUniqueSlug(
    ownerId: string,
    ref: string,
    dto: CreateHousingListingDto,
    level: VerificationLevel,
  ): Promise<HousingListing> {
    // Score deterministically from the submission + who's posting. High-risk
    // listings still land in `review` (as every listing does) — the score sorts
    // the human queue and keeps a risky listing from ever auto-publishing.
    const assessment = assessHousingRisk({
      type: dto.type,
      title: dto.title,
      blurb: dto.blurb ?? '',
      description: dto.description ?? '',
      rentEuros: dto.rentEuros,
      accessibilityInfo: dto.accessibilityInfo,
      gallery: dto.gallery ?? [],
      features: dto.features ?? [],
      listerVerificationLevel: level,
    });
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const slug = await allocateUniqueSlug(slugify(dto.title, 'home'), (s) =>
        this.listings.exists({ where: { slug: s } }),
      );
      try {
        return await this.listings.save(
          this.listings.create({
            ref,
            slug,
            ownerId,
            status: HousingListingStatus.Review,
            type: dto.type,
            title: dto.title,
            blurb: dto.blurb ?? '',
            city: dto.city,
            area: dto.area ?? '',
            rentEuros: dto.rentEuros,
            bedrooms: dto.bedrooms ?? null,
            billsIncluded: dto.billsIncluded ?? false,
            lgbtqFriendly: dto.lgbtqFriendly ?? false,
            accessibilityInfo: dto.accessibilityInfo,
            listerKind: dto.listerKind ?? HousingListerKind.Member,
            availableFrom: dto.availableFrom ?? null,
            minStayMonths: dto.minStayMonths ?? null,
            description: dto.description ?? '',
            features: dto.features ?? [],
            idealFor: dto.idealFor ?? [],
            gallery: dto.gallery ?? [],
            virtualTourUrl: dto.virtualTourUrl ?? null,
            riskScore: assessment.score,
            riskReasons: assessment.reasons,
          }),
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          if (attempt < MAX_ATTEMPTS) continue;
          throw new ConflictException(
            'Could not allocate a unique housing listing slug',
          );
        }
        throw err;
      }
    }
    throw new ConflictException(
      'Could not allocate a unique housing listing slug',
    );
  }
}
