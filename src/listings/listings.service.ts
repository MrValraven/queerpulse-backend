import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import {
  Brackets,
  DataSource,
  In,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { MemberLookup, toMemberRef } from '../common/member-ref';
import { MessagingService } from '../messaging/messaging.service';
import { StorageService } from '../storage/storage.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { ReportsService } from '../reports/reports.service';
import { ReportDTO } from '../reports/report-response';
import { ReportSubjectType } from '../reports/entities/report.entity';
import { BulkListingResultDTO } from './dto/bulk-listing.dto';
import { DisputeListingDto } from './dto/dispute-listing.dto';
import {
  ListingHistoryDTO,
  toListingHistoryDTO,
} from './dto/listing-history.dto';
import {
  ListingModerationEventDTO,
  toListingModerationEventDTO,
} from './dto/listing-moderation-event.dto';
import {
  ListingQuestionDTO,
  toListingQuestionDTO,
} from './dto/listing-question.dto';
import { ListingQueueSort } from './dto/list-listing-queue.query';
import {
  DEFAULT_LIST_LIMIT,
  normalizePage,
  paginate,
  Paginated,
} from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { Profile } from '../users/entities/profile.entity';
import { CreateListingDto, ListingDayHoursDto } from './dto/create-listing.dto';
import { ReplyToReviewDto } from './dto/reply-to-review.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { UpdateSafeSpaceDto } from './dto/update-safe-space.dto';
import {
  ListingModerationAction,
  ListingModerationEvent,
} from './entities/listing-moderation-event.entity';
import { ListingQuestion } from './entities/listing-question.entity';
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
  SimilarListingDTO,
  toListingDTO,
  toReviewDTO,
  toSimilarListing,
} from './listing-response';

// Postgres unique-violation SQLSTATE. Mirrors `CompaniesService`'s/
// `PartnersService`'s identical file-local helper (not shared/exported, kept
// consistent with that precedent).
/** Great-circle distance in metres between two lat/lng points (haversine).
 * Used by the wizard's similar-listing dedupe (`findSimilar`) to re-check the
 * bounding-box prefilter's candidates against the true ~150m radius. */
function haversineMeters(
  latitude1: number,
  longitude1: number,
  latitude2: number,
  longitude2: number,
): number {
  const EARTH_RADIUS_METERS = 6_371_000;
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const deltaLatitude = toRadians(latitude2 - latitude1);
  const deltaLongitude = toRadians(longitude2 - longitude1);
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(latitude1)) *
      Math.cos(toRadians(latitude2)) *
      Math.sin(deltaLongitude / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

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
    city: dto.city ?? '',
    timezone: dto.timezone ?? '',
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
    ...(dto.city !== undefined ? { city: dto.city } : {}),
    ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
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
  /** Free-text search (item #9) over the listing name, submitter first name,
   * and ref. Undefined/empty ⇒ no search filter. */
  q?: string;
  /** `newest` (default) | `oldest` | `name` (item #9). */
  sort?: ListingQueueSort;
}

/** Per-status counts on `listQueue`'s response (item #8), computed with ONE
 * grouped `GROUP BY status` query — never one query per status (a perf
 * constraint the design spec calls out explicitly). Reflects the same `q`
 * search filter as the page itself, but NOT the `status` filter (that's the
 * one axis the four counts vary across). */
export interface ListingQueueCounts {
  all: number;
  review: number;
  question: number;
  live: number;
}

export interface ListingQueueResult extends Paginated<ListingDTO> {
  counts: ListingQueueCounts;
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
  private readonly logger = new Logger(ListingsService.name);

  constructor(
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(ListingReview)
    private readonly reviews: Repository<ListingReview>,
    // Moderation audit trail (#16) + Q&A thread (#17).
    @InjectRepository(ListingModerationEvent)
    private readonly moderationEvents: Repository<ListingModerationEvent>,
    @InjectRepository(ListingQuestion)
    private readonly questions: Repository<ListingQuestion>,
    private readonly dataSource: DataSource,
    private readonly messaging: MessagingService,
    private readonly notifications: NotificationsService,
    private readonly storage: StorageService,
    // Files listing disputes + owner-notify tasks through the shared
    // report+moderation pipeline (item #13) rather than a parallel one.
    private readonly reports: ReportsService,
  ) {}

  async create(ownerId: string, dto: CreateListingDto): Promise<ListingDTO> {
    // Path-branched required fields whose shape is too nested for the DTO's
    // `@ValidateIf` to express (item #2): `hours` (≥1 open day) and the hero
    // photo are required on the `claim` path, optional on `suggest`.
    this.assertPathRequirements(dto);

    const ref = await this.nextRef();
    const saved = await this.createWithUniqueSlug(ownerId, ref, dto);
    // A "friendly" (unowned) or suggested listing needs a human to reach out to
    // the business so it can claim/correct the entry — enqueue that as a task in
    // the shared moderation queue (item #13). Best-effort: never fail the
    // submission if the task can't be filed.
    await this.enqueueOwnerNotifyIfNeeded(ownerId, saved, dto);
    return this.buildDTO(saved);
  }

  /**
   * Files a dispute/claim against a listing through the SHARED report pipeline
   * (item #13) — the very same `reports` table + moderation queue every other
   * report flows through, not a parallel one. Deliberately NOT owner-gated:
   * anyone (including the named business contesting a "friendly"/unowned entry)
   * can dispute, so this only 404s on an unknown `ref`. `ReportsService.create`
   * dedupes one open report per (reporter, subject), so a member spamming the
   * button gets their existing open dispute back rather than piling rows on the
   * mods' desk. The dispute is keyed by the listing's `slug` (the id every other
   * listing report uses), so a listing's disputes/reports group together.
   */
  async dispute(
    ref: string,
    reporterId: string,
    dto: DisputeListingDto,
  ): Promise<ReportDTO> {
    const listing = await this.loadOr404(ref);
    return this.reports.create(reporterId, {
      subjectType: ReportSubjectType.Listing,
      subjectId: listing.slug,
      reasonCode: 'listing_dispute',
      detail: dto.reason,
      contactEmail: dto.contactEmail,
    });
  }

  /**
   * Live dedupe search for the wizard (item #5): up to five live listings that
   * either match `name` (case-insensitive substring, served by the existing
   * `IDX_listings_name_lower_trgm` GIN trigram index) OR sit within ~150m of
   * the supplied coordinates. Distance is computed per returned row and is
   * `null` for rows matched by name alone when no coordinates were supplied.
   */
  async findSimilar(
    name: string,
    latitude?: number,
    longitude?: number,
  ): Promise<SimilarListingDTO[]> {
    const trimmedName = name.trim();
    const hasCoordinates =
      latitude !== undefined &&
      longitude !== undefined &&
      Number.isFinite(latitude) &&
      Number.isFinite(longitude);

    // A 1-2 character term can't use the trigram index and is too noisy to
    // dedupe on; require 2+ characters for the name branch (coordinates still
    // match on their own).
    const useNameMatch = trimmedName.length >= 2;
    if (!useNameMatch && !hasCoordinates) return [];

    const queryBuilder = this.listings
      .createQueryBuilder('listing')
      .where('listing.status = :status', { status: ListingStatus.Live });

    // ~150m expressed as a lat/lng bounding box: 0.00135° latitude ≈ 150m
    // everywhere; longitude degrees shrink with latitude, so divide by
    // cos(latitude) to keep the east-west span ≈150m. A cheap prefilter — the
    // exact great-circle distance is computed in JS below and re-filtered.
    const APPROX_METERS = 150;
    const latitudeDelta = APPROX_METERS / 111_320;
    queryBuilder.andWhere(
      new Brackets((qb) => {
        if (useNameMatch) {
          // Escape the LIKE metacharacters (`\`, `%`, `_`) in the user's term so
          // a business name typed with `%`/`_` matches literally instead of
          // over-matching every row. Backslash first, then the wildcards; the
          // explicit `ESCAPE '\'` makes the escape char independent of server
          // defaults. (Already parameterized — this is over-matching, not
          // injection.)
          const escapedName = trimmedName
            .toLowerCase()
            .replace(/[\\%_]/g, (metacharacter) => `\\${metacharacter}`);
          qb.orWhere("lower(listing.name) LIKE :namePattern ESCAPE '\\'", {
            namePattern: `%${escapedName}%`,
          });
        }
        if (hasCoordinates) {
          const longitudeDelta =
            latitudeDelta /
            Math.max(Math.cos((latitude * Math.PI) / 180), 0.01);
          qb.orWhere(
            'listing.latitude BETWEEN :minLat AND :maxLat AND ' +
              'listing.longitude BETWEEN :minLng AND :maxLng',
            {
              minLat: latitude - latitudeDelta,
              maxLat: latitude + latitudeDelta,
              minLng: longitude - longitudeDelta,
              maxLng: longitude + longitudeDelta,
            },
          );
        }
      }),
    );

    // Bounded prefetch — compute exact distances then take the best five.
    const candidates = await queryBuilder
      .orderBy('listing.created_at', 'DESC')
      .take(25)
      .getMany();

    const scored = candidates.map((listing) => {
      const distanceM =
        hasCoordinates &&
        listing.latitude !== null &&
        listing.longitude !== null
          ? haversineMeters(
              latitude,
              longitude,
              listing.latitude,
              listing.longitude,
            )
          : null;
      return { listing, distanceM };
    });

    // A coordinate-only match must actually be within range (the bounding box
    // is a square that overshoots the 150m circle at the corners); a name match
    // survives regardless of distance.
    const withinRangeOrNamed = scored.filter(({ listing, distanceM }) => {
      const nameMatches =
        useNameMatch &&
        listing.name.toLowerCase().includes(trimmedName.toLowerCase());
      const nearby = distanceM !== null && distanceM <= APPROX_METERS;
      return nameMatches || nearby;
    });

    // Closest first when a distance is known; named-only matches (null distance)
    // sort last among ties.
    withinRangeOrNamed.sort((first, second) => {
      const firstDistance = first.distanceM ?? Number.POSITIVE_INFINITY;
      const secondDistance = second.distanceM ?? Number.POSITIVE_INFINITY;
      return firstDistance - secondDistance;
    });

    return withinRangeOrNamed
      .slice(0, 5)
      .map(({ listing, distanceM }) =>
        toSimilarListing(
          listing,
          distanceM === null ? null : Math.round(distanceM),
        ),
      );
  }

  /** Claim-path presence checks for the two nested shapes the DTO can't gate
   * (see `create`). No-op on the `suggest` path. */
  private assertPathRequirements(dto: CreateListingDto): void {
    if (dto.path !== 'claim') return;

    const missing: string[] = [];
    // `Object.values` on a fixed-key class widens to `any[]`, so assert the
    // element type back to the day DTO before scanning for an open day.
    const days = (dto.hours ? Object.values(dto.hours) : []) as (
      ListingDayHoursDto | undefined
    )[];
    const hasOpenDay = days.some(
      (day) => day?.open && (day.intervals?.length ?? 0) >= 1,
    );
    if (!hasOpenDay) missing.push('opening hours');
    if (!dto.photos?.wide) missing.push('a main photo');

    if (missing.length > 0) {
      throw new BadRequestException(
        `Claiming a listing requires ${missing.join(' and ')}.`,
      );
    }
  }

  /**
   * Enqueues an owner-outreach task in the shared moderation queue when a newly
   * created listing is "friendly" (badge) or was submitted via the suggest
   * path — someone should contact the named business so it can claim/correct
   * the entry. Filed as a `listing_owner_notify`-coded report against the
   * listing's slug; the submitter is the reporter so a moderator can follow up.
   * The listing's own pasted `evidence` is surfaced to the reviewer by the
   * moderation queue's detail lookup (it reads the live `Listing` row), so it is
   * not duplicated into the report here. Best-effort — a failure to enqueue must
   * never roll back the already-committed listing.
   */
  private async enqueueOwnerNotifyIfNeeded(
    reporterId: string,
    listing: Listing,
    dto: CreateListingDto,
  ): Promise<void> {
    const isFriendly = dto.badge === 'friendly';
    const isSuggested = dto.path === 'suggest';
    if (!isFriendly && !isSuggested) return;

    const kind = isSuggested ? 'suggested' : 'friendly (unowned)';
    try {
      await this.reports.create(reporterId, {
        subjectType: ReportSubjectType.Listing,
        subjectId: listing.slug,
        reasonCode: 'listing_owner_notify',
        detail:
          `Owner outreach: ${kind} listing "${listing.name}" ` +
          `(${listing.ref}) awaits contact so the business can claim or ` +
          `correct it.`,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to enqueue owner-notify task for listing ${listing.ref}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
   * status and searched/sorted (item #9), plus per-status counts (item #8)
   * — the moderation queue. Mirrors `listMine`'s pagination + owner-ref
   * mapping, minus the owner scope. */
  async listQueue(
    query: ListListingQueueQueryInput,
  ): Promise<ListingQueueResult> {
    const page = normalizePage(query.page);
    const trimmedSearch = query.q?.trim();

    const qb = this.buildQueueSearchQuery(trimmedSearch);
    if (query.status) {
      qb.andWhere('l.status = :status', { status: query.status });
    }
    this.applyQueueSort(qb, query.sort);

    const [paginated, counts] = await Promise.all([
      paginate(qb, page, async (rows) => {
        if (!rows.length) return [];
        const refs = await new MemberLookup(this.profiles).byUserIds(
          rows.map((row) => row.ownerId),
        );
        return rows.map((row) =>
          toListingDTO(row, refs.get(row.ownerId) ?? null),
        );
      }),
      this.computeQueueCounts(trimmedSearch),
    ]);

    return { ...paginated, counts };
  }

  /** Base query builder shared by `listQueue`'s page and its counts (item
   * #8/#9): the `status`-independent filters — currently just the search —
   * so the counts query stays "what would this search return, broken down
   * by status" rather than duplicating the search predicate in two places. */
  private buildQueueSearchQuery(
    trimmedSearch: string | undefined,
  ): SelectQueryBuilder<Listing> {
    const qb = this.listings.createQueryBuilder('l');
    if (trimmedSearch) {
      // Joins the submitter's profile so the search can match on their first
      // name too, not just the listing's own name/ref (a moderator often
      // remembers "who submitted this" rather than the business name).
      // NOTE: `submitter.first_name ILIKE` is already served by the existing
      // `IDX_profiles_first_name_trgm` GIN trigram index (raw column, not a
      // `lower()` expression index — see `1785700100000-
      // AddSearchTrgmAndTagsIndexes.ts`), so no follow-up index is needed
      // for that branch. `l.ref ILIKE` has no dedicated index (only the
      // existing unique b-tree, unusable for a leading-wildcard match) —
      // acceptable for a moderator-only, paginated tool; a trigram index on
      // `ref` would be the follow-up if that ever shows up as slow.
      const pattern = `%${escapeLikeTerm(trimmedSearch)}%`;
      qb.leftJoin(
        Profile,
        'submitter',
        'submitter.user_id = l.owner_id',
      ).andWhere(
        '(l.name ILIKE :pattern OR submitter.first_name ILIKE :pattern OR l.ref ILIKE :pattern)',
        { pattern },
      );
    }
    return qb;
  }

  private applyQueueSort(
    qb: SelectQueryBuilder<Listing>,
    sort: ListingQueueSort | undefined,
  ): void {
    switch (sort) {
      case 'oldest':
        qb.orderBy('l.created_at', 'ASC');
        break;
      case 'name':
        qb.orderBy('l.name', 'ASC');
        break;
      case 'newest':
      default:
        qb.orderBy('l.created_at', 'DESC');
    }
  }

  /** Per-status breakdown of the (optionally search-filtered) queue, in ONE
   * grouped query — never one query per status (perf constraint, item #8).
   * Reuses `buildQueueSearchQuery` so the counts reflect the same `q` filter
   * the page itself does. */
  private async computeQueueCounts(
    trimmedSearch: string | undefined,
  ): Promise<ListingQueueCounts> {
    const rows = await this.buildQueueSearchQuery(trimmedSearch)
      .select('l.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('l.status')
      .getRawMany<{ status: ListingStatus; count: string }>();

    const counts: ListingQueueCounts = {
      all: 0,
      review: 0,
      question: 0,
      live: 0,
    };
    for (const row of rows) {
      const count = Number(row.count);
      counts[row.status] = count;
      counts.all += count;
    }
    return counts;
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

    // Snapshot the gallery keys BEFORE the merge so any photo the edit replaces
    // or clears can be deleted from the bucket once the new set has committed.
    const previousImageKeys = this.collectListingImageKeys(listing);
    applyUpdate(listing, dto);

    const saved = await this.listings.save(listing);
    // Delete-on-replace: any photo object no longer referenced by the saved
    // listing is now orphaned. Best-effort + post-commit — a storage failure
    // must never fail the edit.
    const survivingImageKeys = new Set(this.collectListingImageKeys(saved));
    await this.deleteOrphanedObjects(
      previousImageKeys.filter((key) => !survivingImageKeys.has(key)),
      `listing ${saved.ref}`,
    );
    return this.buildDTO(saved);
  }

  async remove(ref: string, userId: string): Promise<void> {
    const listing = await this.loadOr404(ref);
    this.assertOwner(listing, userId);
    const imageKeys = this.collectListingImageKeys(listing);
    await this.listings.remove(listing);
    // The row (and its cascade) is gone — its photo objects live outside
    // Postgres and would otherwise keep serving. Best-effort, post-delete.
    await this.deleteOrphanedObjects(imageKeys, `removed listing ${ref}`);
  }

  /**
   * Moderator/admin hard-deletes any listing, regardless of owner. Distinct
   * from `remove(ref, userId)` above, which is owner-gated via `assertOwner`;
   * this path is reached only through the role-guarded moderation route.
   * `actorId`/`reason` back the audit event (item #16) and the best-effort
   * submitter DM (item #15).
   */
  async removeByModerator(
    ref: string,
    actorId: string,
    reason?: string,
  ): Promise<void> {
    const listing = await this.loadOr404(ref);
    const imageKeys = this.collectListingImageKeys(listing);
    // Captured before the transactional remove — TypeORM clears an entity's
    // primary key(s) after `manager.remove()`, and defensively snapshotting
    // every field this method still needs afterward avoids relying on which
    // non-PK fields happen to survive that mutation.
    const listingId = listing.id;
    const listingRef = listing.ref;
    const listingName = listing.name;
    const listingOwnerId = listing.ownerId;
    const previousStatus = listing.status;

    await this.dataSource.transaction(async (manager) => {
      await manager.save(ListingModerationEvent, {
        listingId,
        actorId,
        action: ListingModerationAction.Removed,
        fromStatus: previousStatus,
        toStatus: null,
        reason: reason ?? null,
      });
      await manager.remove(listing);
    });

    await this.deleteOrphanedObjects(
      imageKeys,
      `moderated listing ${listingRef}`,
    );

    if (listingOwnerId) {
      await this.notifySubmitterBestEffort(
        actorId,
        { ref: listingRef, ownerId: listingOwnerId },
        `Your listing "${listingName}" was removed from QueerPulse.${
          reason ? ` Reason: ${reason}` : ''
        }`,
      );
    }
  }

  /**
   * Moderator/admin-only: applies one status transition to many listings in
   * a single transaction, one `bulk_status` moderation event per listing
   * (item #16), returning which refs actually updated vs. which refs weren't
   * found. An unknown ref is the only failure mode inside the loop — it's
   * skipped, not aborted, so one typo in a multi-select doesn't sink the
   * whole batch; a genuine DB error instead propagates out of the
   * transaction and rolls everything back (a 500 for the request). One
   * batched `find(... In(refs))` prefetches every listing up front (capped
   * at 200 refs by `BulkStatusDto`) instead of one `findOne` per ref inside
   * the loop. A no-op ref (already at the target status) is still reported
   * `updated` but writes no event and sends no notification of either kind.
   *
   * Notification mirrors the single-listing `setStatus` branching exactly,
   * per listing whose status actually changed, once the transaction has
   * committed: a transition INTO Live creates the same best-effort
   * `ListingApproved` persisted notification `setStatus` creates
   * (`notifyApprovedBestEffort`); every OTHER real transition instead
   * best-effort DMs the submitter (`notifySubmitterBestEffort`, item #15,
   * mirrors `bulkRemove`'s notify pass). Never both for the same listing.
   */
  async bulkSetStatus(
    refs: string[],
    status: ListingStatus,
    actorId: string,
    reason?: string,
  ): Promise<BulkListingResultDTO> {
    const updated: string[] = [];
    const failed: string[] = [];
    const approvedTargets: { ownerId: string; slug: string }[] = [];
    const sentBackTargets: { ref: string; ownerId: string; name: string }[] =
      [];

    await this.dataSource.transaction(async (manager) => {
      const listingsRepo = manager.getRepository(Listing);
      const foundListings = await listingsRepo.find({
        where: { ref: In(refs) },
      });
      const listingByRef = new Map(
        foundListings.map((listing) => [listing.ref, listing]),
      );

      for (const ref of refs) {
        const listing = listingByRef.get(ref);
        if (!listing) {
          failed.push(ref);
          continue;
        }

        const previousStatus = listing.status;
        if (previousStatus !== status) {
          listing.status = status;
          await listingsRepo.save(listing);
          await manager.save(ListingModerationEvent, {
            listingId: listing.id,
            actorId,
            action: ListingModerationAction.BulkStatus,
            fromStatus: previousStatus,
            toStatus: status,
            reason: reason ?? null,
          });
          if (listing.ownerId) {
            if (status === ListingStatus.Live) {
              approvedTargets.push({
                ownerId: listing.ownerId,
                slug: listing.slug,
              });
            } else {
              sentBackTargets.push({
                ref: listing.ref,
                ownerId: listing.ownerId,
                name: listing.name,
              });
            }
          }
        }
        updated.push(ref);
      }
    });

    for (const target of approvedTargets) {
      await this.notifyApprovedBestEffort(target.ownerId, target.slug);
    }
    for (const target of sentBackTargets) {
      await this.notifySubmitterBestEffort(
        actorId,
        target,
        this.statusChangeMessage(target.name, status, reason),
      );
    }

    return { updated, failed };
  }

  /**
   * Moderator/admin-only: hard-deletes many listings in a single
   * transaction, one `removed` moderation event per listing (item #16), then
   * best-effort DMs each removed listing's submitter (item #15) once the
   * transaction has committed. Mirrors `bulkSetStatus`'s
   * skip-unknown-refs/report-failed semantics and its batched `find(...
   * In(refs))` prefetch (capped at 200 refs by `BulkRemoveDto`) instead of
   * one `findOne` per ref inside the loop.
   */
  async bulkRemove(
    refs: string[],
    actorId: string,
    reason?: string,
  ): Promise<BulkListingResultDTO> {
    const updated: string[] = [];
    const failed: string[] = [];
    const orphanedImageKeys: string[] = [];
    const notifyTargets: { ref: string; name: string; ownerId: string }[] = [];

    await this.dataSource.transaction(async (manager) => {
      const listingsRepo = manager.getRepository(Listing);
      const foundListings = await listingsRepo.find({
        where: { ref: In(refs) },
      });
      const listingByRef = new Map(
        foundListings.map((listing) => [listing.ref, listing]),
      );

      for (const ref of refs) {
        const listing = listingByRef.get(ref);
        if (!listing) {
          failed.push(ref);
          continue;
        }

        orphanedImageKeys.push(...this.collectListingImageKeys(listing));
        if (listing.ownerId) {
          notifyTargets.push({
            ref: listing.ref,
            name: listing.name,
            ownerId: listing.ownerId,
          });
        }

        await manager.save(ListingModerationEvent, {
          listingId: listing.id,
          actorId,
          action: ListingModerationAction.Removed,
          fromStatus: listing.status,
          toStatus: null,
          reason: reason ?? null,
        });
        await listingsRepo.remove(listing);
        updated.push(ref);
      }
    });

    await this.deleteOrphanedObjects(
      orphanedImageKeys,
      'bulk-removed listings',
    );

    for (const target of notifyTargets) {
      await this.notifySubmitterBestEffort(
        actorId,
        target,
        `Your listing "${target.name}" was removed from QueerPulse.${
          reason ? ` Reason: ${reason}` : ''
        }`,
      );
    }

    return { updated, failed };
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
    // The reply's author is the owner, but the returned row still represents
    // the reviewer — resolve their profile so the DTO keeps the avatar + link.
    const author = saved.reviewerId
      ? await this.profiles.findOne({
          where: { userId: saved.reviewerId },
          select: { slug: true, avatarUrl: true },
        })
      : null;
    return toReviewDTO(
      saved,
      author ? { slug: author.slug, avatarUrl: author.avatarUrl } : null,
    );
  }

  // Moderator/admin-only (`ListingsController.setStatus`'s `RolesGuard`
  // gate) — any of the three statuses is directly settable; there's no
  // narrower transition graph in the spec's contract. `actorId` is the
  // acting moderator (recorded on the moderation event, item #16, and used
  // as the DM sender when notifying the submitter, item #15); `reason` is
  // optional free text from the moderator, also recorded on the event.
  async setStatus(
    ref: string,
    status: ListingStatus,
    actorId: string,
    reason?: string,
  ): Promise<ListingDTO> {
    const listing = await this.loadOr404(ref);
    const previousStatus = listing.status;
    const wasLive = previousStatus === ListingStatus.Live;
    const statusChanged = previousStatus !== status;

    // The status save and its audit event are two writes with no external
    // I/O between them, so they run in one transaction — unlike `askQuestion`
    // below (which can't wrap its DM in a DB transaction and instead reverts
    // on failure), there's nothing here that can't be made properly atomic.
    const saved = await this.dataSource.transaction(async (manager) => {
      listing.status = status;
      const savedListing = await manager.save(listing);
      if (statusChanged) {
        await manager.save(ListingModerationEvent, {
          listingId: savedListing.id,
          actorId,
          action: ListingModerationAction.StatusChanged,
          fromStatus: previousStatus,
          toStatus: status,
          reason: reason ?? null,
        });
      }
      return savedListing;
    });

    // Approval = a submitted listing going Live. Notify the submitter once, on
    // the transition into Live (never on a re-save of an already-live listing).
    // No actor: the platform is telling the owner about their own listing.
    // Best-effort; guarded on a real submitter (`ownerId` can be null on
    // admin-seeded listings). Deep-links to the public detail page via `slug`.
    if (status === ListingStatus.Live && !wasLive && saved.ownerId) {
      await this.notifyApprovedBestEffort(saved.ownerId, saved.slug);
    } else if (
      statusChanged &&
      status !== ListingStatus.Live &&
      saved.ownerId
    ) {
      // "Send back" (item #15) — any real transition away from an
      // in-flight review that ISN'T the Live approval above. Best-effort DM
      // through the same cold-contact path `askQuestion` uses.
      await this.notifySubmitterBestEffort(
        actorId,
        { ref: saved.ref, ownerId: saved.ownerId },
        this.statusChangeMessage(saved.name, status, reason),
      );
    }
    return this.buildDTO(saved);
  }

  /** Composes the best-effort DM body for a moderator-initiated status
   * change (item #15). Kept tiny and file-local — there's no i18n layer on
   * the backend (copy lives in the frontend), so this is a plain functional
   * English sentence, mirroring `enqueueOwnerNotifyIfNeeded`'s inline
   * `detail` string precedent. */
  private statusChangeMessage(
    listingName: string,
    status: ListingStatus,
    reason?: string,
  ): string {
    const base =
      status === ListingStatus.Question
        ? `Your listing "${listingName}" needs more information before it can go live.`
        : `Your listing "${listingName}" was sent back to review.`;
    return reason ? `${base} Reason: ${reason}` : base;
  }

  /** Best-effort DM to a listing's submitter (item #15) — never blocks or
   * fails the caller's already-committed mutation. Shared by `setStatus`,
   * `removeByModerator`, and `bulkRemove`. */
  private async notifySubmitterBestEffort(
    actorId: string,
    target: { ref: string; ownerId: string },
    message: string,
  ): Promise<void> {
    try {
      await this.messaging.deliverEnquiry(actorId, target.ownerId, message);
    } catch (error) {
      this.logger.warn(
        `Failed to notify submitter for listing ${target.ref}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Best-effort "your listing is now live" approval notification. Shared by
   * `setStatus` (single) and `bulkSetStatus` (bulk) so a bulk approval
   * creates the same persisted notification a single approval does — no DM
   * here (mirrors `setStatus`'s branching: Live gets this notification
   * instead of the `notifySubmitterBestEffort` DM, never both). Never
   * throws — the status change has already committed by the time this
   * runs. */
  private async notifyApprovedBestEffort(
    ownerId: string,
    listingSlug: string,
  ): Promise<void> {
    try {
      await this.notifications.create(
        ownerId,
        NotificationType.ListingApproved,
        { source: 'listing', listingSlug },
      );
    } catch {
      // Intentionally ignored — the status change already committed.
    }
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

    // Q&A thread row (item #17) + audit event (item #16). Written AFTER the
    // DM succeeds, same ordering rationale as the DM itself: nothing below
    // can fail and strand a duplicate question. A DM that succeeds followed
    // by a failure here would leave the DM sent without its queryable
    // record — a narrow, accepted window (mirrors the best-effort posture
    // every other secondary write in this service takes).
    await this.questions.save(
      this.questions.create({
        listingId: saved.id,
        askedBy: moderatorUserId,
        body,
      }),
    );
    await this.moderationEvents.save({
      listingId: saved.id,
      actorId: moderatorUserId,
      action: ListingModerationAction.QuestionAsked,
      fromStatus: previousStatus,
      toStatus: ListingStatus.Question,
      reason: null,
    });

    return this.buildDTO(saved);
  }

  /** Owner-gated: the listing owner answers a moderator's question (item
   * #17), via `POST /listings/:ref/questions/:id/answer`. Mirrors
   * `replyToReview`'s ownership + scoping shape (the question is looked up
   * scoped to this listing, so an answer can't be attached to a different
   * owner's listing via a guessed id). */
  async answerQuestion(
    ref: string,
    questionId: string,
    userId: string,
    answer: string,
  ): Promise<ListingQuestionDTO> {
    const listing = await this.loadOr404(ref);
    this.assertOwner(listing, userId);

    const question = await this.questions.findOne({
      where: { id: questionId, listingId: listing.id },
    });
    if (!question) {
      throw new NotFoundException('Question not found');
    }

    question.answer = answer;
    question.answeredAt = new Date();
    const saved = await this.questions.save(question);

    await this.moderationEvents.save({
      listingId: listing.id,
      actorId: userId,
      action: ListingModerationAction.Answered,
      fromStatus: null,
      toStatus: null,
      reason: null,
    });

    // Narrowed `select` mirrors `replyToReview`'s identical precedent —
    // only the columns `toMemberRef` actually reads.
    const asker = saved.askedBy
      ? await this.profiles.findOne({
          where: { userId: saved.askedBy },
          select: {
            slug: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
          },
        })
      : null;
    return toListingQuestionDTO(saved, toMemberRef(asker));
  }

  /**
   * Moderator/admin-only (`ListingsController.getHistory`'s `RolesGuard`
   * gate): a listing's full moderation audit trail (item #16) and Q&A thread
   * (item #17), both newest-first — feeds the admin drawer's history panel.
   * Resolves every distinct actor/asker in one batched `MemberLookup` call
   * rather than N+1 profile reads.
   */
  async getListingHistory(ref: string): Promise<ListingHistoryDTO> {
    const listing = await this.loadOr404(ref);

    const [events, questions] = await Promise.all([
      this.moderationEvents.find({
        where: { listingId: listing.id },
        order: { createdAt: 'DESC' },
      }),
      this.questions.find({
        where: { listingId: listing.id },
        order: { createdAt: 'DESC' },
      }),
    ]);

    const actorIds = events
      .map((event) => event.actorId)
      .filter((id): id is string => Boolean(id));
    const askerIds = questions
      .map((question) => question.askedBy)
      .filter((id): id is string => Boolean(id));
    const refs = await new MemberLookup(this.profiles).byUserIds([
      ...actorIds,
      ...askerIds,
    ]);

    const eventDTOs: ListingModerationEventDTO[] = events.map((event) =>
      toListingModerationEventDTO(
        event,
        event.actorId ? (refs.get(event.actorId) ?? null) : null,
      ),
    );
    const questionDTOs: ListingQuestionDTO[] = questions.map((question) =>
      toListingQuestionDTO(
        question,
        question.askedBy ? (refs.get(question.askedBy) ?? null) : null,
      ),
    );

    return toListingHistoryDTO(eventDTOs, questionDTOs);
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

  /**
   * Every image reference a listing holds across its two photo sets
   * (`photos` + `alt`, each `{ wide, d1, d2, vibe }`). Non-key values (external
   * URLs, empty slots) are collected too and simply no-op at delete time —
   * `StorageService.deleteObjectByReference` filters them — so callers can diff
   * or delete the raw list without pre-filtering.
   */
  private collectListingImageKeys(listing: Listing): string[] {
    const sets = [listing.photos, listing.alt];
    const keys: string[] = [];
    for (const set of sets) {
      if (!set) continue;
      for (const value of [set.wide, set.d1, set.d2, set.vibe]) {
        if (value) keys.push(value);
      }
    }
    return keys;
  }

  /**
   * Best-effort, post-commit delete of a set of now-orphaned photo objects. One
   * failed object is logged and skipped, never rethrown — the DB mutation that
   * dropped the reference has already committed, and a stranded object is a
   * storage-cost issue, never a correctness one.
   */
  private async deleteOrphanedObjects(
    references: string[],
    context: string,
  ): Promise<void> {
    for (const reference of references) {
      try {
        await this.storage.deleteObjectByReference(reference);
      } catch (error) {
        this.logger.warn(
          `Failed to delete orphaned object for ${context}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

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
