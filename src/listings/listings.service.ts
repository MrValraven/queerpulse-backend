import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { resolveListingLocation, resolveListingTimezone } from './listing-city';
import { toImageUrl } from '../common/image-url';
import {
  Brackets,
  DataSource,
  In,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { MemberLookup, toMemberRef } from '../common/member-ref';
import { actorFromLookup, presentActorIds } from '../common/nullable-actor';
import { MediaCropService } from '../media-crops/media-crops.service';
import { MessagingService } from '../messaging/messaging.service';
import { StorageService } from '../storage/storage.service';
import { assertNoForeignUploadIntroduced } from '../storage/assert-no-foreign-upload';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { ReportsService } from '../reports/reports.service';
import { ReportDTO } from '../reports/report-response';
import { ReportSubjectType } from '../reports/entities/report.entity';
import { ListingCoManagersService } from './listing-co-managers.service';
import {
  assertNoOwnerPersonalListingFields,
  ManagedListingDTO,
  toManagedListingDTO,
} from './listing-owner-personal-fields';
import { BulkListingResultDTO } from './dto/bulk-listing.dto';
import {
  DisputeListingDto,
  LISTING_DISPUTE_REASON_CODE,
} from './dto/dispute-listing.dto';
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
import {
  OwnerListingHistoryDTO,
  toOwnerListingHistoryDTO,
  toOwnerListingModerationEventDTO,
  toOwnerListingQuestionDTO,
} from './dto/owner-listing-history.dto';
import { ListingQueueSort } from './dto/list-listing-queue.query';
import {
  DEFAULT_LIST_LIMIT,
  normalizePage,
  PAGE_SIZE,
  paginate,
  Paginated,
} from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { Profile } from '../users/entities/profile.entity';
import { CreateListingDto, ListingDayHoursDto } from './dto/create-listing.dto';
import { UpdateOperatingStateDto } from './dto/update-operating-state.dto';
import { ReplyToReviewDto } from './dto/reply-to-review.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { UpdateSafeSpaceDto } from './dto/update-safe-space.dto';
import {
  ListingModerationAction,
  ListingModerationEvent,
} from './entities/listing-moderation-event.entity';
import {
  ListingPublicQuestionDTO,
  toListingPublicQuestionDTO,
} from './dto/listing-public-question.dto';
import { ListingPublicQuestion } from './entities/listing-public-question.entity';
import { ListingQuestion } from './entities/listing-question.entity';
import { ListingReview } from './entities/listing-review.entity';
import {
  Listing,
  ListingDayHours,
  ListingHoursException,
  ListingOperatingState,
  ListingPhotoSet,
  ListingServiceOffering,
  ListingSocial,
  ListingStatus,
  ListingWitLine,
  SafeSpaceStatus,
} from './entities/listing.entity';
import { normalizeAccessibilityAnswers } from './listing-accessibility';
import { UpdateListingVisibilityDto } from './dto/update-listing-visibility.dto';
import { UpdateQueerOwnedVerifiedDto } from './dto/update-queer-owned-verified.dto';
import {
  listingPhotoKeys,
  ConfirmedDetailsDTO,
  ListingDTO,
  ReviewDTO,
  SimilarListingDTO,
  toListingDTO,
  toReviewDTO,
  toSimilarListing,
} from './listing-response';
import {
  ListingGalleryPhoto,
  galleryFromLegacySlots,
  galleryImageReferences,
  galleryWithLegacySlotPatch,
  legacySlotsFromGallery,
  normalizeGallery,
} from './listing-photo-gallery';

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

/**
 * The ordered gallery a create/replace body asks for.
 *
 * `photoGallery` is the current shape and wins outright. A body that still
 * sends only the legacy `photos`/`alt` slot pair is converted in slot order
 * (`wide`, `d1`, `d2`, `vibe`, empty slots skipped), which is exactly the
 * mapping `AddListingPhotoGallery1794310000000` applied to existing rows, so
 * an old client and the backfill produce the same gallery from the same input.
 */
function galleryFromCreateInput(dto: {
  photoGallery?: { image: string; alt: string; caption?: string }[];
  photos?: Partial<ListingPhotoSet>;
  alt?: Partial<ListingPhotoSet>;
}): ListingGalleryPhoto[] {
  return dto.photoGallery !== undefined
    ? normalizeGallery(dto.photoGallery)
    : galleryFromLegacySlots(dto.photos, dto.alt);
}

/**
 * Fills in every key of every service offering, so the jsonb column always
 * holds the full `ListingServiceOffering` shape the response DTOs promise
 * rather than whichever subset the client happened to send. Same job
 * `normalizeSocial`/`normalizeGallery` do for their columns.
 *
 * Order is preserved exactly as sent: a price list has an order its author
 * chose, and re-sorting it (alphabetically, by price) would rearrange a menu
 * behind their back.
 */
function normalizeServices(
  input?: { name: string; price: string; note?: string }[],
): ListingServiceOffering[] {
  return (input ?? []).map((offering) => ({
    name: offering.name,
    price: offering.price,
    note: offering.note ?? '',
  }));
}

/**
 * Fills in every key of every hours exception, so the jsonb column always
 * holds the full `ListingHoursException` shape the response DTOs promise
 * rather than whichever subset the client happened to send. Same job
 * `normalizeSocial`/`normalizeGallery` do for their columns.
 *
 * Also sorts by date ascending. The stored order is what the frontend renders,
 * and an owner adding a forgotten holiday should not see it land at the bottom
 * of a list that is otherwise chronological.
 */
function normalizeHoursExceptions(
  input?: {
    date: string;
    open: boolean;
    intervals?: { from: string; to: string }[];
    note?: string;
  }[],
): ListingHoursException[] {
  return (input ?? [])
    .map((exception) => ({
      date: exception.date,
      open: exception.open,
      // A closed date carries no intervals; `@IsValidDayHours()` has already
      // rejected any other combination by the time this runs.
      intervals: exception.open ? (exception.intervals ?? []) : [],
      note: exception.note ?? '',
    }))
    .sort((first, second) => first.date.localeCompare(second.date));
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
  // Queer-owned verification and its provenance are an ops/moderation
  // concern, never part of the member-submission wizard — they default at the
  // DB level on create and are written only by the moderator toggle.
  | 'queerOwnedVerified'
  | 'queerOwnedVerifier'
  | 'queerOwnedReVerifiedAt'
  | 'queerOwnedBasis'
  | 'queerOwnedExpiresAt'
  // The affirming baseline is stamped server-side from the submitter's
  // acceptance (`CreateListingDto.affirmingBaselineAccepted`), never taken as
  // a client-supplied instant, so the record cannot be backdated. See
  // `ListingsService.create`.
  | 'affirmingBaselineAcceptedAt'
  // Owner pause: a listing is shown when it is created. Hiding it is a later,
  // deliberate act through `PATCH /listings/:ref/visibility`, so these default
  // at the DB level on create.
  | 'isHiddenByOwner'
  | 'ownerHiddenAt'
  // Retired columns: no longer collected from the wizard and no longer served.
  // The columns stay on the entity so existing rows keep their values, and the
  // DB default fills them on insert. See `Listing.verify` / `Listing.notify`.
  | 'verify'
  | 'notify'
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
  // Operating state is the business's own report about itself, declared later
  // through `PATCH /listings/:ref/operating-state`. A brand-new submission is
  // `open` by definition (nobody lists a business in order to announce it
  // shut), so these default at the DB level on create.
  | 'operatingState'
  | 'operatingStateNote'
  | 'operatingStateSetAt'
  | 'movedToAddress'
  | 'movedToListingId'
  // Freshness is stamped by `confirmDetails()` and by a real owner edit, never
  // by the wizard: a listing is trivially "confirmed" the moment it is
  // written, so a create-time stamp would mean nothing.
  | 'detailsConfirmedAt'
> {
  const gallery = galleryFromCreateInput(dto);
  // The city and the timezone are the backend's to decide (LOC-15). The wizard
  // sends neither, and `?? ''` stored an empty city on every member-created
  // listing plus an empty timezone that silently disables opening hours.
  // `resolveListingLocation` also rescues a neighbourhood name submitted in the
  // city field rather than discarding it.
  const location = resolveListingLocation(dto);
  return {
    path: dto.path ?? '',
    name: dto.name,
    cats: dto.cats ?? [],
    hood: location.hood ?? '',
    city: location.city,
    timezone: resolveListingTimezone(dto.timezone),
    badge: dto.badge ?? '',
    evidence: dto.evidence ?? '',
    price: dto.price ?? '',
    blurb: dto.blurb ?? '',
    tagline: dto.tagline ?? '',
    whatItIs: (dto.whatItIs ?? []) as ListingWitLine[],
    tags: dto.tags ?? [],
    goodFor: dto.goodFor ?? [],
    // Always the COMPLETE question set: an omitted question is stored as a
    // real `unknown`, which is a different stored value from `no` and reads
    // as "we have not said" rather than as a denial.
    accessibilityAnswers: normalizeAccessibilityAnswers(
      dto.accessibility?.answers,
    ),
    accessibilityNote: dto.accessibility?.note ?? '',
    services: normalizeServices(dto.services),
    langs: dto.langs ?? [],
    // An online-only listing carries no location, whatever the client sent.
    online: dto.online ?? false,
    address: dto.online ? '' : (dto.address ?? ''),
    geocoded: dto.online ? false : (dto.geocoded ?? false),
    latitude: dto.online ? null : (dto.latitude ?? null),
    longitude: dto.online ? null : (dto.longitude ?? null),
    hours: (dto.hours ?? {}) as Record<string, ListingDayHours>,
    hoursNote: dto.hoursNote ?? '',
    hoursExceptions: normalizeHoursExceptions(dto.hoursExceptions),
    social: normalizeSocial(dto.social),
    photoGallery: gallery,
    // The legacy `photos`/`alt` columns are a DERIVED mirror of the first four
    // gallery entries, rewritten from the gallery on every write and never
    // authored directly. See `AddListingPhotoGallery1794310000000` for why
    // they were kept rather than dropped.
    ...legacySlotsFromGallery(gallery),
    rel: dto.rel ?? '',
    ownerName: dto.ownerName ?? '',
    ownerRole: dto.ownerRole ?? '',
    ownerBio: dto.ownerBio ?? '',
    visibility: dto.visibility ?? '',
    linkToProfile: dto.linkToProfile ?? false,
    contactEmail: dto.contactEmail ?? '',
    consentOuting: dto.consentOuting ?? false,
    consentGuide: dto.consentGuide ?? false,
  };
}

/** Applies only the fields present on a PATCH body, leaving everything else
 * untouched (mirrors `CompaniesService.update`'s conditional-spread idiom).
 * `social` merges per-subfield rather than replacing the whole nested object
 * outright, so a caller patching just `social.phone` doesn't blank out
 * `social.email`. The legacy `photos`/`alt` slot pair keeps that same
 * per-subfield merge semantics, applied through the ordered gallery (see
 * `nextGallery` below). */
function applyUpdate(listing: Listing, dto: UpdateListingDto): void {
  // The photos this PATCH leaves the listing with, or `null` when it says
  // nothing about photos at all.
  //
  // `photoGallery` is an ordered list the owner arranged, so it is replaced
  // wholesale, never merged: a partial merge of an ordered list has no meaning
  // and would strand a photo they meant to delete. Same reasoning as
  // `services` and `hoursExceptions`.
  //
  // A body that still sends the legacy `photos`/`alt` slots is applied
  // POSITIONALLY to the first four gallery entries, so an old client patching
  // one slot cannot delete a fifth photo or a caption it has no way to send
  // (see `galleryWithLegacySlotPatch`). A body carrying both shapes: the
  // gallery wins, matching `galleryFromCreateInput`.
  const currentGallery = listing.photoGallery ?? [];
  const nextGallery: ListingGalleryPhoto[] | null =
    dto.photoGallery !== undefined
      ? normalizeGallery(dto.photoGallery)
      : dto.photos !== undefined || dto.alt !== undefined
        ? galleryWithLegacySlotPatch(currentGallery, dto.photos, dto.alt)
        : null;

  Object.assign(listing, {
    ...(dto.path !== undefined ? { path: dto.path } : {}),
    ...(dto.name !== undefined ? { name: dto.name } : {}),
    ...(dto.cats !== undefined ? { cats: dto.cats } : {}),
    // Same rule on update as on create (LOC-15): a submitted city is normalised
    // to the one city rather than stored verbatim, and a neighbourhood sent in
    // the city field moves to `hood` instead of overwriting it.
    ...(dto.hood !== undefined || dto.city !== undefined
      ? (() => {
          const location = resolveListingLocation(dto);
          return {
            city: location.city,
            ...(location.hood !== undefined ? { hood: location.hood } : {}),
          };
        })()
      : {}),
    ...(dto.timezone !== undefined
      ? { timezone: resolveListingTimezone(dto.timezone) }
      : {}),
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
    // Answers MERGE per question (the `social` idiom), so an owner correcting
    // one answer does not blank the other five back to `unknown`. The result
    // is re-normalized, so the stored map stays complete and every value stays
    // one of the three real answers. The note is a single value and replaces.
    ...(dto.accessibility?.answers !== undefined
      ? {
          accessibilityAnswers: normalizeAccessibilityAnswers({
            ...normalizeAccessibilityAnswers(listing.accessibilityAnswers),
            ...dto.accessibility.answers,
          }),
        }
      : {}),
    ...(dto.accessibility?.note !== undefined
      ? { accessibilityNote: dto.accessibility.note }
      : {}),
    // Replaced wholesale, never merged: this is an ordered list the owner
    // arranged, so a partial merge has no meaning and would strand a service
    // they meant to delete. Same reasoning as `hoursExceptions`.
    ...(dto.services !== undefined
      ? { services: normalizeServices(dto.services) }
      : {}),
    ...(dto.langs !== undefined ? { langs: dto.langs } : {}),
    ...(dto.online !== undefined ? { online: dto.online } : {}),
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
    // Replaced wholesale, never merged: the exceptions are an ordered list of
    // dates, so a partial merge has no meaning and would strand a date the
    // owner meant to delete.
    ...(dto.hoursExceptions !== undefined
      ? { hoursExceptions: normalizeHoursExceptions(dto.hoursExceptions) }
      : {}),
    ...(dto.social !== undefined
      ? { social: { ...listing.social, ...dto.social } }
      : {}),
    // The legacy `photos`/`alt` columns are rewritten from the gallery rather
    // than from the body: they are a derived mirror, never a second source of
    // truth (see `AddListingPhotoGallery1794310000000`).
    ...(nextGallery !== null
      ? { photoGallery: nextGallery, ...legacySlotsFromGallery(nextGallery) }
      : {}),
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
    ...(dto.consentOuting !== undefined
      ? { consentOuting: dto.consentOuting }
      : {}),
    ...(dto.consentGuide !== undefined
      ? { consentGuide: dto.consentGuide }
      : {}),
  });
}

/**
 * How long a queer-owned confirmation stands before it needs re-making.
 *
 * Two years is long enough that re-confirming is not busywork for the
 * moderation team, and short enough that a business which quietly changed
 * hands stops carrying a badge granted to its previous owners. The badge does
 * not vanish at the deadline: it stops reading as verified while the record of
 * who granted it, and when, stays intact for whoever picks the re-check up.
 */
export const QUEER_OWNED_VERIFICATION_VALIDITY_MONTHS = 24;

/**
 * The verifier recorded when a grant cannot be traced to a named moderator
 * (their profile no longer resolves). Still an honest answer — the moderation
 * team did confirm it — and still better than an empty column, which is what
 * made the badge uninspectable in the first place.
 */
export const DEFAULT_QUEER_OWNED_VERIFIER = 'QueerPulse moderation';

/** Today as a `YYYY-MM-DD` string, matching the `date` columns' wire form. */
function isoDateToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` plus a whole number of months, in UTC.
 *
 * `Date.UTC` rolls a short month over (31 January plus one month becomes
 * 2 or 3 March), which is the right behaviour for a re-confirmation deadline:
 * the exact day matters far less than not silently landing the badge on a date
 * that does not exist.
 */
function addMonthsToIsoDate(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1 + months, day))
    .toISOString()
    .slice(0, 10);
}

/**
 * Wipes the queer-owned provenance columns back to their entity defaults.
 * Used when a moderator WITHDRAWS the badge, and when an owner edit changes
 * the identity the badge was granted against. Never used for expiry: an
 * expired badge keeps its record on purpose.
 */
function clearQueerOwnedProvenance(listing: Listing): void {
  listing.queerOwnedVerifier = '';
  listing.queerOwnedReVerifiedAt = null;
  listing.queerOwnedBasis = '';
  listing.queerOwnedExpiresAt = null;
}

/**
 * The fields that restate WHO the business is: its name, the queer-owned /
 * friendly badge, and the self-reported ownership link. A moderator's
 * independent `queerOwnedVerified` confirmation was made against one specific
 * name, badge and ownership claim, so once any of the three changes that
 * confirmation is about a listing which no longer presents itself the same
 * way. `update()` drops the badge and a moderator re-confirms it.
 *
 * Clearing that badge is the ONLY consequence of an owner edit. It never
 * changes `listing.status`: once a listing has been approved it stays live
 * through its owner's edits, because pulling a business out of the public
 * directory every time it corrects its own phone number costs the directory
 * more than a badge waiting on a re-confirmation does.
 */
const IDENTITY_LISTING_FIELDS = [
  'name',
  'badge',
  'linkToProfile',
] as const satisfies readonly (keyof Listing)[];

/**
 * Every field an owner PATCH can reach, mapped to the plain-language name the
 * moderation audit trail uses for it: `update()` writes an `owner_edited`
 * event that names what moved, so a moderator reading
 * `GET /listings/admin/:ref/history` can see what an owner changed on a live
 * listing without diffing rows by hand.
 *
 * `latitude` and `longitude` deliberately share one label, because a moved pin
 * reads as a single edit whichever half of the pair the PATCH carried.
 */
const OWNER_EDITABLE_FIELD_LABELS: Partial<Record<keyof Listing, string>> = {
  path: 'the submission path',
  name: 'the business name',
  cats: 'the categories',
  hood: 'the neighbourhood',
  city: 'the city',
  timezone: 'the timezone',
  badge: 'the queer-owned or friendly badge',
  evidence: 'the evidence behind the badge',
  price: 'the price range',
  blurb: 'the description',
  tagline: 'the tagline',
  whatItIs: 'the "what it is" lines',
  tags: 'the tags',
  goodFor: 'the "good for" tags',
  accessibilityAnswers: 'the accessibility answers',
  accessibilityNote: 'the accessibility note',
  services: 'the services and prices',
  langs: 'the languages spoken',
  online: 'the online-only setting',
  address: 'the address',
  geocoded: 'the geocoded flag',
  latitude: 'the map pin',
  longitude: 'the map pin',
  hours: 'the opening hours',
  hoursNote: 'the opening-hours note',
  hoursExceptions: 'the holiday and special-date hours',
  social: 'the contact and social links',
  // The gallery is the audited field. `photos`/`alt` are deliberately absent:
  // they are a derived mirror of the first four gallery entries, so auditing
  // them would report the same edit twice and would still miss a reordering, a
  // caption or a fifth photo.
  photoGallery: 'the photos',
  rel: 'the relationship to the business',
  ownerName: 'the owner name',
  ownerRole: 'the owner role',
  ownerBio: 'the owner bio',
  visibility: 'the owner visibility preference',
  linkToProfile: 'the link to the owner profile',
  contactEmail: 'the contact email',
  consentOuting: 'the outing consent',
  consentGuide: 'the guide consent',
};

/**
 * The given fields whose value the edit actually changed. This is what lets
 * `update()` tell a real edit from a PATCH that re-sends values already
 * stored, which must neither clear the queer-owned badge nor write an audit
 * row for nothing.
 *
 * `JSON.stringify` is total over these column types (scalars, string arrays,
 * and the flat `social`/`photos`/`whatItIs` JSON shapes) and key order within
 * them is fixed by `applyUpdate`'s spread-merge, so equal content always
 * compares equal. `applyUpdate` also replaces those nested objects rather than
 * mutating them in place, so a shallow `{ ...listing }` snapshot taken before
 * it runs stays a faithful "before" picture.
 */
function changedListingFields(
  before: Listing,
  after: Listing,
  fields: readonly (keyof Listing)[],
): (keyof Listing)[] {
  return fields.filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );
}

/**
 * The plain-language `reason` recorded on an `owner_edited` audit row: what the
 * owner changed, and whether the edit cost the listing its queer-owned badge.
 */
function describeOwnerEdit(
  changedFields: readonly (keyof Listing)[],
  wasQueerOwnedBadgeCleared: boolean,
): string {
  const changedLabels: string[] = [];
  for (const field of changedFields) {
    const label = OWNER_EDITABLE_FIELD_LABELS[field];
    if (label !== undefined && !changedLabels.includes(label)) {
      changedLabels.push(label);
    }
  }
  const changeSummary =
    changedLabels.length > 0
      ? changedLabels.join(', ')
      : 'other listing details';
  const badgeNote = wasQueerOwnedBadgeCleared
    ? ' The queer-owned verification badge was cleared by this edit, because the' +
      ' listing no longer carries the identity a moderator confirmed. A' +
      ' moderator has to confirm it again.'
    : '';
  return (
    `The owner edited this live listing and changed ${changeSummary}. ` +
    'The listing stayed live: once a listing is approved it does not need ' +
    `another approval to publish.${badgeNote}`
  );
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
/**
 * What `ListingsService.loadOwnedOrCoManagedOr404` hands back: the listing, and
 * which of the two management seats the caller holds on it.
 *
 * `isOwner: false` therefore means "active co-manager", never "stranger" — a
 * stranger never gets a value out of that gate at all, they get a 404.
 */
export interface ListingManagementAccess {
  listing: Listing;
  isOwner: boolean;
}

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
    @InjectRepository(ListingPublicQuestion)
    private readonly publicQuestions: Repository<ListingPublicQuestion>,
    @InjectRepository(ListingQuestion)
    private readonly questions: Repository<ListingQuestion>,
    private readonly dataSource: DataSource,
    private readonly messaging: MessagingService,
    private readonly notifications: NotificationsService,
    private readonly storage: StorageService,
    // Files listing disputes + owner-notify tasks through the shared
    // report+moderation pipeline (item #13) rather than a parallel one.
    private readonly reports: ReportsService,
    // Batched crop lookup (`MediaCropService.getMany`) for `photos`'s
    // per-slot `photoCrops` sibling.
    private readonly mediaCropService: MediaCropService,
    // The second management gate's data source: who, besides the owner, may run
    // this listing day to day. `ListingCoManagersService` injects no service
    // from this file, so there is no cycle to break here.
    private readonly coManagers: ListingCoManagersService,
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
      reasonCode: LISTING_DISPUTE_REASON_CODE,
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
    excludeRef?: string,
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
      .where('listing.status = :status', { status: ListingStatus.Live })
      // A listing its owner has paused is out of the directory, so it is not
      // something a new submission can be a duplicate "of" from the
      // submitter's point of view, and surfacing its name/slug/neighbourhood
      // here would announce a business that chose to be withdrawn. A duplicate
      // row landing in the moderation queue is the cheaper problem.
      .andWhere('listing.isHiddenByOwner = false');

    // The edit wizard re-runs this dedupe check against the listing's own
    // (unchanged) name — exclude it so it never surfaces as a duplicate of
    // itself.
    if (excludeRef) {
      queryBuilder.andWhere('listing.ref != :excludeRef', { excludeRef });
    }

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
    // The cover is the FIRST photo of the ordered gallery, whichever request
    // shape carried it. Its alt text is required too: a claimed listing's lead
    // image is the one every card and detail page renders, and shipping it
    // undescribed is exactly the accessibility hole the per-photo `alt` field
    // exists to close. Backfilled rows keep their empty alt untouched — this
    // gate only runs on the `claim` submission path.
    const gallery = galleryFromCreateInput(dto);
    const coverPhoto = gallery[0];
    if (!coverPhoto) {
      missing.push('a main photo');
    } else if (!coverPhoto.alt.trim()) {
      missing.push('alt text for the main photo');
    }

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

  /**
   * "Which listings are mine": the ones the member OWNS and the ones they
   * CO-MANAGE, in one page, each row saying which.
   *
   * Leaving the co-managed ones out would have made the feature unreachable.
   * Every management route is keyed by `ref`, and this is the only endpoint
   * that tells a member what their refs are, so a co-manager with no listing on
   * this page has access they cannot navigate to.
   *
   * `managementRole` is what distinguishes them, and it is not decoration: an
   * `owner` row carries the full `ListingDTO`, a `co_manager` row carries the
   * redacted one, so the same page must never be rendered as if every row had
   * the same fields. `toManagedListingDTO` decides per row.
   *
   * THE QUERY. Co-managed ids are fetched first and folded in as an `IN` list
   * rather than joined, which keeps this a single-table query over `listings`
   * with no join at all. That is deliberate: `paginate` uses `.skip()/.take()`,
   * and `.skip()/.take()` with a join plus an ORDER BY on a joined alias is the
   * "column distinctAlias.X does not exist" trap. With no join there is no
   * distinct pass to fall into, and the ORDER BY stays on `listings`' own
   * `created_at`. The id list is bounded in practice by the per-listing cap
   * from the other side, and by how many businesses one person helps run.
   */
  async listMine(
    userId: string,
    query: ListMyListingsQueryInput,
  ): Promise<Paginated<ManagedListingDTO>> {
    const page = normalizePage(query.page);
    const coManagedListingIds =
      await this.coManagers.listingIdsCoManagedBy(userId);

    const qb = this.listings.createQueryBuilder('l');
    if (coManagedListingIds.length > 0) {
      qb.where(
        new Brackets((where) => {
          where
            .where('l.owner_id = :userId', { userId })
            .orWhere('l.id IN (:...coManagedListingIds)', {
              coManagedListingIds,
            });
        }),
      );
    } else {
      qb.where('l.owner_id = :userId', { userId });
    }
    qb.orderBy('l.created_at', 'DESC');

    return paginate(qb, page, async (rows) => {
      if (!rows.length) return [];
      // `ownerId` is NULL for an entry whose owner erased their account
      // (`SetNullContentAuthorFksOnUserErasure1794610000000`): the venue
      // record stays live and unclaimed, with no member to name on it.
      const refs = await new MemberLookup(this.profiles).byUserIds(
        presentActorIds(rows.map((row) => row.ownerId)),
      );
      // ONE batched crop lookup for every row's gallery photos on the
      // page — never a per-row query.
      const crops = await this.mediaCropService.getMany(
        rows.flatMap((row) => listingPhotoKeys(row)),
      );
      return rows.map((row) =>
        toManagedListingDTO(
          toListingDTO(row, actorFromLookup(refs, row.ownerId) ?? null, crops),
          row.ownerId === userId,
        ),
      );
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
          presentActorIds(rows.map((row) => row.ownerId)),
        );
        // ONE batched crop lookup for every row's gallery photos on the
        // page — never a per-row query.
        const crops = await this.mediaCropService.getMany(
          rows.flatMap((row) => listingPhotoKeys(row)),
        );
        return rows.map((row) =>
          toListingDTO(row, actorFromLookup(refs, row.ownerId) ?? null, crops),
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
    // Entity property paths (`createdAt`), not raw DB columns: when `?q=` is
    // present `buildQueueSearchQuery` adds a submitter `leftJoin`, and `paginate`
    // (skip/take) then routes this through TypeORM's distinct-id pagination pass,
    // which resolves ORDER BY via `findColumnWithPropertyPath` and throws
    // `undefined.databaseName` on a raw column name. (`l.name` already resolves —
    // its property name equals its column name.)
    switch (sort) {
      case 'oldest':
        qb.orderBy('l.createdAt', 'ASC');
        break;
      case 'name':
        qb.orderBy('l.name', 'ASC');
        break;
      case 'newest':
      default:
        qb.orderBy('l.createdAt', 'DESC');
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

  /**
   * CO-MANAGER-ALLOWED (`loadOwnedOrCoManagedOr404`): the management view of
   * one listing the caller runs.
   *
   * A co-manager's copy carries `managementRole: 'co_manager'` and none of the
   * eight owner-personal fields — see `listing-owner-personal-fields.ts` for
   * what those are and why they leave. That redaction is also what makes the
   * write side ergonomic: the object a co-manager loads here round-trips into
   * `PATCH /listings/:ref` without tripping the owner-personal-field gate,
   * because the keys it would refuse are simply not in it.
   */
  async getByRef(ref: string, userId: string): Promise<ManagedListingDTO> {
    const { listing, isOwner } = await this.loadOwnedOrCoManagedOr404(
      ref,
      userId,
    );
    return this.buildManagedDTO(listing, isOwner);
  }

  /**
   * CO-MANAGER-ALLOWED (`loadOwnedOrCoManagedOr404`): editing the listing's
   * content, which is the single largest thing a co-manager exists to do. The
   * hours, the hours exceptions, the photos and the gallery, the services, the
   * accessibility answers and the tags are all fields on this one PATCH, so
   * opening this route is what opens all of them.
   *
   * A CO-MANAGER MAY NOT WRITE THE OWNER'S PERSONAL FIELDS, and that is
   * enforced here before anything is read or merged. Hiding those fields on the
   * way out while leaving them patchable on the way in would be a policy in
   * name only. `assertNoOwnerPersonalListingFields` throws 403 rather than
   * dropping them silently; its doc comment argues that choice out in full.
   */
  async update(
    ref: string,
    userId: string,
    dto: UpdateListingDto,
  ): Promise<ManagedListingDTO> {
    const { listing, isOwner } = await this.loadOwnedOrCoManagedOr404(
      ref,
      userId,
    );
    if (!isOwner) {
      assertNoOwnerPersonalListingFields(dto as Record<string, unknown>);
    }

    // Runs BEFORE any mutation (`ListingsController.update` is on
    // `SHARED_UPLOAD_HANDLERS`, so the interceptor's foreign-upload check is
    // exempted for this handler): a co-editor of a claimed listing may re-save
    // a photo whoever uploaded it, but may not point the listing at a NEW
    // upload that is not theirs. The comparison set is every photo reference
    // the listing currently carries, so anything stored and re-sent verbatim
    // passes while a brand-new foreign key is refused.
    //
    // Both request shapes are checked, because both can introduce a reference:
    // the ordered `photoGallery` and the legacy `photos` slot pair. And both
    // stored shapes go into the comparison set, so a listing whose row predates
    // the backfill still recognises its own photos.
    if (dto.photoGallery !== undefined || dto.photos !== undefined) {
      const alreadyStoredPhotoKeys = [
        ...galleryImageReferences(listing.photoGallery),
        listing.photos?.wide,
        listing.photos?.d1,
        listing.photos?.d2,
        listing.photos?.vibe,
      ];
      const incomingPhotoKeys = [
        ...(dto.photoGallery ?? []).map((photo) => photo.image),
        ...(dto.photos
          ? [dto.photos.wide, dto.photos.d1, dto.photos.d2, dto.photos.vibe]
          : []),
      ];
      for (const incomingPhotoKey of incomingPhotoKeys) {
        assertNoForeignUploadIntroduced(
          userId,
          incomingPhotoKey,
          alreadyStoredPhotoKeys,
        );
      }
    }

    // Snapshot the gallery keys BEFORE the merge so any photo the edit replaces
    // or clears can be deleted from the bucket once the new set has committed.
    const previousImageKeys = this.collectListingImageKeys(listing);
    // Snapshot every column BEFORE the merge, so the edit can be described
    // afterwards. `applyUpdate` replaces the nested `social`/`photos`/`alt`
    // objects rather than mutating them, so this shallow copy stays a faithful
    // "before" picture (see `changedListingFields`).
    const listingBeforeEdit: Listing = { ...listing };
    const wasLive = listing.status === ListingStatus.Live;
    applyUpdate(listing, dto);

    // An owner edit NEVER changes `listing.status`. Once a moderator has
    // approved a listing it stays live through its owner's corrections, and a
    // listing still in `review` or `question` stays exactly where it is.
    // Publication is no longer gated on the edit, so the audit trail carries
    // the edit instead: moderators keep a record of what an owner changed on a
    // live listing (`owner_edited`), which is what the old forced re-review was
    // really providing.
    //
    // Computed for EVERY listing, live or not, because the freshness stamp
    // below cares only about whether the edit actually moved something. The
    // audit trail still narrows to live listings (`changedFields` right after
    // this), since an `owner_edited` event on a listing that has not been
    // published yet tells a moderator nothing they will not see in the queue.
    const editedFields = changedListingFields(
      listingBeforeEdit,
      listing,
      Object.keys(OWNER_EDITABLE_FIELD_LABELS) as (keyof Listing)[],
    );

    // Editing your details IS confirming them: an owner who just corrected the
    // phone number has, at that moment, looked at the listing and vouched for
    // it. A PATCH that re-sends values already stored changes nothing and so
    // stamps nothing, which is the same "was this a real edit?" test the audit
    // row uses. `detailsConfirmedAt` is deliberately absent from
    // `OWNER_EDITABLE_FIELD_LABELS`, so writing it here can never feed back
    // into `editedFields` or into the audit `reason`.
    if (editedFields.length > 0) {
      listing.detailsConfirmedAt = new Date();
    }

    const changedFields = wasLive ? editedFields : [];
    const hasIdentityChanged =
      wasLive &&
      changedListingFields(listingBeforeEdit, listing, IDENTITY_LISTING_FIELDS)
        .length > 0;
    const wasQueerOwnedBadgeCleared =
      hasIdentityChanged && listing.queerOwnedVerified;
    if (wasQueerOwnedBadgeCleared) {
      // The moderator confirmed queer ownership of a listing that no longer
      // presents itself the same way. Drop that confirmation and let them
      // re-make it, rather than let a renamed or re-badged listing inherit a
      // badge it was never granted. This is a badge change only: the listing
      // stays live and publicly visible throughout.
      listing.queerOwnedVerified = false;
      // The provenance goes with it. A verifier name, a confirmation date and
      // an expiry left standing under a withdrawn badge would describe a
      // confirmation that no longer applies to the listing as it now reads.
      clearQueerOwnedProvenance(listing);
    }

    // The listing save and its audit event are two writes with no external I/O
    // between them, so they run in one transaction, the same shape `setStatus`
    // uses for the moderator-initiated equivalent. `actorId` is the OWNER here
    // rather than a moderator: the event records who made the edit.
    // `fromStatus`/`toStatus` are both null, because an owner edit moves no
    // moderation state.
    const saved =
      changedFields.length > 0
        ? await this.dataSource.transaction(async (manager) => {
            const savedListing = await manager.save(listing);
            await manager.save(ListingModerationEvent, {
              listingId: savedListing.id,
              actorId: userId,
              action: ListingModerationAction.OwnerEdited,
              fromStatus: null,
              toStatus: null,
              reason: describeOwnerEdit(
                changedFields,
                wasQueerOwnedBadgeCleared,
              ),
            });
            return savedListing;
          })
        : await this.listings.save(listing);
    // Delete-on-replace: any photo object no longer referenced by the saved
    // listing is now orphaned. Best-effort + post-commit — a storage failure
    // must never fail the edit.
    const survivingImageKeys = new Set(this.collectListingImageKeys(saved));
    await this.deleteOrphanedObjects(
      previousImageKeys.filter((key) => !survivingImageKeys.has(key)),
      `listing ${saved.ref}`,
    );
    return this.buildManagedDTO(saved, isOwner);
  }

  /**
   * Owner-only (`loadOwnedOr404`, the same gate as `update`/`remove`): declare
   * whether the business is still trading.
   *
   * This is the business reporting on itself, so it deliberately does NOT
   * touch `listing.status`, does not write a moderation event, and does not
   * send the listing back for re-review (there is no re-review path any more).
   * A permanently closed venue stays exactly as `live` as it was; what changes
   * is that `DirectoryService` stops surfacing it in browse, search, map and
   * safe-space results while its detail page, its reviews and this closure
   * notice all keep resolving.
   *
   * The supporting fields are rewritten from the body every time rather than
   * merged, so a listing that reopens cannot keep the note and forwarding
   * address of the closure it just left behind.
   */
  async setOperatingState(
    ref: string,
    userId: string,
    dto: UpdateOperatingStateDto,
  ): Promise<ManagedListingDTO> {
    const { listing, isOwner } = await this.loadOwnedOrCoManagedOr404(
      ref,
      userId,
    );

    const hasStateChanged = listing.operatingState !== dto.state;
    listing.operatingState = dto.state;

    if (dto.state === ListingOperatingState.Open) {
      // Back to normal trading: nothing about the closure is true any more.
      listing.operatingStateNote = '';
      listing.operatingStateSetAt = null;
      listing.movedToAddress = '';
      listing.movedToListingId = null;
    } else {
      listing.operatingStateNote = dto.note ?? '';
      // Stamped only when the STATE moved. Rewording the note months later
      // must not reset "temporarily closed since 4 March" to today, because
      // the date a reader cares about is when the business shut, not when its
      // owner last polished the wording.
      if (hasStateChanged || listing.operatingStateSetAt === null) {
        listing.operatingStateSetAt = new Date();
      }
      if (dto.state === ListingOperatingState.Moved) {
        // `movedToAddress` is required by the DTO on this branch.
        listing.movedToAddress = dto.movedToAddress ?? '';
        listing.movedToListingId = await this.resolveSuccessorListingId(
          listing,
          dto.movedToListingId ?? null,
        );
      } else {
        // A closure is not a move: a forwarding address left over from an
        // earlier `moved` state would read as a live destination.
        listing.movedToAddress = '';
        listing.movedToListingId = null;
      }
    }

    const saved = await this.listings.save(listing);
    return this.buildManagedDTO(saved, isOwner);
  }

  /**
   * Validates the successor listing a `moved` business points at. `null` in,
   * `null` out (most moves have no successor row).
   *
   * A successor must be a real listing, must not be the listing itself (a
   * business cannot have moved to where it already is, and a self-reference
   * would make the banner link to the page it sits on), and must be `live`
   * and publicly reachable: pointing at a listing still in review, or at one
   * its owner has hidden, would publish a link to a page the public cannot
   * open.
   */
  private async resolveSuccessorListingId(
    listing: Listing,
    successorListingId: string | null,
  ): Promise<string | null> {
    if (successorListingId === null) return null;
    if (successorListingId === listing.id) {
      throw new BadRequestException(
        'A listing cannot point at itself as the place it moved to',
      );
    }
    const successorExists = await this.listings.exists({
      where: {
        id: successorListingId,
        status: ListingStatus.Live,
        isHiddenByOwner: false,
      },
    });
    if (!successorExists) {
      throw new BadRequestException(
        'That listing is not a live listing in the directory',
      );
    }
    return successorListingId;
  }

  /**
   * Owner-only: "these details are still accurate", and nothing else.
   *
   * Deliberately the cheapest write in this service. It does not touch
   * `status`, does not write an `owner_edited` moderation event, does not
   * clear the `queerOwnedVerified` badge, and does not rebuild the listing
   * payload on the way out: one owner-scoped SELECT, one single-column UPDATE,
   * and a tiny response. Nothing about the listing changed, so there is
   * nothing for a moderator to review and nothing for the caller to re-render
   * beyond the stamp itself. That cheapness is the feature: an owner should be
   * able to press this whenever they think of it.
   *
   * A real edit stamps the same column from `update()`, on the principle that
   * editing your details is confirming them.
   */
  async confirmDetails(
    ref: string,
    userId: string,
  ): Promise<ConfirmedDetailsDTO> {
    // CO-MANAGER-ALLOWED. "Still accurate" is a statement about the business's
    // details, and the person who keeps those details current is exactly who
    // should be able to make it. The response carries no listing fields at all,
    // so there is nothing here to redact.
    const { listing } = await this.loadOwnedOrCoManagedOr404(ref, userId);
    const confirmedAt = new Date();
    await this.listings.update(
      { id: listing.id },
      { detailsConfirmedAt: confirmedAt },
    );
    return { ref: listing.ref, detailsConfirmedAt: confirmedAt.toISOString() };
  }

  /**
   * OWNER ONLY, and it stays on `loadOwnedOr404` deliberately.
   *
   * This is a hard delete of the business's page along with its reviews, its
   * Q&A and its photo objects. It is the one act on a listing that cannot be
   * undone by whoever comes next, so it belongs to the one person accountable
   * for the listing. A co-manager who needs the page to stop showing has
   * `setDirectoryVisibility`, which is reversible and destroys nothing.
   */
  async remove(ref: string, userId: string): Promise<void> {
    const listing = await this.loadOwnedOr404(ref, userId);
    const imageKeys = this.collectListingImageKeys(listing);
    await this.listings.remove(listing);
    // The row (and its cascade) is gone — its photo objects live outside
    // Postgres and would otherwise keep serving. Best-effort, post-delete.
    await this.deleteOrphanedObjects(imageKeys, `removed listing ${ref}`);
  }

  /**
   * Moderator/admin hard-deletes any listing, regardless of owner. Distinct
   * from `remove(ref, userId)` above, which is owner-gated via `loadOwnedOr404`;
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
    // CO-MANAGER-ALLOWED. The reply publishes as the business's single owner
    // reply either way; it is signed by the venue, not by the person typing,
    // so nothing about the co-manager reaches the public page. `ReviewDTO`
    // carries no listing fields, so there is nothing to redact.
    const { listing } = await this.loadOwnedOrCoManagedOr404(ref, userId);

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

  /**
   * OWNER ONLY, and it stays on `loadOwnedOr404` deliberately — the one route
   * a reader might expect co-managers to reach and they do not.
   *
   * This is not the public Q&A on the listing page (that is
   * `answerPublicQuestion`, which IS co-manager-allowed). It is the moderator's
   * private compliance thread from review time, and `askQuestion` delivers each
   * one as a DM to `listing.ownerId` personally. The questions are the vetting
   * questions: who are you to this business, what is your evidence for the
   * badge. Answering them is the accountable owner speaking for themselves to a
   * moderator, and it is the closest thing on this controller to "anything
   * touching ownership".
   *
   * A co-manager is not left in the dark. `GET /listings/:ref/pending` is
   * co-manager-allowed and shows every unanswered moderator question, so they
   * can see one is waiting and tell the owner; what they cannot do is answer as
   * them.
   *
   * Mirrors `replyToReview`'s ownership + scoping shape (the question is looked
   * up scoped to this listing, so an answer can't be attached to a different
   * owner's listing via a guessed id).
   */
  async answerQuestion(
    ref: string,
    questionId: string,
    userId: string,
    answer: string,
  ): Promise<ListingQuestionDTO> {
    const listing = await this.loadOwnedOr404(ref, userId);

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
   * Answer a member's PUBLIC question on a listing, as the listing OWNER.
   *
   * Distinct from `answerQuestion` directly above, which answers a MODERATOR's
   * private question during review. That one is a compliance thread in the
   * admin drawer; this one is words that appear on a public marketing page.
   * Separate tables, separate routes (`public-questions` rather than
   * `questions` under `:ref`), and this comment is here so the two never get
   * quietly merged.
   *
   * Owner-gated by `loadOwnedOr404`, the same check `update`/`remove`/
   * `replyToReview` use, and the question is looked up SCOPED TO THIS LISTING
   * so an answer cannot be attached to another owner's question through a
   * guessed id.
   */
  async answerPublicQuestion(
    ref: string,
    questionId: string,
    userId: string,
    answer: string,
  ): Promise<ListingPublicQuestionDTO> {
    // CO-MANAGER-ALLOWED. Same reasoning as `replyToReview`: the answer appears
    // under the business's name on its own page, and leaving it owner-only
    // would mean the person actually running the page watches questions go
    // unanswered.
    const { listing } = await this.loadOwnedOrCoManagedOr404(ref, userId);
    return this.writePublicAnswer(listing, questionId, userId, answer, false);
  }

  /**
   * Answer a member's public question as a MODERATOR, from
   * `POST /admin/listings/:ref/public-questions/:id/answer`.
   *
   * WHY MODERATORS CAN ANSWER AT ALL. Owner-only was the obvious rule and it is
   * the wrong one here, for a reason specific to this directory: a large share
   * of listings have no owner. The `friendly` and `suggested` submission paths
   * create rows with a null `owner_id` for businesses that never claimed their
   * page, and those are frequently exactly the venues people have questions
   * about. Under an owner-only rule the question box on every one of them would
   * be a form that accepts questions nobody is able to answer, which is worse
   * than not offering it. Abandoned owned listings fail the same way, more
   * slowly.
   *
   * WHAT IT DOES NOT DO. A moderator answering does not get to speak as the
   * business. `is_answered_by_moderator` is stamped on the row and surfaces as
   * `answeredByRole: 'moderator'` in the DTO, so the page labels it as coming
   * from platform staff. That distinction is load-bearing: an accessibility or
   * safety answer attributed to the venue is a commitment BY the venue, and
   * staff must not be able to make one on their behalf. The individual
   * moderator is never named in the response either — the role is the part a
   * reader needs, and naming staff on a public business page exposes them to
   * exactly the pressure the role label avoids.
   *
   * Unlike the owner path this does NOT require ownership, so it loads with
   * `loadOr404`; the route's `RolesGuard` is the gate.
   */
  async answerPublicQuestionAsModerator(
    ref: string,
    questionId: string,
    moderatorUserId: string,
    answer: string,
  ): Promise<ListingPublicQuestionDTO> {
    const listing = await this.loadOr404(ref);
    return this.writePublicAnswer(
      listing,
      questionId,
      moderatorUserId,
      answer,
      true,
    );
  }

  /**
   * The write both answer paths share. Everything except WHO is allowed to get
   * here is identical, which is the point of factoring it: the owner path and
   * the moderator path cannot drift apart in what they record or who they
   * notify.
   */
  private async writePublicAnswer(
    listing: Listing,
    questionId: string,
    actorUserId: string,
    answer: string,
    isModerator: boolean,
  ): Promise<ListingPublicQuestionDTO> {
    const question = await this.publicQuestions.findOne({
      where: { id: questionId, listingId: listing.id },
    });
    if (!question) {
      throw new NotFoundException('Question not found');
    }

    // Same post-trim re-check `replyToReview` documents: `@MinLength(1)` lets
    // `" "` through, which would store an `answeredAt` with nothing under it and
    // render as answered-but-blank.
    const text = answer.trim();
    if (!text) {
      throw new BadRequestException('Answer cannot be empty');
    }

    question.answer = text;
    question.answeredAt = new Date();
    question.answeredById = actorUserId;
    question.isAnsweredByModerator = isModerator;
    const saved = await this.publicQuestions.save(question);

    await this.notifyQuestionAnsweredBestEffort(
      saved.askerId,
      listing,
      isModerator ? null : actorUserId,
    );

    const asker = saved.askerId
      ? await this.profiles.findOne({
          where: { userId: saved.askerId },
          select: { slug: true, avatarUrl: true, photoVisible: true },
        })
      : null;
    return toListingPublicQuestionDTO(
      saved,
      asker
        ? {
            slug: asker.slug,
            avatarUrl: asker.photoVisible ? toImageUrl(asker.avatarUrl) : null,
          }
        : null,
    );
  }

  /**
   * Best-effort "your question was answered" notification to the asker. Never
   * throws: the answer has already committed, and the same never-block ordering
   * every other notification in this module uses.
   *
   * `ownerActorId` is the answering OWNER, or `null` when a moderator answered.
   * Passing no actor for a moderator answer is deliberate on two counts: the
   * asker is owed the answer rather than the name of the staff member who wrote
   * it, and an actor is also what block/mute filtering keys on, which is a
   * member-to-member control that should not silence platform staff.
   */
  private async notifyQuestionAnsweredBestEffort(
    askerId: string | null,
    listing: Listing,
    ownerActorId: string | null,
  ): Promise<void> {
    // Null after an account erasure nulled the FK out. The question and its
    // answer survive for other readers; there is simply nobody left to tell.
    if (!askerId) return;
    // An owner answering their own question would be a notification to
    // themselves. `askQuestion` blocks the owner from asking, so this is
    // belt-and-braces against a future path that does not.
    if (ownerActorId === askerId) return;
    try {
      await this.notifications.create(
        askerId,
        NotificationType.ListingPublicQuestionAnswered,
        {
          ...(ownerActorId ? { actorId: ownerActorId } : {}),
          source: 'listing',
          listingSlug: listing.slug,
          listingName: listing.name,
        },
        ownerActorId ?? undefined,
      );
    } catch {
      // Intentionally ignored — the answer already committed.
    }
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

  /**
   * C3, the OWNER's own view of the same audit trail `getListingHistory`
   * serves moderators (`GET /listings/:ref/history`). Owner-gated through
   * `loadOwnedOr404`, the same gate as `update`/`remove`/`answerQuestion`, so
   * a ref owned by somebody else 404s exactly like a non-existent one.
   *
   * Until now the owner saw none of this table, including the `owner_edited`
   * row their own edit had just written.
   *
   * What they see is deliberately narrower than what a moderator sees, and the
   * narrowing lives in `owner-listing-history.dto.ts` rather than here so it
   * cannot be forgotten by a caller. In short: no actor identity on any row
   * (the field does not exist on the owner DTO), and no `reason` text unless
   * the platform composed it rather than a person typing it. Read
   * `OWNER_VISIBLE_MODERATION_REASON_ACTIONS`'s doc comment for the full rule
   * and why each excluded action is excluded.
   *
   * Because no actor is ever resolved, this method needs none of the batched
   * `MemberLookup` work `getListingHistory` does.
   *
   * Pagination: `events` grows without bound (every owner edit adds a row), so
   * it is page-paginated newest-first with `PAGE_SIZE` via a plain
   * `findAndCount` on one table with no join. The Q&A thread on a single
   * listing is short, so it comes back whole under `DEFAULT_LIST_LIMIT`,
   * matching how the admin endpoint returns it.
   */
  async getOwnerListingHistory(
    ref: string,
    userId: string,
    page?: number,
  ): Promise<OwnerListingHistoryDTO> {
    // CO-MANAGER-ALLOWED. Someone editing a live listing has to be able to see
    // what has already happened to it, including the `owner_edited` rows their
    // own edits write. Nothing in this response needs redacting for them: the
    // DTO has no actor field at all, and the only `reason` strings it forwards
    // are platform-composed (see `OWNER_VISIBLE_MODERATION_REASON_ACTIONS`) —
    // field LABELS on an owner edit, never the values, so an owner's contact
    // email can never surface here as the content of a change note.
    const { listing } = await this.loadOwnedOrCoManagedOr404(ref, userId);
    const currentPage = normalizePage(page);

    const [[events, totalEvents], questions] = await Promise.all([
      this.moderationEvents.findAndCount({
        where: { listingId: listing.id },
        order: { createdAt: 'DESC' },
        skip: (currentPage - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this.questions.find({
        where: { listingId: listing.id },
        order: { createdAt: 'DESC' },
        take: DEFAULT_LIST_LIMIT,
      }),
    ]);

    return toOwnerListingHistoryDTO(
      events.map(toOwnerListingModerationEventDTO),
      questions.map(toOwnerListingQuestionDTO),
      totalEvents,
      currentPage,
      PAGE_SIZE,
    );
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

  /**
   * Moderator/admin-only (`AdminListingsController`'s class-level
   * `RolesGuard`). Grants or withdraws the queer-owned badge AND records the
   * evidence behind it, the way `setSafeSpace` records the evidence behind the
   * badge beside it.
   *
   * Every provenance field is filled on a grant, never left blank. A moderator
   * who sends only `{ verified: true }` still produces a badge that names them
   * as the verifier, is dated today, and expires on a real date, because a
   * badge nobody can trace back is precisely the thing this replaced: two
   * badges sitting side by side, looking equally authoritative, backed by very
   * different evidence.
   *
   * Withdrawing (`verified: false`) clears the provenance columns, mirroring
   * `setSafeSpace(none)`. That is deliberately different from EXPIRY, which
   * keeps every column exactly where it is and only stops the badge reading as
   * verified: a moderator saying "this was wrong" and a calendar saying "this
   * needs looking at again" are not the same event.
   */
  async setQueerOwnedVerified(
    ref: string,
    actorId: string,
    dto: UpdateQueerOwnedVerifiedDto,
  ): Promise<ListingDTO> {
    const listing = await this.loadOr404(ref);
    listing.queerOwnedVerified = dto.verified;

    if (!dto.verified) {
      clearQueerOwnedProvenance(listing);
    } else {
      const reVerifiedAt = dto.reVerifiedAt ?? isoDateToday();
      listing.queerOwnedVerifier =
        dto.verifier?.trim() || (await this.resolveVerifierName(actorId));
      listing.queerOwnedReVerifiedAt = reVerifiedAt;
      if (dto.basis !== undefined) listing.queerOwnedBasis = dto.basis;
      listing.queerOwnedExpiresAt =
        dto.expiresAt ??
        addMonthsToIsoDate(
          reVerifiedAt,
          QUEER_OWNED_VERIFICATION_VALIDITY_MONTHS,
        );
    }

    const saved = await this.listings.save(listing);
    return this.buildDTO(saved);
  }

  /**
   * The acting moderator's own name, used as the verifier when they did not
   * type one. Falls back to the team label when their profile cannot be
   * resolved, so the column is never left empty on a live grant.
   */
  private async resolveVerifierName(actorId: string): Promise<string> {
    const refs = await new MemberLookup(this.profiles).byUserIds([actorId]);
    const actor = refs.get(actorId);
    const actorName = actor
      ? `${actor.firstName} ${actor.lastName}`.trim()
      : '';
    return actorName || DEFAULT_QUEER_OWNED_VERIFIER;
  }

  /**
   * Owner-only (`loadOwnedOr404`, the same gate as `update`/`remove`): pause
   * or resume the listing's appearance in the directory.
   *
   * Distinct from `setOperatingState`, and the two are deliberately not folded
   * together. That one reports on the BUSINESS (is it trading); this one
   * reports on the LISTING (is the owner showing it). A hidden listing keeps
   * its reviews, photos, badges and moderation history untouched, and unhiding
   * restores it whole, which is the point: owners were deleting listings to
   * get a pause, and a delete takes the reviews with it.
   *
   * Nothing here touches `status`: hiding a listing is not a moderation event
   * and does not send it back for re-review.
   */
  async setDirectoryVisibility(
    ref: string,
    userId: string,
    dto: UpdateListingVisibilityDto,
  ): Promise<ManagedListingDTO> {
    // CO-MANAGER-ALLOWED: pause or resume the listing's appearance in the
    // directory. Reversible by anyone who can reach this route, and it destroys
    // nothing — a paused listing keeps every review, photo and badge — which is
    // what separates it from `remove` two methods up.
    //
    // `listings.visibility` is NOT this. That column is the owner's own
    // identity-disclosure choice and is one of the eight owner-personal fields
    // a co-manager can neither read nor write. Two unrelated meanings of one
    // word, and this comment is here so the two never get merged.
    const { listing, isOwner } = await this.loadOwnedOrCoManagedOr404(
      ref,
      userId,
    );

    if (listing.isHiddenByOwner !== dto.isHiddenByOwner) {
      listing.isHiddenByOwner = dto.isHiddenByOwner;
      // Stamped only on the transition, so "hidden since 4 March" survives a
      // repeated PATCH of the same value, and cleared on the way back so a
      // shown listing carries no stale hidden-since date.
      listing.ownerHiddenAt = dto.isHiddenByOwner ? new Date() : null;
      await this.listings.save(listing);
    }

    return this.buildManagedDTO(listing, isOwner);
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
   * Every image reference a listing holds.
   *
   * This drives delete-on-replace: `update` diffs the set before the merge
   * against the set after it and deletes the difference from the bucket, so a
   * shape this function cannot see leaks replaced photos forever. It therefore
   * reads BOTH the ordered `photoGallery` (the source of truth) and the legacy
   * `photos`/`alt` mirror, so a row written before the backfill is still
   * cleaned up correctly.
   *
   * Non-key values (external URLs, alt strings that were never keys) are
   * collected too and simply no-op at delete time —
   * `StorageService.deleteObjectByReference` filters them — so callers can diff
   * or delete the raw list without pre-filtering.
   */
  private collectListingImageKeys(listing: Listing): string[] {
    const keys: string[] = galleryImageReferences(listing.photoGallery);
    for (const set of [listing.photos, listing.alt]) {
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

  /**
   * Owner-scoped load: folds ownership into the query so a valid `ref` owned by
   * someone else 404s exactly like a non-existent one, instead of loading it and
   * then 403-ing. Refs are a monotonic sequence (`QPL-<year>-NNNN`), so a
   * 403-vs-404 split would be an existence oracle a member could enumerate. Use
   * this for every owner-management read/update/remove path; keep `loadOr404`
   * only where a non-owner is legitimately allowed to load (public detail /
   * moderator paths).
   */
  private async loadOwnedOr404(ref: string, userId: string): Promise<Listing> {
    const listing = await this.listings.findOne({
      where: { ref, ownerId: userId },
    });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    return listing;
  }

  /**
   * The SECOND management gate: the caller owns this listing OR holds an active
   * co-manager seat on it.
   *
   * Named at full length on purpose. It sits one screen from `loadOwnedOr404`
   * and the two differ by exactly who gets in, so the call site has to say
   * which one it is without anybody opening this file. `loadOwnedOr404` stays
   * on the owner-only acts: deleting the listing, anything touching ownership,
   * and the moderator Q&A thread. Everything a person does to run the business
   * day to day comes through here.
   *
   * Returns `isOwner` alongside the listing rather than just the listing,
   * because two things downstream have to know. Responses are redacted for a
   * co-manager (`toManagedListingDTO`), and `update` refuses a co-manager's
   * write to any owner-personal field. A gate that answered only yes-or-no
   * would leave both of those to be remembered separately at each call site,
   * which is exactly how one of them eventually gets forgotten.
   *
   * Still 404-shaped for anyone who is neither, for the reason
   * `loadOwnedOr404` documents: refs are a monotonic sequence, so a 403-vs-404
   * split would be an existence oracle a member could enumerate.
   *
   * Cost on the owner's own path is unchanged. The ownership test is a plain
   * comparison against the row already loaded, and the seat lookup runs only
   * when it fails.
   */
  private async loadOwnedOrCoManagedOr404(
    ref: string,
    userId: string,
  ): Promise<ListingManagementAccess> {
    const listing = await this.loadOr404(ref);
    if (listing.ownerId === userId) {
      return { listing, isOwner: true };
    }
    if (await this.coManagers.isActiveCoManager(listing.id, userId)) {
      return { listing, isOwner: false };
    }
    throw new NotFoundException('Listing not found');
  }

  /**
   * Builds the listing response for one of the caller's own management
   * surfaces, tagged with their seat and redacted when that seat is
   * co-manager.
   *
   * Every owner-or-co-manager route returns through this method rather than
   * through `buildDTO`, so there is one place the redaction can be checked and
   * no place it can be skipped.
   */
  private async buildManagedDTO(
    listing: Listing,
    isOwner: boolean,
  ): Promise<ManagedListingDTO> {
    return toManagedListingDTO(await this.buildDTO(listing), isOwner);
  }

  private async buildDTO(listing: Listing): Promise<ListingDTO> {
    const [refs, crops] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds(
        presentActorIds([listing.ownerId]),
      ),
      this.mediaCropService.getMany(listingPhotoKeys(listing)),
    ]);
    return toListingDTO(
      listing,
      actorFromLookup(refs, listing.ownerId) ?? null,
      crops,
    );
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
            // Stamped here, from the server clock, because the submitter
            // agreed to the affirming baseline in the act of submitting.
            // `CreateListingDto.affirmingBaselineAccepted` is `@Equals(true)`,
            // so by the time this runs there is no path that reaches it
            // without acceptance, and the client never gets to say WHEN it
            // happened.
            affirmingBaselineAcceptedAt: new Date(),
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
