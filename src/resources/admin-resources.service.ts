import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { CreateResourceDto } from './dto/create-resource.dto';
import { GuideSectionDto } from './dto/guide-section.dto';
import {
  AdminResourceSort,
  ListAdminResourcesQuery,
} from './dto/list-admin-resources.query';
import { ReviewResourceDto } from './dto/review-resource.dto';
import { UpdateResourceDto } from './dto/update-resource.dto';
import { Resource } from './entities/resource.entity';
import { GuideSection } from './guide-section';
import { AdminResourceDTO, toAdminResourceResponse } from './resource-response';

/** ISO date for "today", in the same YYYY-MM-DD shape a Postgres `date`
 *  column round-trips as. */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Flattens the structured prose into the legacy `body` text column, which is
 * NOT NULL and is what the cross-entity search still reads. Keeping it in
 * sync on every write means an editor never has to think about it, and a
 * guide stays findable the moment its prose changes.
 */
function sectionsToPlainBody(
  sections: GuideSection[],
  fallback: string,
): string {
  const text = sections
    .flatMap((section) => [
      section.heading,
      ...section.blocks.map((block) => block.text),
    ])
    .filter((line) => line.trim().length > 0)
    .join('\n\n');
  return text.length > 0 ? text : fallback;
}

function normalizeSections(sections: GuideSectionDto[]): GuideSection[] {
  return sections.map((section) => ({
    id: section.id,
    heading: section.heading,
    blocks: section.blocks.map((block) => ({
      kind: block.kind,
      text: block.text,
    })),
  }));
}

/** Empty string in, NULL out: an editor clearing a field means "there is no
 *  translation / no owner", not "the empty string". */
function trimmedOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Admin CRUD over the editorial resource guides (CON-08). Separate from
 * `ResourcesService`, which stays the public read path: publishing a wrong
 * phone number on a crisis-adjacent guide is a staff act, and the write side
 * gets its own guarded surface (mirrors `AdminResourceListingsService`).
 */
@Injectable()
export class AdminResourcesService {
  constructor(
    @InjectRepository(Resource)
    private readonly resources: Repository<Resource>,
  ) {}

  /**
   * Every guide, published or not. Default sort is `reviewDue` with
   * never-reviewed guides first, because the list's whole reason to exist is
   * answering "which guides are stale?" — NULLS FIRST is the honest ordering
   * there, since a guide nobody has ever read is more urgent than one that
   * merely went past its date.
   */
  async list(query: ListAdminResourcesQuery): Promise<AdminResourceDTO[]> {
    const qb = this.resources.createQueryBuilder('resource');
    if (query.category) {
      qb.andWhere('resource.category = :category', {
        category: query.category,
      });
    }
    this.applySort(qb, query.sort ?? 'reviewDue');
    const rows = await qb.take(DEFAULT_LIST_LIMIT).getMany();
    return rows.map(toAdminResourceResponse);
  }

  private applySort(
    qb: ReturnType<Repository<Resource>['createQueryBuilder']>,
    sort: AdminResourceSort,
  ): void {
    if (sort === 'title') {
      qb.orderBy('resource.title', 'ASC');
      return;
    }
    if (sort === 'updated') {
      qb.orderBy('resource.updatedAt', 'DESC');
      return;
    }
    qb.orderBy('resource.reviewDueOn', 'ASC', 'NULLS FIRST').addOrderBy(
      'resource.title',
      'ASC',
    );
  }

  async getById(id: string): Promise<AdminResourceDTO> {
    return toAdminResourceResponse(await this.requireById(id));
  }

  async create(
    dto: CreateResourceDto,
    adminUserId: string,
  ): Promise<AdminResourceDTO> {
    await this.assertSlugFree(dto.slug);
    const sections = normalizeSections(dto.sections ?? []);
    const saved = await this.resources.save(
      this.resources.create({
        slug: dto.slug,
        category: dto.category,
        title: dto.title,
        titlePt: trimmedOrNull(dto.titlePt),
        description: dto.description,
        descriptionPt: trimmedOrNull(dto.descriptionPt),
        body: sectionsToPlainBody(sections, dto.description),
        meta: trimmedOrNull(dto.meta),
        externalUrl: trimmedOrNull(dto.externalUrl),
        routePath: trimmedOrNull(dto.routePath),
        sections,
        sectionsPt: dto.sectionsPt ? normalizeSections(dto.sectionsPt) : null,
        lastReviewedOn: dto.lastReviewedOn ?? null,
        reviewedBy: trimmedOrNull(dto.reviewedBy),
        reviewDueOn: dto.reviewDueOn ?? null,
        publishedAt: dto.publishedAt ? new Date(dto.publishedAt) : null,
        updatedBy: adminUserId,
      }),
    );
    return toAdminResourceResponse(saved);
  }

  async update(
    id: string,
    dto: UpdateResourceDto,
    adminUserId: string,
  ): Promise<AdminResourceDTO> {
    const resource = await this.requireById(id);

    if (dto.slug !== undefined && dto.slug !== resource.slug) {
      await this.assertSlugFree(dto.slug, id);
      resource.slug = dto.slug;
    }
    if (dto.category !== undefined) resource.category = dto.category;
    if (dto.title !== undefined) resource.title = dto.title;
    if (dto.titlePt !== undefined)
      resource.titlePt = trimmedOrNull(dto.titlePt);
    if (dto.description !== undefined) resource.description = dto.description;
    if (dto.descriptionPt !== undefined) {
      resource.descriptionPt = trimmedOrNull(dto.descriptionPt);
    }
    if (dto.meta !== undefined) resource.meta = trimmedOrNull(dto.meta);
    if (dto.externalUrl !== undefined) {
      resource.externalUrl = trimmedOrNull(dto.externalUrl);
    }
    if (dto.routePath !== undefined) {
      resource.routePath = trimmedOrNull(dto.routePath);
    }
    if (dto.sections !== undefined) {
      resource.sections = normalizeSections(dto.sections);
    }
    if (dto.sectionsPt !== undefined) {
      resource.sectionsPt = normalizeSections(dto.sectionsPt);
    }
    if (dto.lastReviewedOn !== undefined) {
      resource.lastReviewedOn = dto.lastReviewedOn;
    }
    if (dto.reviewedBy !== undefined) {
      resource.reviewedBy = trimmedOrNull(dto.reviewedBy);
    }
    if (dto.reviewDueOn !== undefined) resource.reviewDueOn = dto.reviewDueOn;

    // `body` is derived, never edited directly: recompute it from whatever
    // the prose is now so search and the legacy consumers stay in step.
    resource.body = sectionsToPlainBody(
      resource.sections ?? [],
      resource.description,
    );
    resource.updatedBy = adminUserId;

    return toAdminResourceResponse(await this.resources.save(resource));
  }

  /**
   * Stamps an editorial review. Deliberately its own endpoint: "I read this
   * and it is still accurate" is a different act from "I changed a
   * paragraph", and a typo fix must not silently reset a crisis guide's
   * freshness clock.
   */
  async review(
    id: string,
    dto: ReviewResourceDto,
    adminUserId: string,
  ): Promise<AdminResourceDTO> {
    const resource = await this.requireById(id);
    resource.lastReviewedOn = dto.lastReviewedOn ?? todayIsoDate();
    resource.reviewedBy = dto.reviewedBy.trim();
    if (dto.reviewDueOn !== undefined) resource.reviewDueOn = dto.reviewDueOn;
    resource.updatedBy = adminUserId;
    return toAdminResourceResponse(await this.resources.save(resource));
  }

  async setPublished(
    id: string,
    isPublished: boolean,
    adminUserId: string,
  ): Promise<AdminResourceDTO> {
    const resource = await this.requireById(id);
    resource.publishedAt = isPublished ? new Date() : null;
    resource.updatedBy = adminUserId;
    return toAdminResourceResponse(await this.resources.save(resource));
  }

  async remove(id: string): Promise<void> {
    const result = await this.resources.delete({ id });
    if (!result.affected) throw new NotFoundException('Resource not found');
  }

  private async requireById(id: string): Promise<Resource> {
    const resource = await this.resources.findOne({ where: { id } });
    if (!resource) throw new NotFoundException('Resource not found');
    return resource;
  }

  private async assertSlugFree(slug: string, exceptId?: string): Promise<void> {
    const clash = await this.resources.findOne({
      where: exceptId ? { slug, id: Not(exceptId) } : { slug },
    });
    if (clash) {
      throw new ConflictException(`A guide already uses the slug "${slug}"`);
    }
  }
}
