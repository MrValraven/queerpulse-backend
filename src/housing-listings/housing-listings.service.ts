import {
  BadRequestException,
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
import { MessagingService } from '../messaging/messaging.service';
import { Profile } from '../users/entities/profile.entity';
import { CreateHousingEnquiryDto } from './dto/create-housing-enquiry.dto';
import { CreateHousingListingDto } from './dto/create-housing-listing.dto';
import { UpdateHousingListingDto } from './dto/update-housing-listing.dto';
import {
  HousingListing,
  HousingListingStatus,
} from './entities/housing-listing.entity';
import {
  HousingListingDTO,
  toHousingListingDTO,
} from './housing-listing-response';

// Postgres unique-violation SQLSTATE. Mirrors the file-local helper each
// service (`ListingsService`, `CompaniesService`) keeps by convention.
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string } };
  return e?.code === '23505' || e?.driverError?.code === '23505';
}

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
    ...(dto.billsIncluded !== undefined
      ? { billsIncluded: dto.billsIncluded }
      : {}),
    ...(dto.lgbtqFriendly !== undefined
      ? { lgbtqFriendly: dto.lgbtqFriendly }
      : {}),
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
  ) {}

  async create(
    ownerId: string,
    dto: CreateHousingListingDto,
  ): Promise<HousingListingDTO> {
    const ref = await this.nextRef();
    const saved = await this.createWithUniqueSlug(ownerId, ref, dto);
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
    return this.messaging.deliverEnquiry(fromUserId, listing.ownerId, dto.body);
  }

  /** Moderator/admin: every listing incl. non-live, newest first. */
  async listAllForAdmin(): Promise<HousingListingDTO[]> {
    const rows = await this.listings.find({ order: { createdAt: 'DESC' } });
    return this.mapRows(rows);
  }

  /** Moderator/admin only — any status is directly settable. */
  async setStatus(
    ref: string,
    status: HousingListingStatus,
  ): Promise<HousingListingDTO> {
    const listing = await this.loadOr404(ref);
    listing.status = status;
    const saved = await this.listings.save(listing);
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
    const refs = await new MemberLookup(this.profiles).byUserIds(
      rows.map((r) => r.ownerId),
    );
    return rows.map((r) => toHousingListingDTO(r, refs.get(r.ownerId) ?? null));
  }

  private async buildDTO(listing: HousingListing): Promise<HousingListingDTO> {
    const refs = await new MemberLookup(this.profiles).byUserIds([
      listing.ownerId,
    ]);
    return toHousingListingDTO(listing, refs.get(listing.ownerId) ?? null);
  }

  /** `QPH-<year>-<4-digit seq>`, backed by the `housing_listings_ref_seq`
   * sequence (created in the migration) — atomic, no retry loop. */
  private async nextRef(): Promise<string> {
    const year = new Date().getFullYear();
    const rows = await this.dataSource.query<{ seq: string }[]>(
      "SELECT nextval('housing_listings_ref_seq') AS seq",
    );
    const seq = Number(rows[0].seq);
    return `QPH-${year}-${String(seq).padStart(4, '0')}`;
  }

  // Slug pre-check can lose a race to a concurrent insert; the unique index is
  // the backstop (23505 -> recompute + retry). Mirrors
  // `ListingsService.createWithUniqueSlug`.
  private async createWithUniqueSlug(
    ownerId: string,
    ref: string,
    dto: CreateHousingListingDto,
  ): Promise<HousingListing> {
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
            billsIncluded: dto.billsIncluded ?? false,
            lgbtqFriendly: dto.lgbtqFriendly ?? false,
            availableFrom: dto.availableFrom ?? null,
            minStayMonths: dto.minStayMonths ?? null,
            description: dto.description ?? '',
            features: dto.features ?? [],
            idealFor: dto.idealFor ?? [],
            gallery: dto.gallery ?? [],
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
