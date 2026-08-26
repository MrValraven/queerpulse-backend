import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { CreateGlossaryTermDto } from './dto/create-glossary-term.dto';
import { UpdateGlossaryTermDto } from './dto/update-glossary-term.dto';
import { ReviewResourceDto } from './dto/review-resource.dto';
import { GlossaryTerm } from './entities/glossary-term.entity';
import {
  AdminGlossaryTermDTO,
  toAdminGlossaryTermResponse,
} from './resource-response';

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function trimmedOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Admin CRUD over the glossary (CON-08). The glossary page tells readers it
 * is maintained by Trans Hub and Wellbeing; until now those teams had no
 * mechanism to maintain anything, since the table was read-only and had no
 * seed. This is that mechanism.
 */
@Injectable()
export class AdminGlossaryService {
  constructor(
    @InjectRepository(GlossaryTerm)
    private readonly glossaryTerms: Repository<GlossaryTerm>,
  ) {}

  /** Every term, sorted by review-due with never-reviewed terms first — the
   *  same staleness ordering the guide list uses. */
  async list(category?: string): Promise<AdminGlossaryTermDTO[]> {
    const qb = this.glossaryTerms.createQueryBuilder('term');
    if (category) qb.andWhere('term.category = :category', { category });
    const rows = await qb
      .orderBy('term.reviewDueOn', 'ASC', 'NULLS FIRST')
      .addOrderBy('term.term', 'ASC')
      .take(DEFAULT_LIST_LIMIT)
      .getMany();
    return rows.map(toAdminGlossaryTermResponse);
  }

  async create(
    dto: CreateGlossaryTermDto,
    adminUserId: string,
  ): Promise<AdminGlossaryTermDTO> {
    await this.assertSlugFree(dto.slug);
    const saved = await this.glossaryTerms.save(
      this.glossaryTerms.create({
        slug: dto.slug,
        term: dto.term,
        definition: dto.definition,
        definitionPt: trimmedOrNull(dto.definitionPt),
        category: trimmedOrNull(dto.category),
        lastReviewedOn: dto.lastReviewedOn ?? null,
        reviewedBy: trimmedOrNull(dto.reviewedBy),
        reviewDueOn: dto.reviewDueOn ?? null,
        updatedBy: adminUserId,
      }),
    );
    return toAdminGlossaryTermResponse(saved);
  }

  async update(
    id: string,
    dto: UpdateGlossaryTermDto,
    adminUserId: string,
  ): Promise<AdminGlossaryTermDTO> {
    const term = await this.requireById(id);

    if (dto.slug !== undefined && dto.slug !== term.slug) {
      await this.assertSlugFree(dto.slug, id);
      term.slug = dto.slug;
    }
    if (dto.term !== undefined) term.term = dto.term;
    if (dto.definition !== undefined) term.definition = dto.definition;
    if (dto.definitionPt !== undefined) {
      term.definitionPt = trimmedOrNull(dto.definitionPt);
    }
    if (dto.category !== undefined) {
      term.category = trimmedOrNull(dto.category);
    }
    if (dto.lastReviewedOn !== undefined) {
      term.lastReviewedOn = dto.lastReviewedOn;
    }
    if (dto.reviewedBy !== undefined) {
      term.reviewedBy = trimmedOrNull(dto.reviewedBy);
    }
    if (dto.reviewDueOn !== undefined) term.reviewDueOn = dto.reviewDueOn;
    term.updatedBy = adminUserId;

    return toAdminGlossaryTermResponse(await this.glossaryTerms.save(term));
  }

  async review(
    id: string,
    dto: ReviewResourceDto,
    adminUserId: string,
  ): Promise<AdminGlossaryTermDTO> {
    const term = await this.requireById(id);
    term.lastReviewedOn = dto.lastReviewedOn ?? todayIsoDate();
    term.reviewedBy = dto.reviewedBy.trim();
    if (dto.reviewDueOn !== undefined) term.reviewDueOn = dto.reviewDueOn;
    term.updatedBy = adminUserId;
    return toAdminGlossaryTermResponse(await this.glossaryTerms.save(term));
  }

  async remove(id: string): Promise<void> {
    const result = await this.glossaryTerms.delete({ id });
    if (!result.affected)
      throw new NotFoundException('Glossary term not found');
  }

  private async requireById(id: string): Promise<GlossaryTerm> {
    const term = await this.glossaryTerms.findOne({ where: { id } });
    if (!term) throw new NotFoundException('Glossary term not found');
    return term;
  }

  private async assertSlugFree(slug: string, exceptId?: string): Promise<void> {
    const clash = await this.glossaryTerms.findOne({
      where: exceptId ? { slug, id: Not(exceptId) } : { slug },
    });
    if (clash) {
      throw new ConflictException(`A term already uses the slug "${slug}"`);
    }
  }
}
