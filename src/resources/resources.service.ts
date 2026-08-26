import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import {
  DEFAULT_LIST_LIMIT,
  normalizePage,
  paginate,
  Paginated,
} from '../common/pagination';
import { GlossaryTerm } from './entities/glossary-term.entity';
import { Resource } from './entities/resource.entity';
import {
  GlossaryTermResponseDTO,
  ResourceIndexEntryDTO,
  ResourceResponseDTO,
  ResourceSearchRow,
  toGlossaryTermResponse,
  toResourceIndexEntry,
  toResourceResponse,
  toResourceSearchRow,
} from './resource-response';

export interface ListResourcesInput {
  category?: string;
  page?: number;
}

@Injectable()
export class ResourcesService {
  constructor(
    @InjectRepository(Resource)
    private readonly resources: Repository<Resource>,
    @InjectRepository(GlossaryTerm)
    private readonly glossaryTerms: Repository<GlossaryTerm>,
  ) {}

  // Public directory: published resources only (`publishedAt` set and not in
  // the future), optionally filtered by category. Mirrors
  // `PartnersService.list`'s approved-only + optional-filter shape.
  async list(
    query: ListResourcesInput,
  ): Promise<Paginated<ResourceResponseDTO>> {
    const page = normalizePage(query.page);
    const qb = this.resources
      .createQueryBuilder('r')
      .where('r.publishedAt IS NOT NULL')
      .andWhere('r.publishedAt <= :now', { now: new Date() })
      .orderBy('r.publishedAt', 'DESC');

    if (query.category) {
      qb.andWhere('r.category = :category', { category: query.category });
    }

    return paginate(qb, page, (rows) => rows.map(toResourceResponse));
  }

  /**
   * Every published guide in one unpaginated, compact response — what the
   * public guide index (CON-10) renders as a category-grouped list.
   *
   * Seventeen guides had no `routes.*` reference anywhere and were reachable
   * only by typing the URL; the ones worst affected served the least-served
   * audiences. A reader cannot browse to a page nobody links to, so the index
   * links every one of them, and it needs the whole set at once rather than
   * page one of the library.
   */
  async listIndex(): Promise<ResourceIndexEntryDTO[]> {
    const rows = await this.resources
      .createQueryBuilder('r')
      .where('r.publishedAt IS NOT NULL')
      .andWhere('r.publishedAt <= :now', { now: new Date() })
      .orderBy('r.category', 'ASC')
      .addOrderBy('r.title', 'ASC')
      .getMany();
    return rows.map(toResourceIndexEntry);
  }

  // 404s anything unpublished/future-dated — hides its existence from the
  // public rather than surfacing a distinct "not visible yet" response
  // (mirrors `PartnersService.getBySlug`'s treatment of non-approved
  // partners).
  async getBySlug(slug: string): Promise<ResourceResponseDTO> {
    const resource = await this.resources.findOne({ where: { slug } });
    if (
      !resource ||
      !resource.publishedAt ||
      resource.publishedAt.getTime() > Date.now()
    ) {
      throw new NotFoundException('Resource not found');
    }
    return toResourceResponse(resource);
  }

  // Cross-entity global search (SearchService) — published resources only
  // (same gate as `list`), ILIKE over title / description. Body/meta stay out.
  async searchByText(
    term: string,
    limit: number,
  ): Promise<ResourceSearchRow[]> {
    const pattern = `%${escapeLikeTerm(term)}%`;
    const rows = await this.resources
      .createQueryBuilder('r')
      .where('r.publishedAt IS NOT NULL')
      .andWhere('r.publishedAt <= :now', { now: new Date() })
      .andWhere('(r.title ILIKE :pattern OR r.description ILIKE :pattern)', {
        pattern,
      })
      .orderBy('r.publishedAt', 'DESC')
      .take(limit)
      .getMany();
    return rows.map(toResourceSearchRow);
  }

  // Glossary is small and unpaginated by design (the FE renders every
  // matching term client-side, grouped by letter) — a plain array, not a
  // `Paginated<T>` envelope.
  async listGlossary(category?: string): Promise<GlossaryTermResponseDTO[]> {
    const rows = await this.glossaryTerms.find({
      where: category ? { category } : {},
      order: { term: 'ASC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return rows.map(toGlossaryTermResponse);
  }

  async getGlossaryBySlug(slug: string): Promise<GlossaryTermResponseDTO> {
    const term = await this.glossaryTerms.findOne({ where: { slug } });
    if (!term) {
      throw new NotFoundException('Glossary term not found');
    }
    return toGlossaryTermResponse(term);
  }
}
