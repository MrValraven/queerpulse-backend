import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { MagazineArticle } from './entities/magazine-article.entity';
import { MagazineAuthor } from './entities/magazine-author.entity';
import { MagazineIssue } from './entities/magazine-issue.entity';
import {
  ArticleListItem,
  ArticleResponse,
  AuthorResponse,
  IssueResponse,
  toArticleListItem,
  toArticleResponse,
  toAuthorResponse,
  toIssueResponse,
} from './magazine-response';

export interface ListArticlesInput {
  issue?: string;
  tag?: string;
  author?: string;
  page?: number;
}

/**
 * Read side of the magazine module: issues, articles, authors. Seed + read
 * only per the spec (§3 Tier 5 "magazine") — the one write endpoint (story
 * submissions) lives in `StorySubmissionsService`.
 */
@Injectable()
export class MagazineService {
  constructor(
    @InjectRepository(MagazineArticle)
    private readonly articles: Repository<MagazineArticle>,
    @InjectRepository(MagazineAuthor)
    private readonly authors: Repository<MagazineAuthor>,
    @InjectRepository(MagazineIssue)
    private readonly issues: Repository<MagazineIssue>,
  ) {}

  async listIssues(): Promise<IssueResponse[]> {
    const rows = await this.issues.find({ order: { number: 'DESC' } });
    return rows.map(toIssueResponse);
  }

  async getIssueByNumber(number: string): Promise<IssueResponse> {
    const issue = await this.issues.findOne({ where: { number } });
    if (!issue) {
      throw new NotFoundException('Issue not found');
    }
    return toIssueResponse(issue);
  }

  async listArticles(
    query: ListArticlesInput,
  ): Promise<Paginated<ArticleListItem>> {
    const page = normalizePage(query.page);
    const qb = this.articles.createQueryBuilder('article');

    if (query.issue) {
      qb.innerJoin(
        MagazineIssue,
        'issue',
        'issue.id = article.issue_id AND issue.number = :issueNumber',
        { issueNumber: query.issue },
      );
    }
    if (query.tag) {
      qb.andWhere(':tag = ANY(article.tags)', { tag: query.tag });
    }
    if (query.author) {
      qb.innerJoin(
        MagazineAuthor,
        'byline',
        'byline.id = article.author_id AND byline.slug = :authorSlug',
        { authorSlug: query.author },
      );
    }

    qb.orderBy('article.published_at', 'DESC', 'NULLS LAST').addOrderBy(
      'article.created_at',
      'DESC',
    );

    return paginate(qb, page, (rows) => this.toListItems(rows));
  }

  async getArticleBySlug(slug: string): Promise<ArticleResponse> {
    const article = await this.articles.findOne({ where: { slug } });
    if (!article) {
      throw new NotFoundException('Article not found');
    }
    const author = await this.loadAuthorOr404(article.authorId);
    const issueNumber = await this.issueNumberFor(article.issueId);
    return toArticleResponse(article, author, issueNumber);
  }

  async listAuthors(): Promise<AuthorResponse[]> {
    const rows = await this.authors.find({ order: { name: 'ASC' } });
    return rows.map(toAuthorResponse);
  }

  async getAuthorBySlug(slug: string): Promise<AuthorResponse> {
    const author = await this.authors.findOne({ where: { slug } });
    if (!author) {
      throw new NotFoundException('Author not found');
    }
    return toAuthorResponse(author);
  }

  // --- internals ---

  // One batched author lookup + one batched issue lookup per page, instead
  // of N+1 per row (mirrors `CommunitiesService.statsForMany`).
  private async toListItems(
    rows: MagazineArticle[],
  ): Promise<ArticleListItem[]> {
    if (!rows.length) return [];

    const authorIds = [...new Set(rows.map((a) => a.authorId))];
    const issueIds = [
      ...new Set(
        rows.map((a) => a.issueId).filter((id): id is string => id !== null),
      ),
    ];

    const [authorRows, issueRows] = await Promise.all([
      this.authors.find({ where: { id: In(authorIds) } }),
      issueIds.length
        ? this.issues.find({ where: { id: In(issueIds) } })
        : Promise.resolve([]),
    ]);
    const authorsById = new Map(authorRows.map((a) => [a.id, a]));
    const issueNumberById = new Map(issueRows.map((i) => [i.id, i.number]));

    return rows
      .map((article) => {
        const author = authorsById.get(article.authorId);
        if (!author) return null;
        const issueNumber = article.issueId
          ? (issueNumberById.get(article.issueId) ?? null)
          : null;
        return toArticleListItem(article, author, issueNumber);
      })
      .filter((item): item is ArticleListItem => item !== null);
  }

  private async loadAuthorOr404(authorId: string): Promise<MagazineAuthor> {
    const author = await this.authors.findOne({ where: { id: authorId } });
    if (!author) {
      // Data-integrity bug (FK should prevent this), not a legitimate empty
      // state — mirrors `CommunitiesService.memberRefFor`.
      throw new NotFoundException('Author not found');
    }
    return author;
  }

  private async issueNumberFor(issueId: string | null): Promise<string | null> {
    if (!issueId) return null;
    const issue = await this.issues.findOne({ where: { id: issueId } });
    return issue?.number ?? null;
  }
}
