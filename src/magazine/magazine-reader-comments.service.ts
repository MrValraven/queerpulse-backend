import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { MemberLookup } from '../common/member-ref';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { Profile } from '../users/entities/profile.entity';
import { MagazineArticle } from './entities/magazine-article.entity';
import { MagazineReaderComment } from './entities/magazine-reader-comment.entity';
import {
  ReaderCommentResponse,
  toReaderCommentResponse,
} from './magazine-reader-comment-response';

// Matches `ReportSubjectType.MagazineComment`'s value — kept as a plain
// string here (not an import from `reports`) to avoid a magazine -> reports
// dependency arrow; `ContentModerationService`'s API is subject-type-agnostic
// (`string`), same as `ForumPostsService.SUBJECT_TYPES`.
const SUBJECT_TYPE = 'magazine_comment';

@Injectable()
export class MagazineReaderCommentsService {
  constructor(
    @InjectRepository(MagazineReaderComment)
    private readonly comments: Repository<MagazineReaderComment>,
    @InjectRepository(MagazineArticle)
    private readonly articles: Repository<MagazineArticle>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly contentModeration: ContentModerationService,
  ) {}

  // GET /magazine/articles/:slug/comments — top-level comments (newest
  // first), each with its flat replies (oldest first) batch-loaded in one
  // extra query. Ordering mirrors the editorial NotesRail's documented
  // convention (`useArticleComments.ts`: "top-level newest-first, replies
  // oldest-first") so both comment surfaces read consistently.
  async list(
    slug: string,
    user: CurrentUserData,
    page?: number,
  ): Promise<Paginated<ReaderCommentResponse>> {
    const article = await this.loadPublishedArticleOrThrow(slug);
    const normalizedPage = normalizePage(page);

    const qb = this.comments
      .createQueryBuilder('c')
      .where('c.articleId = :articleId', { articleId: article.id })
      .andWhere('c.parentId IS NULL')
      .orderBy('c.createdAt', 'DESC')
      .addOrderBy('c.id', 'DESC');
    this.contentModeration.excludeHidden(qb, [SUBJECT_TYPE], '"c"."id"');

    return paginate(qb, normalizedPage, (rows) =>
      this.toResponsesWithReplies(rows, user.userId),
    );
  }

  // POST /magazine/articles/:slug/comments — a top-level comment, or a reply
  // when `parentId` is given. One level deep only: replying to a reply is
  // rejected, matching `MagazineArticleComment`'s documented threading
  // contract and `ForumPostsService.loadReplyParentOr400`'s precedent.
  async create(
    slug: string,
    user: CurrentUserData,
    body: string,
    parentId?: string,
  ): Promise<ReaderCommentResponse> {
    const article = await this.loadPublishedArticleOrThrow(slug);
    const parent = parentId
      ? await this.loadReplyParentOrThrow(parentId, article.id)
      : null;

    const saved = await this.comments.save(
      this.comments.create({
        articleId: article.id,
        parentId: parent?.id ?? null,
        authorId: user.userId,
        body,
      }),
    );

    const authors = await new MemberLookup(this.profiles).byUserIds([
      user.userId,
    ]);
    return toReaderCommentResponse(
      saved,
      authors.get(user.userId) ?? null,
      user.userId,
      { hidden: false, removed: false },
    );
  }

  // PATCH /magazine/comments/:id — author-only body edit.
  async update(
    id: string,
    user: CurrentUserData,
    body: string,
  ): Promise<ReaderCommentResponse> {
    const comment = await this.loadCommentOrThrow(id);
    if (comment.deletedAt) {
      throw new NotFoundException('Comment not found');
    }
    if (comment.authorId !== user.userId) {
      throw new ForbiddenException('Only the author can edit this comment');
    }
    comment.body = body;
    comment.editedAt = new Date();
    await this.comments.save(comment);
    return this.mapOne(comment, user.userId);
  }

  // DELETE /magazine/comments/:id — author-only soft tombstone. The row
  // survives (thread integrity for any existing replies); the response
  // blanks `body`/author via `toReaderCommentResponse`, same policy as
  // `ForumPost.deletedAt`.
  async remove(
    id: string,
    user: CurrentUserData,
  ): Promise<ReaderCommentResponse> {
    const comment = await this.loadCommentOrThrow(id);
    if (comment.authorId !== user.userId) {
      throw new ForbiddenException('Only the author can delete this comment');
    }
    if (!comment.deletedAt) {
      comment.deletedAt = new Date();
      await this.comments.save(comment);
    }
    return this.mapOne(comment, user.userId);
  }

  // --- internals ---

  private async mapOne(
    comment: MagazineReaderComment,
    viewerId: string,
  ): Promise<ReaderCommentResponse> {
    const [authors, moderation] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds([comment.authorId]),
      this.contentModeration.stateFor(SUBJECT_TYPE, comment.id),
    ]);
    return toReaderCommentResponse(
      comment,
      authors.get(comment.authorId) ?? null,
      viewerId,
      moderation,
    );
  }

  private async loadCommentOrThrow(id: string): Promise<MagazineReaderComment> {
    const comment = await this.comments.findOne({ where: { id } });
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }
    return comment;
  }

  private async loadReplyParentOrThrow(
    parentId: string,
    articleId: string,
  ): Promise<MagazineReaderComment> {
    const parent = await this.loadCommentOrThrow(parentId);
    if (parent.articleId !== articleId) {
      throw new BadRequestException(
        'Parent comment does not belong to this article',
      );
    }
    if (parent.parentId !== null) {
      throw new BadRequestException('Cannot reply to a reply');
    }
    if (parent.deletedAt) {
      throw new BadRequestException('Cannot reply to a deleted comment');
    }
    return parent;
  }

  private async loadPublishedArticleOrThrow(
    slug: string,
  ): Promise<MagazineArticle> {
    const article = await this.articles.findOne({ where: { slug } });
    if (!article || !article.publishedAt || article.publishedAt > new Date()) {
      throw new NotFoundException('Article not found');
    }
    return article;
  }

  // Batched mapping for a page of top-level comments: one query for every
  // reply across the whole page (not per-row), one `IN`-style lookup each for
  // authors and moderation state — mirrors `ForumPostsService.toPostResponses`.
  private async toResponsesWithReplies(
    rows: MagazineReaderComment[],
    viewerId: string,
  ): Promise<ReaderCommentResponse[]> {
    if (!rows.length) return [];
    const topLevelIds = rows.map((row) => row.id);

    const replyRows = topLevelIds.length
      ? await this.comments
          .createQueryBuilder('c')
          .where('c.parentId IN (:...topLevelIds)', { topLevelIds })
          .orderBy('c.createdAt', 'ASC')
          .getMany()
      : [];

    const allRows = [...rows, ...replyRows];
    const authorIds = [...new Set(allRows.map((row) => row.authorId))];
    const allIds = allRows.map((row) => row.id);

    const [authors, moderation] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds(authorIds),
      this.contentModeration.statesFor(SUBJECT_TYPE, allIds),
    ]);

    const repliesByParent = new Map<string, MagazineReaderComment[]>();
    for (const reply of replyRows) {
      const list = repliesByParent.get(reply.parentId!) ?? [];
      list.push(reply);
      repliesByParent.set(reply.parentId!, list);
    }

    const mapRow = (row: MagazineReaderComment): ReaderCommentResponse =>
      toReaderCommentResponse(
        row,
        authors.get(row.authorId) ?? null,
        viewerId,
        moderation.get(row.id) ?? { hidden: false, removed: false },
      );

    return rows.map((row) => ({
      ...mapRow(row),
      replies: (repliesByParent.get(row.id) ?? []).map(mapRow),
    }));
  }
}
