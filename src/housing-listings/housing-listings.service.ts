import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { DataSource, Repository } from 'typeorm';
import { actorFromLookup, presentActorIds } from '../common/nullable-actor';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { toStoredPlainText } from '../communities/community-plain-text';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { MessagingService } from '../messaging/messaging.service';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import { assertNoForeignUploadIntroduced } from '../storage/assert-no-foreign-upload';
import { CreateHousingEnquiryDto } from './dto/create-housing-enquiry.dto';
import { CreateHousingListingDto } from './dto/create-housing-listing.dto';
import { UpdateHousingListingDto } from './dto/update-housing-listing.dto';
import {
  HousingListerKind,
  HousingListing,
  HousingListingStatus,
} from './entities/housing-listing.entity';
import { resolveHousingLocation } from './housing-city';
import {
  HousingListingDTO,
  toHousingListingDTO,
} from './housing-listing-response';
import { HousingListerLookup } from './housing-lister-lookup';
import { assessHousingRisk, HousingRiskAssessment } from './housing-risk';

// Postgres unique-violation SQLSTATE. Mirrors the file-local helper each
// service (`ListingsService`, `CompaniesService`) keeps by convention.

/**
 * Every member-typed free-text field on a housing listing is stripped of markup
 * ONCE, here at the write boundary, and stored as plain text.
 *
 * This repo strips markup where the value is persisted rather than at each
 * render site (`toStoredPlainText`, `communities/community-plain-text.ts`, and
 * `sanitizeArticleHtml` before it), because a crafted API call bypasses
 * whatever the client does on the way in and because a value stripped at read
 * time is only as safe as the last renderer somebody added. None of these
 * fields is rich text: a room description, a feature chip and an "ideal for"
 * chip are prose, so the allowlist is empty and only the text survives.
 *
 * `title` and `blurb` matter twice over: they are the two fields that also feed
 * `slugify` and the deterministic risk scorer, and both should see the same
 * characters a reader will.
 */
function toStoredArray(values: string[]): string[] {
  return values
    .map((value) => toStoredPlainText(value))
    .filter((value) => value.length > 0);
}

/** Applies only the fields present on a PATCH body (mirrors
 * `ListingsService.applyUpdate`'s conditional-spread idiom).
 *
 * `city`/`area` are the one pair that is NOT applied verbatim: they go through
 * `resolveHousingLocation` together, so a PATCH can never put a neighbourhood
 * in the city column (see `housing-city.ts`). Passing the listing's stored
 * `area` as the fallback keeps a city-only PATCH from wiping the area. */
function applyUpdate(
  listing: HousingListing,
  dto: UpdateHousingListingDto,
): void {
  const isLocationTouched = dto.city !== undefined || dto.area !== undefined;
  const location = isLocationTouched
    ? resolveHousingLocation({
        city: dto.city,
        area: dto.area !== undefined ? dto.area : listing.area,
      })
    : null;

  Object.assign(listing, {
    ...(dto.type !== undefined ? { type: dto.type } : {}),
    ...(dto.title !== undefined ? { title: toStoredPlainText(dto.title) } : {}),
    ...(dto.blurb !== undefined ? { blurb: toStoredPlainText(dto.blurb) } : {}),
    ...(location !== null
      ? { city: location.city, area: location.area ?? '' }
      : {}),
    ...(dto.rentEuros !== undefined ? { rentEuros: dto.rentEuros } : {}),
    ...(dto.bedrooms !== undefined ? { bedrooms: dto.bedrooms } : {}),
    ...(dto.billsIncluded !== undefined
      ? { billsIncluded: dto.billsIncluded }
      : {}),
    ...(dto.accessibilityInfo !== undefined
      ? { accessibilityInfo: toStoredPlainText(dto.accessibilityInfo) }
      : {}),
    ...(dto.listerKind !== undefined ? { listerKind: dto.listerKind } : {}),
    ...(dto.availableFrom !== undefined
      ? { availableFrom: dto.availableFrom }
      : {}),
    ...(dto.minStayMonths !== undefined
      ? { minStayMonths: dto.minStayMonths }
      : {}),
    ...(dto.description !== undefined
      ? { description: toStoredPlainText(dto.description) }
      : {}),
    ...(dto.features !== undefined
      ? { features: toStoredArray(dto.features) }
      : {}),
    ...(dto.idealFor !== undefined
      ? { idealFor: toStoredArray(dto.idealFor) }
      : {}),
    ...(dto.gallery !== undefined ? { gallery: dto.gallery } : {}),
    ...(dto.virtualTourUrl !== undefined
      ? { virtualTourUrl: dto.virtualTourUrl }
      : {}),
  });
}

/**
 * The public-facing fields a moderator actually reviewed before a listing went
 * `live`: the copy, the price, the location, the photos and the transparency
 * disclosures. An owner PATCH that changes ANY of them re-opens the review
 * (`update()` below) — without this, a listing could be approved clean and then
 * have a discriminatory description, a scam rent, an IBAN or an unrelated
 * gallery patched in while it stayed publicly browsable, keeping the verified
 * chip it earned before the edit (BE-HSG-02).
 *
 * Deliberately EXCLUDED so an owner keeps them self-service on a live listing,
 * because none of them can carry moderatable content: `availableFrom` and
 * `minStayMonths` are scheduling facts. `filledAt`/`expiresAt` are not
 * reachable from this DTO at all — they move through `markFilled`/
 * `markAvailable`/`extend`, which stay unaffected on purpose so an owner can
 * always take their own home off browse without waiting for a moderator.
 */
const MODERATED_HOUSING_FIELDS = [
  'type',
  'title',
  'blurb',
  'city',
  'area',
  'rentEuros',
  'bedrooms',
  'billsIncluded',
  'accessibilityInfo',
  'listerKind',
  'description',
  'features',
  'idealFor',
  'gallery',
  'virtualTourUrl',
] as const satisfies readonly (keyof HousingListing)[];

/**
 * A stable fingerprint of the moderated fields, so `update()` can tell a real
 * content change from a PATCH that re-sends the same values. Every listed field
 * is a scalar or a string array, so `JSON.stringify` over them is total and
 * order-stable; arrays compare by value AND order, which is intended (a
 * re-ordered gallery IS a change — the lead photo moved).
 */
function moderatedHousingFingerprint(listing: HousingListing): string {
  return JSON.stringify(
    MODERATED_HOUSING_FIELDS.map((field) => listing[field]),
  );
}

export interface ListMyHousingQueryInput {
  page?: number;
}

// HSG-3: how long a new (or freshly-extended) listing stays live before the
// daily sweep withholds it from public browse. 60 days comfortably covers a
// typical room/sublet search cycle without letting a stale listing linger
// indefinitely (mirrors the `board_posts` kind-dependent expiry precedent —
// looking=30d/offering=90d — sitting between the two since a housing listing
// is neither).
const DEFAULT_LISTING_LIFETIME_DAYS = 60;

/** Exported for `HousingListingModerationService`: a listing that sat in the
 * review queue past its own expiry would otherwise be approved into a state
 * where browse already withholds it, so approval refreshes the window. */
export function computeExpiry(from: Date = new Date()): Date {
  return new Date(
    from.getTime() + DEFAULT_LISTING_LIFETIME_DAYS * 24 * 60 * 60 * 1000,
  );
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
    const listing = await this.loadOwnedOr404(ref, userId);
    return this.buildDTO(listing);
  }

  async update(
    ref: string,
    userId: string,
    dto: UpdateHousingListingDto,
  ): Promise<HousingListingDTO> {
    const listing = await this.loadOwnedOr404(ref, userId);
    // Snapshot BEFORE the merge so a real content change is distinguishable
    // from a PATCH that re-sends the same values (which must not bounce a
    // listing back into the queue for nothing).
    const before = moderatedHousingFingerprint(listing);
    // Runs BEFORE any mutation (`HousingListingsController.update` is on
    // `SHARED_UPLOAD_HANDLERS`, so the interceptor's foreign-upload check is
    // exempted for this handler): a co-lister may re-save the gallery whoever
    // uploaded its images, but may not add a NEW gallery image that is not
    // theirs. Each incoming image is compared against the full set of currently
    // stored gallery keys, so a re-sent stored key passes while a brand-new
    // foreign key is refused.
    if (dto.gallery !== undefined) {
      for (const incomingGalleryKey of dto.gallery) {
        assertNoForeignUploadIntroduced(
          userId,
          incomingGalleryKey,
          listing.gallery,
        );
      }
    }
    applyUpdate(listing, dto);
    // Re-score on every edit — a listing that was clean can be edited to add
    // off-platform payment language or an implausible rent, and the queue must
    // reflect its current content, not what it looked like at create time.
    const level = await this.listerVerificationLevel(listing.ownerId);
    const assessment = this.riskForListing(listing, level);
    listing.riskScore = assessment.score;
    listing.riskReasons = assessment.reasons;
    // BE-HSG-02 + LOC-01: moderation used to happen exactly once, at approval.
    // An owner editing any field a moderator actually looked at now returns the
    // listing to `review`, whatever it was before:
    //  - from `live`, it leaves public browse until a human clears it again, so
    //    a clean approval cannot be edited into a discriminatory description, a
    //    scam rent, an IBAN or an unrelated gallery while it stays browsable;
    //  - from `question`, this is the LISTER ANSWERING the requested changes,
    //    and without it a listing a moderator sent back would sit in
    //    "changes requested" forever, never re-entering any queue;
    //  - from `rejected`/`taken_down`, a refusal stops being a grave: a lister
    //    who fixes the actual problem gets re-reviewed rather than having to
    //    post a second listing to work around the first.
    // Approval (`setStatus` on the moderation service) re-fires the
    // saved-search go-live alert, because by then the listing is not live.
    // The re-scored `riskScore` above only ever sorted the queue; nothing
    // consulted it as a gate, so the score alone could never have caught this.
    if (moderatedHousingFingerprint(listing) !== before) {
      listing.status = HousingListingStatus.Review;
    }
    const saved = await this.listings.save(listing);
    return this.buildDTO(saved);
  }

  async remove(ref: string, userId: string): Promise<void> {
    const listing = await this.loadOwnedOr404(ref, userId);
    await this.listings.remove(listing);
  }

  /** Owner self-service "found a place" (HSG-1) — withholds the listing from
   * public browse (see `HousingDirectoryService.browse`) without touching the
   * moderation `status` or deleting anything. Reversible via `markAvailable`. */
  async markFilled(ref: string, userId: string): Promise<HousingListingDTO> {
    const listing = await this.loadOwnedOr404(ref, userId);
    listing.filledAt = new Date();
    const saved = await this.listings.save(listing);
    return this.buildDTO(saved);
  }

  /** Reverses `markFilled`/an auto-expiry. If the listing's `expiresAt` has
   * already passed, also refreshes it — otherwise the next daily sweep would
   * immediately re-mark it filled, silently undoing the owner's action. */
  async markAvailable(ref: string, userId: string): Promise<HousingListingDTO> {
    const listing = await this.loadOwnedOr404(ref, userId);
    listing.filledAt = null;
    if (listing.expiresAt.getTime() <= Date.now()) {
      listing.expiresAt = computeExpiry();
    }
    const saved = await this.listings.save(listing);
    return this.buildDTO(saved);
  }

  /** Owner self-service "renew" (HSG-3) — refreshes `expiresAt` to a fresh
   * `DEFAULT_LISTING_LIFETIME_DAYS`-day window. Deliberately does not touch
   * `filledAt`: extending a listing the owner marked filled on purpose
   * shouldn't silently un-hide it from browse — call `markAvailable` for that. */
  async extend(ref: string, userId: string): Promise<HousingListingDTO> {
    const listing = await this.loadOwnedOr404(ref, userId);
    listing.expiresAt = computeExpiry();
    const saved = await this.listings.save(listing);
    return this.buildDTO(saved);
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
    // NULL once the lister erased their account
    // (`SetNullContentAuthorFksOnUserErasure1794610000000`). There is no inbox
    // left to deliver to, so the enquiry is refused rather than sent nowhere.
    const listerId = listing.ownerId;
    if (listerId === null) {
      throw new BadRequestException(
        'This listing no longer has a lister to contact',
      );
    }
    if (listerId === fromUserId) {
      throw new BadRequestException(
        'You cannot send an enquiry on your own listing',
      );
    }
    // Baseline gate: reaching out about a home requires the affirming pledge.
    await this.affirmingPledge.requireAccepted(fromUserId);
    // Step-up gate: reaching out about a home needs a phone-verified account.
    await this.verification.requireLevel(fromUserId, VerificationLevel.Phone);
    return this.messaging.deliverEnquiry(fromUserId, listerId, dto.body);
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

  /**
   * Owner-scoped load: folds ownership into the query so a valid `ref` owned by
   * someone else 404s exactly like a non-existent one, instead of loading it and
   * then 403-ing. Refs are a monotonic sequence, so a 403-vs-404 split would be
   * an existence oracle (a member could enumerate `QPH-<year>-NNNN` and learn
   * which listings, including in-review/rejected ones, exist). Use this for every
   * owner-management read/update/remove path; keep `loadOr404` only where a
   * non-owner is legitimately allowed to load (`HousingListingModerationService`
   * keeps its own moderator-gated load).
   */
  private async loadOwnedOr404(
    ref: string,
    userId: string,
  ): Promise<HousingListing> {
    const listing = await this.listings.findOne({
      where: { ref, ownerId: userId },
    });
    if (!listing) {
      throw new NotFoundException('Housing listing not found');
    }
    return listing;
  }

  private async mapRows(rows: HousingListing[]): Promise<HousingListingDTO[]> {
    if (!rows.length) return [];
    const ownerIds = presentActorIds(rows.map((r) => r.ownerId));
    const refs = await new HousingListerLookup(this.profiles).byUserIds(
      ownerIds,
    );
    const levels = await this.verification.levelsForUsers(ownerIds);
    // Owner-facing read (`listMine`): the exact point + address are theirs to
    // see (`precise`), and so is the moderator's last decision on their own
    // listing (`includeDecision`) — a lister sent back for changes has to be
    // able to read WHY without asking anybody.
    return rows.map((r) =>
      toHousingListingDTO(
        r,
        actorFromLookup(refs, r.ownerId) ?? null,
        actorFromLookup(levels, r.ownerId) ?? VerificationLevel.Email,
        true,
        true,
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
      // BE-HSG-08: the "ideal for" chips are scanned as text too.
      idealFor: listing.idealFor,
      listerVerificationLevel: level,
    });
  }

  /**
   * The lister's assurance level, tolerating an erased lister. `ownerId` is
   * NULL once their account is erased
   * (`SetNullContentAuthorFksOnUserErasure1794610000000`); there is no
   * standing left to read, so the risk model and the DTO both see the lowest
   * level rather than a level belonging to nobody.
   */
  private async listerVerificationLevel(
    ownerId: string | null,
  ): Promise<VerificationLevel> {
    return ownerId === null
      ? VerificationLevel.Email
      : this.verification.levelForUser(ownerId);
  }

  private async buildDTO(listing: HousingListing): Promise<HousingListingDTO> {
    const refs = await new HousingListerLookup(this.profiles).byUserIds(
      presentActorIds([listing.ownerId]),
    );
    const level = await this.listerVerificationLevel(listing.ownerId);
    // Every caller of `buildDTO` is owner-gated (create / getByRef / the owner
    // lifecycle mutations), so both the precise location and the moderator's
    // decision on the caller's OWN listing are disclosable here.
    return toHousingListingDTO(
      listing,
      actorFromLookup(refs, listing.ownerId) ?? null,
      level,
      true,
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
    // Markup is stripped ONCE here, at the write boundary (see `toStoredArray`
    // above), so the risk scorer, `slugify` and every reader all see the same
    // characters, and no renderer downstream has to strip anything.
    const stored = {
      title: toStoredPlainText(dto.title),
      blurb: toStoredPlainText(dto.blurb ?? ''),
      description: toStoredPlainText(dto.description ?? ''),
      accessibilityInfo: toStoredPlainText(dto.accessibilityInfo),
      features: toStoredArray(dto.features ?? []),
      idealFor: toStoredArray(dto.idealFor ?? []),
    };
    // The backend owns the city (LOC-09). See `housing-city.ts`: an omitted,
    // empty or unrecognised city stores "Lisbon", and a neighbourhood sent in
    // the city field moves into `area` rather than corrupting the column that
    // the browse filter, the centroid pin and the saved-search matcher read.
    const location = resolveHousingLocation({ city: dto.city, area: dto.area });
    // Score deterministically from the submission + who's posting. High-risk
    // listings still land in `review` (as every listing does) — the score sorts
    // the human queue and keeps a risky listing from ever auto-publishing.
    const assessment = assessHousingRisk({
      type: dto.type,
      title: stored.title,
      blurb: stored.blurb,
      description: stored.description,
      rentEuros: dto.rentEuros,
      accessibilityInfo: stored.accessibilityInfo,
      gallery: dto.gallery ?? [],
      features: stored.features,
      // BE-HSG-08: the "ideal for" chips are scanned as text too.
      idealFor: stored.idealFor,
      listerVerificationLevel: level,
    });
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const slug = await allocateUniqueSlug(
        slugify(stored.title, 'home'),
        (s) => this.listings.exists({ where: { slug: s } }),
      );
      try {
        return await this.listings.save(
          this.listings.create({
            ref,
            slug,
            ownerId,
            status: HousingListingStatus.Review,
            type: dto.type,
            title: stored.title,
            blurb: stored.blurb,
            city: location.city,
            area: location.area ?? '',
            rentEuros: dto.rentEuros,
            bedrooms: dto.bedrooms ?? null,
            billsIncluded: dto.billsIncluded ?? false,
            // BE-HSG-07: hard-set, never read from the submission. Posting a
            // home requires the affirming pledge (see the gate at the top of
            // `create`), so every listing that exists is affirming by
            // definition. Storing the lister's own boolean modelled affirmation
            // as an opt-in attribute of individual homes and let a public card
            // read "not LGBTQ friendly" on a listing posted under the pledge,
            // which is the exact framing the mandatory baseline replaced. The
            // DTO field is accepted and ignored rather than removed, because
            // the global ValidationPipe runs `forbidNonWhitelisted` and would
            // 400 a client still sending it.
            lgbtqFriendly: true,
            accessibilityInfo: stored.accessibilityInfo,
            listerKind: dto.listerKind ?? HousingListerKind.Member,
            availableFrom: dto.availableFrom ?? null,
            minStayMonths: dto.minStayMonths ?? null,
            description: stored.description,
            features: stored.features,
            idealFor: stored.idealFor,
            gallery: dto.gallery ?? [],
            virtualTourUrl: dto.virtualTourUrl ?? null,
            riskScore: assessment.score,
            riskReasons: assessment.reasons,
            filledAt: null,
            expiresAt: computeExpiry(),
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
