import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import {
  OrgTierAdminDTO,
  OrgTierDTO,
  toOrgTier,
  toOrgTierAdmin,
} from './org-tier-response';
import { OrgTier, OrgTierCtaType } from './entities/org-tier.entity';

export interface OrgTierWriteInput {
  name: string;
  priceDisplay: string;
  pricePeriod: string;
  dek: string;
  bullets?: string[];
  footnote: string;
  ctaType: OrgTierCtaType;
  ctaLabel: string;
  ctaTarget?: string | null;
  featured?: boolean;
  sortOrder?: number;
  published?: boolean;
  handle?: string;
}

function isUniqueViolation(err: unknown): boolean {
  const error = err as { code?: string; driverError?: { code?: string } };
  return error?.code === '23505' || error?.driverError?.code === '23505';
}

@Injectable()
export class OrgTiersService {
  constructor(
    @InjectRepository(OrgTier) private readonly tiers: Repository<OrgTier>,
  ) {}

  // Public: published tiers in display order.
  async listPublished(): Promise<OrgTierDTO[]> {
    const rows = await this.tiers.find({
      where: { published: true },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return rows.map(toOrgTier);
  }

  // Admin: every tier, published or not, in display order.
  async listAll(): Promise<OrgTierAdminDTO[]> {
    const rows = await this.tiers.find({
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return rows.map(toOrgTierAdmin);
  }

  async create(dto: OrgTierWriteInput): Promise<OrgTierAdminDTO> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const slug = await allocateUniqueSlug(
        slugify(dto.handle ?? dto.name, 'tier'),
        (candidate) => this.tiers.exists({ where: { slug: candidate } }),
      );
      try {
        const saved = await this.tiers.save(
          this.tiers.create({
            slug,
            name: dto.name,
            priceDisplay: dto.priceDisplay,
            pricePeriod: dto.pricePeriod,
            dek: dto.dek,
            bullets: dto.bullets ?? [],
            footnote: dto.footnote,
            ctaType: dto.ctaType,
            ctaLabel: dto.ctaLabel,
            ctaTarget: dto.ctaTarget ?? null,
            featured: dto.featured ?? false,
            sortOrder: dto.sortOrder ?? 0,
            published: dto.published ?? true,
          }),
        );
        return toOrgTierAdmin(saved);
      } catch (err) {
        if (isUniqueViolation(err) && attempt < MAX_ATTEMPTS) continue;
        if (isUniqueViolation(err))
          throw new ConflictException('Could not allocate a unique tier slug');
        throw err;
      }
    }
    throw new ConflictException('Could not allocate a unique tier slug');
  }

  async update(
    id: string,
    dto: Partial<OrgTierWriteInput>,
  ): Promise<OrgTierAdminDTO> {
    const tier = await this.tiers.findOne({ where: { id } });
    if (!tier) throw new NotFoundException('Tier not found');
    // slug is immutable post-creation (mirrors UpdateCompanyDto omitting handle).
    if (dto.name !== undefined) tier.name = dto.name;
    if (dto.priceDisplay !== undefined) tier.priceDisplay = dto.priceDisplay;
    if (dto.pricePeriod !== undefined) tier.pricePeriod = dto.pricePeriod;
    if (dto.dek !== undefined) tier.dek = dto.dek;
    if (dto.bullets !== undefined) tier.bullets = dto.bullets;
    if (dto.footnote !== undefined) tier.footnote = dto.footnote;
    if (dto.ctaType !== undefined) tier.ctaType = dto.ctaType;
    if (dto.ctaLabel !== undefined) tier.ctaLabel = dto.ctaLabel;
    if (dto.ctaTarget !== undefined) tier.ctaTarget = dto.ctaTarget ?? null;
    if (dto.featured !== undefined) tier.featured = dto.featured;
    if (dto.sortOrder !== undefined) tier.sortOrder = dto.sortOrder;
    if (dto.published !== undefined) tier.published = dto.published;
    const saved = await this.tiers.save(tier);
    return toOrgTierAdmin(saved);
  }

  async remove(id: string): Promise<void> {
    const result = await this.tiers.delete({ id });
    if (!result.affected) throw new NotFoundException('Tier not found');
  }
}
