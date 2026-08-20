import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { CreateResourceListingDto } from './dto/create-resource-listing.dto';
import { UpdateResourceListingDto } from './dto/update-resource-listing.dto';
import { hasAtLeastOneContactField } from './dto/has-at-least-one-contact-field.validator';
import {
  ResourceListing,
  ResourceListingCategory,
  ResourceListingStatus,
} from './entities/resource-listing.entity';
import {
  AdminResourceListingDTO,
  toAdminResourceListingDTO,
} from './resource-listing-response';

/**
 * Admin CRUD over the Legal Aid / Sexual Health Testing resource directory
 * (CNT-14). Deliberately no auto-conversion path from `ResourceSuggestion`
 * here or anywhere else — an admin who has verified an organisation creates
 * the row by hand, using a suggestion only as a reference.
 */
@Injectable()
export class AdminResourceListingsService {
  constructor(
    @InjectRepository(ResourceListing)
    private readonly listings: Repository<ResourceListing>,
  ) {}

  // Every listing, active or archived, optionally filtered by category.
  async listAll(
    category?: ResourceListingCategory,
  ): Promise<AdminResourceListingDTO[]> {
    const rows = await this.listings.find({
      where: category ? { category } : {},
      order: { title: 'ASC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return rows.map(toAdminResourceListingDTO);
  }

  async create(
    dto: CreateResourceListingDto,
    adminUserId: string,
  ): Promise<AdminResourceListingDTO> {
    const saved = await this.listings.save(
      this.listings.create({
        category: dto.category,
        title: dto.title,
        description: dto.description,
        phone: dto.phone?.trim() ? dto.phone.trim() : null,
        email: dto.email?.trim() ? dto.email.trim() : null,
        website: dto.website?.trim() ? dto.website.trim() : null,
        region: dto.region?.trim() ? dto.region.trim() : null,
        status: dto.status ?? ResourceListingStatus.Active,
        createdBy: adminUserId,
        updatedBy: adminUserId,
      }),
    );
    return toAdminResourceListingDTO(saved);
  }

  async update(
    id: string,
    dto: UpdateResourceListingDto,
    adminUserId: string,
  ): Promise<AdminResourceListingDTO> {
    const listing = await this.listings.findOne({ where: { id } });
    if (!listing) throw new NotFoundException('Resource listing not found');

    if (dto.category !== undefined) listing.category = dto.category;
    if (dto.title !== undefined) listing.title = dto.title;
    if (dto.description !== undefined) listing.description = dto.description;
    if (dto.phone !== undefined) {
      listing.phone = dto.phone?.trim() ? dto.phone.trim() : null;
    }
    if (dto.email !== undefined) {
      listing.email = dto.email?.trim() ? dto.email.trim() : null;
    }
    if (dto.website !== undefined) {
      listing.website = dto.website?.trim() ? dto.website.trim() : null;
    }
    if (dto.region !== undefined) {
      listing.region = dto.region?.trim() ? dto.region.trim() : null;
    }
    if (dto.status !== undefined) listing.status = dto.status;

    // A PATCH can legally omit every contact field (it isn't touching them),
    // but the row that results must still have at least one — re-check the
    // fully merged state, not just the DTO (see the validator's doc).
    if (!hasAtLeastOneContactField(listing)) {
      throw new BadRequestException(
        'A resource listing needs at least one of phone, email or website.',
      );
    }

    listing.updatedBy = adminUserId;
    const saved = await this.listings.save(listing);
    return toAdminResourceListingDTO(saved);
  }

  async remove(id: string): Promise<void> {
    const result = await this.listings.delete({ id });
    if (!result.affected) {
      throw new NotFoundException('Resource listing not found');
    }
  }
}
