import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { Profile } from '../users/entities/profile.entity';
import { CreateListingDto } from './dto/create-listing.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import {
  Listing,
  ListingDayHours,
  ListingPhotoSet,
  ListingSocial,
  ListingStatus,
  ListingWitLine,
} from './entities/listing.entity';
import { ListingDTO, toListingDTO } from './listing-response';

// Postgres unique-violation SQLSTATE. Mirrors `CompaniesService`'s/
// `PartnersService`'s identical file-local helper (not shared/exported, kept
// consistent with that precedent).
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string } };
  return e?.code === '23505' || e?.driverError?.code === '23505';
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
function normalizeCreate(
  dto: CreateListingDto,
): Omit<
  Listing,
  'id' | 'ref' | 'slug' | 'ownerId' | 'status' | 'createdAt' | 'updatedAt'
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
    private readonly dataSource: DataSource,
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

  // Moderator/admin-only (`ListingsController.setStatus`'s `RolesGuard`
  // gate) — any of the three statuses is directly settable; there's no
  // narrower transition graph in the spec's contract.
  async setStatus(ref: string, status: ListingStatus): Promise<ListingDTO> {
    const listing = await this.loadOr404(ref);
    listing.status = status;
    const saved = await this.listings.save(listing);
    return this.buildDTO(saved);
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
    const seq = Number(rows[0].seq);
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
