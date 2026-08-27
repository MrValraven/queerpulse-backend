import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
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

  /**
   * The public visibility gate for a guide, in one place because four public
   * reads share it and a fifth would otherwise be written without it.
   *
   * Published is necessary but not sufficient. A guide nobody has read end to
   * end is not something to put in front of someone looking for a crisis
   * line, a clinic's hours or a legal deadline, so `last_reviewed_on` has to
   * be stamped too. `POST /admin/resources/:id/review` is the endpoint that
   * exists to stamp it, held apart from editing prose so a typo fix cannot
   * quietly reset a crisis guide's freshness clock (the admin create/update
   * DTOs can also carry the date, for an editor correcting a mis-stamped
   * one). Either way it takes a staff account, so "visible" means a named
   * person took responsibility for the words.
   *
   * A LAPSED review (`reviewDueOn` in the past) does NOT hide the guide. A
   * stale date the reader footer prints honestly is a far smaller harm than a
   * health guide disappearing because a calendar date passed.
   */
  private applyPublicGate(
    qb: SelectQueryBuilder<Resource>,
  ): SelectQueryBuilder<Resource> {
    return qb
      .where('r.publishedAt IS NOT NULL')
      .andWhere('r.publishedAt <= :now', { now: new Date() })
      .andWhere('r.lastReviewedOn IS NOT NULL');
  }

  /** The row-level twin of `applyPublicGate`, for the single-row reads that
   *  go through `findOne` rather than a query builder. */
  private isPubliclyVisible(resource: Resource | null): resource is Resource {
    return Boolean(
      resource &&
      resource.publishedAt &&
      resource.publishedAt.getTime() <= Date.now() &&
      resource.lastReviewedOn,
    );
  }

  // Public directory: published AND editorially reviewed resources only (see
  // `applyPublicGate`), optionally filtered by category. Mirrors
  // `PartnersService.list`'s approved-only + optional-filter shape.
  async list(
    query: ListResourcesInput,
  ): Promise<Paginated<ResourceResponseDTO>> {
    const page = normalizePage(query.page);
    const qb = this.applyPublicGate(
      this.resources.createQueryBuilder('r'),
    ).orderBy('r.publishedAt', 'DESC');

    if (query.category) {
      qb.andWhere('r.category = :category', { category: query.category });
    }

    return paginate(qb, page, (rows) => rows.map(toResourceResponse));
  }

  /**
   * Every publicly visible guide in one unpaginated, compact response — what
   * the public guide index (CON-10) renders as a category-grouped list.
   * "Publicly visible" is published AND editorially reviewed; see
   * `applyPublicGate`.
   *
   * Seventeen guides had no `routes.*` reference anywhere and were reachable
   * only by typing the URL; the ones worst affected served the least-served
   * audiences. A reader cannot browse to a page nobody links to, so the index
   * links every one of them, and it needs the whole set at once rather than
   * page one of the library.
   */
  async listIndex(): Promise<ResourceIndexEntryDTO[]> {
    const rows = await this.applyPublicGate(
      this.resources.createQueryBuilder('r'),
    )
      .orderBy('r.category', 'ASC')
      .addOrderBy('r.title', 'ASC')
      .getMany();
    return rows.map(toResourceIndexEntry);
  }

  // 404s anything unpublished, future-dated or never editorially reviewed —
  // hides its existence from the public rather than surfacing a distinct
  // "not visible yet" response (mirrors `PartnersService.getBySlug`'s
  // treatment of non-approved partners).
  //
  // The frontend's `ManagedGuide` reads a 404 here as "this guide is not
  // managed in the database yet" and renders its hardcoded page instead, so
  // an unreviewed guide that still has a hardcoded page degrades to that page
  // without its review footer, rather than to a dead end.
  async getBySlug(slug: string): Promise<ResourceResponseDTO> {
    const resource = await this.resources.findOne({ where: { slug } });
    if (!this.isPubliclyVisible(resource)) {
      throw new NotFoundException('Resource not found');
    }
    return toResourceResponse(resource);
  }

  // Cross-entity global search (SearchService) — published and reviewed
  // resources only (same gate as `list`), ILIKE over title / description.
  // Body/meta stay out.
  async searchByText(
    term: string,
    limit: number,
  ): Promise<ResourceSearchRow[]> {
    const pattern = `%${escapeLikeTerm(term)}%`;
    const rows = await this.applyPublicGate(
      this.resources.createQueryBuilder('r'),
    )
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
