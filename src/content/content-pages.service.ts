import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { PageResponse, toPageResponse } from './content-page-response';
import { ContentPage, ContentSection } from './entities/content-page.entity';

@Injectable()
export class ContentPagesService {
  constructor(
    @InjectRepository(ContentPage)
    private readonly pages: Repository<ContentPage>,
  ) {}

  /**
   * Lists a section's published pages, newest-published first. Unpublished
   * (`publishedAt: null`) or future-dated pages never appear — `find`'s
   * `LessThanOrEqual` comparison against a nullable column excludes `NULL`
   * rows for free (SQL's `NULL <= x` is unknown, not true).
   */
  async listBySection(section: ContentSection): Promise<PageResponse[]> {
    const rows = await this.pages.find({
      where: { section, publishedAt: LessThanOrEqual(new Date()) },
      order: { publishedAt: 'DESC' },
    });
    return rows.map(toPageResponse);
  }

  /** 404s an unknown slug and an unpublished/future-dated one alike. */
  async getBySlug(
    section: ContentSection,
    slug: string,
  ): Promise<PageResponse> {
    const page = await this.pages.findOne({ where: { section, slug } });
    if (!page || !page.publishedAt || page.publishedAt > new Date()) {
      throw new NotFoundException('Page not found');
    }
    return toPageResponse(page);
  }
}
