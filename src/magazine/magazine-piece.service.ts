import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Not, Repository } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { normalizePage, Paginated } from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { CreateArticleCommentDto } from './dto/create-article-comment.dto';
import { CreateCorrectionDto } from './dto/create-correction.dto';
import { CreateLetterDto } from './dto/create-letter.dto';
import { AssignIssueDto } from './dto/assign-issue.dto';
import { CreateIssueDto } from './dto/create-issue.dto';
import { CreatePieceDto } from './dto/create-piece.dto';
import { CreatePieceMessageDto } from './dto/create-piece-message.dto';
import { CreatePitchDto } from './dto/create-pitch.dto';
import { FileDraftDto } from './dto/file-draft.dto';
import {
  ListPiecesQuery,
  PIECE_PAGE_SIZE_DEFAULT,
  PIECE_PAGE_SIZE_MAX,
  SavedViewId,
} from './dto/list-pieces.query';
import { PublishArticleDto } from './dto/publish-article.dto';
import { PublishPieceDto } from './dto/publish-piece.dto';
import { ReplyArticleCommentDto } from './dto/reply-article-comment.dto';
import { ResolveArticleCommentDto } from './dto/resolve-article-comment.dto';
import { SubmitPitchDto } from './dto/submit-pitch.dto';
import { TriagePitchDto } from './dto/triage-pitch.dto';
import { UpdateArticleDto } from './dto/update-article.dto';
import { UpdateBylineDto } from './dto/update-byline.dto';
import { UpdateCoverDto } from './dto/update-cover.dto';
import { UpdateIssueScheduleDto } from './dto/update-issue-schedule.dto';
import { UpdateSubmissionDeadlineDto } from './dto/update-submission-deadline.dto';
import { UpdateDigestDto } from './dto/update-digest.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { UpdatePieceDto } from './dto/update-piece.dto';
import { UpdateRunOrderDto } from './dto/update-run-order.dto';
import {
  ArticleBlock,
  MagazineArticle,
} from './entities/magazine-article.entity';
import { MagazineArticleComment } from './entities/magazine-article-comment.entity';
import { MagazineArticleVersion } from './entities/magazine-article-version.entity';
import { MagazineAuthor } from './entities/magazine-author.entity';
import { MagazineCorrection } from './entities/magazine-correction.entity';
import { MagazineDeck } from './entities/magazine-deck.entity';
import {
  IssueLastShip,
  IssueRunOrderItem,
  IssueShipHeldPiece,
  MagazineIssue,
} from './entities/magazine-issue.entity';
import { MagazineLetter } from './entities/magazine-letter.entity';
import { MagazinePayment } from './entities/magazine-payment.entity';
import { DEFAULT_MAGAZINE_CURRENCY } from './magazine-money';
import { MagazinePieceEvent } from './entities/magazine-piece-event.entity';
import { MagazinePieceMessage } from './entities/magazine-piece-message.entity';
import { MagazinePiece, PieceStage } from './entities/magazine-piece.entity';
import { MagazinePitch } from './entities/magazine-pitch.entity';
import { MagazineSection } from './entities/magazine-section.entity';
import {
  ArchiveEntryResponse,
  ArticleDraftResponse,
  articlePublishBlockers,
  computePublishGate,
  countArticleWords,
  deckPublishBlockers,
  PieceLinkedContent,
  toPiecePublicHref,
  CorrectionResponse,
  CurrentIssueSummary,
  DeskSummary,
  IssueProductionResponse,
  IssueSummaryResponse,
  LetterResponse,
  MagazineEditorResponse,
  PaymentResponse,
  PieceListItem,
  PieceRecord,
  PieceRecordFull,
  PitchResponse,
  toArchiveEntryFromArticle,
  toArchiveEntryFromDeck,
  toArticleDraftResponse,
  toCorrectionResponse,
  toDeskSummary,
  toIssueProduction,
  toLetterResponse,
  toActorDisplayName,
  toMagazineEditor,
  toPaymentResponse,
  toPieceListItem,
  toPieceRecordFull,
  toPieceRecordSummary,
  toPitchResponse,
  toPlainText,
} from './magazine-piece-response';
import {
  ArticleCommentResponse,
  FORMER_MEMBER_COMMENT_AUTHOR_LABEL,
  toArticleCommentResponse,
  toArticleCommentTree,
  UNRESOLVED_COMMENT_AUTHOR_LABEL,
} from './magazine-article-comment-response';
import {
  ArticleVersionDetailResponse,
  ArticleVersionSummaryResponse,
  toArticleVersionDetail,
  toArticleVersionSummary,
} from './magazine-article-version-response';
import {
  PieceMessageResponse,
  toPieceMessage,
} from './magazine-piece-message-response';
import {
  toWriterAssignment,
  toWriterDraft,
  toWriterPayment,
  toWriterPitch,
  WriterAssignmentResponse,
  WriterDraftResponse,
  WriterPaymentResponse,
  WriterPitchResponse,
} from './magazine-writer-response';
import { validateArticleBlocks } from './magazine-article-blocks.validation';
import { sanitizeArticleBlocks } from './article-html-sanitizer';
import { assertNoForeignUploadIntroduced } from '../storage/assert-no-foreign-upload';
import {
  briefWithFiledWords,
  validatePieceBrief,
  validatePieceCare,
} from './piece-jsonb.validation';
import { mapDeckSlidesToArticleBlocks } from './deck-to-article.mapper';

/** Today as a `date`-column-shaped ISO string (`YYYY-MM-DD`), UTC. */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The magazine's editorial clock. Every issue is made in Lisbon and every
 * date the desk types (`MagazineIssue.publishedOn`, a bare `YYYY-MM-DD`) is
 * meant in Lisbon time, so the hour a scheduled issue goes live has to be
 * resolved in this zone rather than in UTC.
 */
const MAGAZINE_TIMEZONE = 'Europe/Lisbon';

/**
 * The hour a scheduled issue goes live, in `MAGAZINE_TIMEZONE`. The ship copy
 * has always promised "everything publishes together at 09:00 on the issue
 * date" (PRD-126); this is that promise as a number.
 */
const ISSUE_PUBLISH_HOUR = 9;

/**
 * How far `instant` is ahead of UTC in `timeZone`, in milliseconds.
 *
 * Renders the instant in the target zone and reads the wall-clock fields back
 * as if they were UTC: the difference IS the offset. Same technique (and same
 * reason) as `localMinuteOfDay` in `notification-quiet-hours.ts` — the zone
 * database inside `Intl` already knows about DST, so this stays correct across
 * the changeover without a date library.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const partValue = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const wallClockAsUtc = Date.UTC(
    partValue('year'),
    partValue('month') - 1,
    partValue('day'),
    // `hour12: false` renders midnight as `24` in some ICU versions; fold it
    // back, exactly as `localMinuteOfDay` does.
    partValue('hour') % 24,
    partValue('minute'),
    partValue('second'),
  );
  return wallClockAsUtc - instant.getTime();
}

/**
 * Whether a `publishedAt` means "live to readers RIGHT NOW". A `null` is a
 * draft and a FUTURE instant is a schedule; both are invisible to every public
 * read path, so neither counts as published.
 */
function isLiveInstant(publishedAt: Date | null): boolean {
  return publishedAt !== null && publishedAt.getTime() <= Date.now();
}

/**
 * Today as a `YYYY-MM-DD` calendar date in `MAGAZINE_TIMEZONE`, so an issue
 * date typed by the desk is compared against the desk's own day. `en-CA`
 * renders exactly `YYYY-MM-DD`, which is also how `MagazineIssue.publishedOn`
 * comes back off its Postgres `date` column, so the two compare as strings.
 */
function magazineTodayIsoDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MAGAZINE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * PRD-126 — when a ship's pieces should actually go live.
 *
 * Ship copy promises the issue lands together at 09:00 on the issue date, but
 * `shipIssue` used to publish at the instant of the click: an editor who
 * shipped on Friday for a Monday issue put every article live on Friday while
 * the issue page itself stayed hidden until Monday.
 *
 * So: an issue dated today or in the past goes live NOW (the desk is catching
 * up, and holding it back would be a surprise), and a FUTURE issue date
 * resolves to 09:00 Europe/Lisbon on that date. A future `publishedAt` already
 * hides an article or deck from every public read path, so scheduling costs
 * nothing beyond this arithmetic: no cron, no second column.
 *
 * The offset is measured twice because 09:00 can sit on the far side of a DST
 * changeover from the first guess. Lisbon changes at 01:00, so one correction
 * pass is always enough.
 */
function resolveIssuePublishInstant(
  publishedOn: string,
  shippedAt: Date,
): Date {
  // Compared as calendar dates in the magazine's own zone, never as instants:
  // an issue dated TODAY ships now even when the click lands at 07:00, because
  // an editor shipping today's issue means today, and holding it two hours for
  // a clock they never chose would be the surprise this fix exists to remove.
  if (publishedOn <= magazineTodayIsoDate(shippedAt)) {
    return shippedAt;
  }

  const wallClockAsUtc = new Date(
    `${publishedOn}T${String(ISSUE_PUBLISH_HOUR).padStart(2, '0')}:00:00Z`,
  );
  if (Number.isNaN(wallClockAsUtc.getTime())) {
    return shippedAt;
  }

  const firstGuessOffsetMs = zoneOffsetMs(wallClockAsUtc, MAGAZINE_TIMEZONE);
  let publishAt = new Date(wallClockAsUtc.getTime() - firstGuessOffsetMs);
  const settledOffsetMs = zoneOffsetMs(publishAt, MAGAZINE_TIMEZONE);
  if (settledOffsetMs !== firstGuessOffsetMs) {
    publishAt = new Date(wallClockAsUtc.getTime() - settledOffsetMs);
  }

  // A future issue date's 09:00 is always ahead of the click, so this is a
  // belt-and-braces floor: a ship may bring a piece forward, never backward.
  return publishAt.getTime() > shippedAt.getTime() ? publishAt : shippedAt;
}

/**
 * Flat per-editor concurrent-piece cap for the sidebar "editor load" tile
 * (matches the design's `EDITOR_CAP`). Phase 1 has no per-editor
 * configuration, so this is a constant rather than a column.
 */
const EDITOR_CAP = 7;

/** How many recent audit events `deskSummary()` surfaces in the activity feed. */
const RECENT_ACTIVITY_LIMIT = 20;

/**
 * How many rows `searchArchive` returns, across articles and decks combined
 * (Magazine Desk Phase 7, Task B1) — matches the ArchiveTab's page size.
 */
const ARCHIVE_SEARCH_LIMIT = 20;

/**
 * How many members one `createForRecipients` call announces a shipped issue to
 * (CON-05). Matches the community post fan-out's chunk size: each call is
 * already batched internally into one multi-row INSERT plus two filter
 * queries, and chunking keeps a membership-wide announcement off a single
 * enormous statement.
 */
const ISSUE_ANNOUNCE_CHUNK_SIZE = 500;

/**
 * The human actors in an event trail, ready for `resolveActorDisplayNames`.
 * A `null` `actorId` is the entity's documented "System" sentinel (see
 * `MagazinePieceEvent.actorId`), which resolves to a label without a lookup.
 */
function auditActorIds(events: MagazinePieceEvent[]): string[] {
  return events
    .map((event) => event.actorId)
    .filter((actorId): actorId is string => actorId !== null);
}

/**
 * Saved-view predicates as SQL, ANDed into the `listPieces` query builder.
 *
 * These used to be JS predicates applied to `getMany()`'s full result set,
 * which is why the endpoint could not be paginated (CNT-09): filtering after
 * the fetch means the LIMIT would have been applied to the wrong row set.
 * Expressed in SQL they narrow BEFORE the limit, so page N of a saved view is
 * correct and `total` counts the view, not the table.
 *
 * Each expression mirrors the frontend `VIEW_TEST` map (spec §4.1 / plan
 * Task 4) and the `deriveLate`/`deriveWaitingOn` helpers in
 * `magazine-piece-response.ts` term for term, so a saved view means the same
 * thing whether it's evaluated client-side (demo mode) or server-side.
 *
 * `v-late` is the only non-trivial one:
 *   deriveLate         -> due_on IS NOT NULL AND stage <> 'ready'
 *                         AND due_on < today (UTC)
 *   waitingOn='writer' -> stage IN ('commissioned','drafting')
 *                         AND writer_id IS NOT NULL
 * The date compare is pinned to UTC (`(now() AT TIME ZONE 'UTC')::date`)
 * rather than `CURRENT_DATE`, which would follow the DB session's timezone
 * and could disagree with `deriveLate`'s `Date.UTC` arithmetic by a day.
 */
const SAVED_VIEW_SQL: Record<SavedViewId, string> = {
  // The `NOT IN ('ready', 'published')` half mirrors `deriveLate`, which
  // exempts both terminal stages: a piece that is already live cannot be late
  // (PRD-120).
  'v-late':
    "((piece.dueOn IS NOT NULL AND piece.stage NOT IN ('ready', 'published') " +
    "AND piece.dueOn < (now() AT TIME ZONE 'UTC')::date) " +
    "OR (piece.stage IN ('commissioned', 'drafting') " +
    'AND piece.writerId IS NOT NULL))',
  // Real art state (Magazine Desk Phase 7, Task A3): a piece still needs
  // art work when nothing has been requested yet, or a brief has gone out
  // but nothing has come in ('in') or been marked not-applicable ('na').
  'v-art': "piece.art IN ('none', 'brief')",
  'v-sens': "piece.stage IN ('sensitivity_read', 'edit')",
  // `published` belongs here too: a piece going live is the moment its writer
  // is most owed a payment, and dropping it out of the money view the instant
  // it shipped would be exactly the wrong time to lose sight of it (PRD-120).
  'v-pay': "piece.stage IN ('layout', 'ready', 'published')",
};

/**
 * The Desk's workflow spine (spec §4.1 / plan Task 4): pieces, pitches, and
 * the desk-wide summary roll-up. Every meaningful state change writes a
 * `MagazinePieceEvent` via `recordEvent` so `PieceRecord.audit` and
 * `DeskSummary.activity` have something to show. Pitch→piece commission runs
 * inside a transaction so the pitch's `commissioned` status and the new
 * piece are never observed out of sync.
 */
@Injectable()
export class MagazinePieceService {
  private readonly logger = new Logger(MagazinePieceService.name);

  constructor(
    @InjectRepository(MagazinePiece)
    private readonly pieces: Repository<MagazinePiece>,
    @InjectRepository(MagazinePitch)
    private readonly pitches: Repository<MagazinePitch>,
    @InjectRepository(MagazinePieceEvent)
    private readonly pieceEvents: Repository<MagazinePieceEvent>,
    @InjectRepository(MagazinePieceMessage)
    private readonly pieceMessages: Repository<MagazinePieceMessage>,
    @InjectRepository(MagazineSection)
    private readonly sections: Repository<MagazineSection>,
    @InjectRepository(MagazinePayment)
    private readonly payments: Repository<MagazinePayment>,
    @InjectRepository(MagazineLetter)
    private readonly letters: Repository<MagazineLetter>,
    @InjectRepository(MagazineCorrection)
    private readonly corrections: Repository<MagazineCorrection>,
    @InjectRepository(MagazineArticle)
    private readonly articles: Repository<MagazineArticle>,
    @InjectRepository(MagazineArticleComment)
    private readonly articleComments: Repository<MagazineArticleComment>,
    @InjectRepository(MagazineArticleVersion)
    private readonly articleVersions: Repository<MagazineArticleVersion>,
    @InjectRepository(MagazineAuthor)
    private readonly authors: Repository<MagazineAuthor>,
    @InjectRepository(MagazineDeck)
    private readonly decks: Repository<MagazineDeck>,
    @InjectRepository(MagazineIssue)
    private readonly issues: Repository<MagazineIssue>,
    @InjectRepository(UserStaffRole)
    private readonly staffRoles: Repository<UserStaffRole>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * The desk board's main list — ALWAYS paginated (CNT-09).
   *
   * This previously ran `getMany()` with no limit and then filtered the saved
   * view in JS, so every board load pulled the whole `magazine_piece` table
   * including its `brief`/`care` jsonb. Both halves are fixed together: the
   * saved views moved into SQL (`SAVED_VIEW_SQL`) so they narrow before the
   * limit, and the result is the shared `Paginated` envelope.
   *
   * BREAKING for callers: the response is now
   * `{ items, total, page, pageSize }`, not a bare array. `total` is the count
   * of rows matching every filter INCLUDING the saved view, so a client can
   * page a view correctly.
   */
  async listPieces(query: ListPiecesQuery): Promise<Paginated<PieceListItem>> {
    const queryBuilder = this.pieces.createQueryBuilder('piece');

    if (query.format) {
      queryBuilder.andWhere('piece.format = :format', {
        format: query.format,
      });
    }
    if (query.editor) {
      queryBuilder.andWhere('piece.editorId = :editorId', {
        editorId: query.editor,
      });
    }
    if (query.stage) {
      queryBuilder.andWhere('piece.stage = :stage', { stage: query.stage });
    }
    if (query.section) {
      queryBuilder.andWhere('piece.section = :section', {
        section: query.section,
      });
    }
    if (query.issue) {
      queryBuilder.andWhere('piece.issueId = :issueId', {
        issueId: query.issue,
      });
    }
    if (query.q) {
      const pattern = `%${escapeLikeTerm(query.q)}%`;
      queryBuilder.andWhere(
        '(piece.title ILIKE :pattern OR piece.byline ILIKE :pattern OR piece.section ILIKE :pattern)',
        { pattern },
      );
    }

    if (query.savedView) {
      queryBuilder.andWhere(SAVED_VIEW_SQL[query.savedView]);
    }

    // `createdAt` is not unique, so it alone leaves rows that share a
    // timestamp free to swap between pages. `id` breaks the tie so the sort is
    // total and offset pagination cannot duplicate or skip a piece.
    queryBuilder
      .orderBy('piece.createdAt', 'DESC')
      .addOrderBy('piece.id', 'DESC');

    const page = normalizePage(query.page);
    const pageSize = Math.min(
      query.pageSize && query.pageSize > 0
        ? query.pageSize
        : PIECE_PAGE_SIZE_DEFAULT,
      PIECE_PAGE_SIZE_MAX,
    );

    // `offset`/`limit` rather than `skip`/`take`: there is no join here, so the
    // DISTINCT-subquery pass `skip`/`take` adds buys nothing (and is the shape
    // that breaks on joined-alias ORDER BY elsewhere in this codebase).
    const [rows, total] = await queryBuilder
      .offset((page - 1) * pageSize)
      .limit(pageSize)
      .getManyAndCount();

    return {
      items: rows.map(toPieceListItem),
      total,
      page,
      pageSize,
    };
  }

  async getPieceById(id: string): Promise<PieceRecord> {
    const piece = await this.loadPieceOr404(id);
    const events = await this.eventsFor(id);
    return this.pieceRecordFor(piece, events);
  }

  /**
   * `toPieceRecordSummary` with the audit trail's actor names resolved first
   * — the History tab renders names, never ids. One batched lookup for the
   * whole trail (`resolveActorDisplayNames`), never one per event.
   */
  private async pieceRecordFor(
    piece: MagazinePiece,
    events: MagazinePieceEvent[],
  ): Promise<PieceRecord> {
    const [actorNameById, content] = await Promise.all([
      this.resolveActorDisplayNames(auditActorIds(events)),
      this.loadPieceContent(piece),
    ]);
    return toPieceRecordSummary(piece, events, actorNameById, content);
  }

  /**
   * The `MagazineArticle` or `MagazineDeck` a piece is linked to, narrowed to
   * the slug + `publishedAt` the record projection needs (PRD-120). `null`
   * when the piece has no content row yet, which is the normal state of a
   * freshly commissioned piece: the article is created lazily the first time
   * someone opens the editor.
   *
   * Loaded here rather than passed in by every caller so adding "is this
   * live?" to the piece record did not change `pieceRecordFor`'s signature,
   * which four call sites across this service share.
   */
  private async loadPieceContent(
    piece: MagazinePiece,
  ): Promise<PieceLinkedContent | null> {
    if (piece.format === 'deck') {
      if (piece.deckId === null) {
        return null;
      }
      return this.decks.findOne({
        where: { id: piece.deckId },
        select: { slug: true, publishedAt: true },
      });
    }
    if (piece.articleId === null) {
      return null;
    }
    return this.articles.findOne({
      where: { id: piece.articleId },
      select: { slug: true, publishedAt: true },
    });
  }

  /**
   * Full piece record for `PieceRecordPage` (spec §7.2, Task 4): the summary
   * plus the 1:1 payment row (may not exist yet), the letters/corrections
   * lists, and the derived publish gate.
   */
  async getPieceRecordFull(id: string): Promise<PieceRecordFull> {
    const piece = await this.loadPieceOr404(id);
    const [events, payment, letters, corrections, content] = await Promise.all([
      this.eventsFor(id),
      this.payments.findOne({ where: { pieceId: id } }),
      this.lettersFor(id),
      this.correctionsFor(id),
      this.loadPieceContent(piece),
    ]);
    const actorNameById = await this.resolveActorDisplayNames(
      auditActorIds(events),
    );
    return toPieceRecordFull(
      piece,
      events,
      actorNameById,
      payment,
      letters,
      corrections,
      content,
    );
  }

  /**
   * The article-editor draft for a piece (spec §7.3, plan Phase 3 Task 3).
   * Every `format: 'article'` piece gets its `MagazineArticle` lazily —
   * the first time anyone opens the editor, not at commission time — so
   * `piece.articleId` stays `null` until a draft actually exists. Auto-create
   * records its own `article_created` audit event; there's no `actorId` here
   * (this is a read), so it's logged system-attributed (`null`).
   */
  async getArticleDraft(pieceId: string): Promise<ArticleDraftResponse> {
    const piece = await this.loadPieceOr404(pieceId);
    const article = await this.ensureArticleForPiece(piece, null);
    return toArticleDraftResponse(article);
  }

  /**
   * Patches the article draft (spec §7.3 Task 3): validates `blocks` (if
   * present) BEFORE mutating the entity, so a malformed payload never
   * partially applies the rest of the patch (mirrors `updatePiece`'s
   * brief/care handling). Auto-creates the draft first if the piece doesn't
   * have one yet, same as `getArticleDraft`.
   *
   * The write itself goes through `saveArticleDraftGuarded`, which refuses a
   * save that is not based on the row's current `version` — the desk is
   * multi-actor, and this used to be last-write-wins over a whole `blocks`
   * array. `title` (and the plain-text `kicker`/`metaDescription`) are
   * normalised to plain text here, at the write boundary, rather than stripped
   * again at each read site.
   */
  async updateArticleDraft(
    pieceId: string,
    dto: UpdateArticleDto,
    actorId: string,
  ): Promise<ArticleDraftResponse> {
    const piece = await this.loadPieceOr404(pieceId);
    const article = await this.ensureArticleForPiece(piece, actorId);
    // Fail the stale save BEFORE validating/allocating anything, so a losing
    // autosave costs one query and leaves nothing behind (no orphan slug
    // allocation, no audit event). The authoritative check is the conditional
    // UPDATE in `saveArticleDraftGuarded` — this is the cheap early exit.
    this.assertArticleVersionCurrent(article, dto.expectedVersion);

    const blocks =
      dto.blocks !== undefined ? validateArticleBlocks(dto.blocks) : undefined;

    // Foreign-upload backstop (M1): the article-draft handler keeps the
    // interceptor's shared-upload exemption (any `magazine_editor` re-saves a
    // draft whose images a DIFFERENT editor uploaded), so a foreign storage key
    // reaches the service instead of being rejected. Allow such a key only when
    // it is ALREADY stored on the article — the social image or an existing
    // image block — and refuse any NEW foreign reference the caller is trying to
    // introduce. Runs BEFORE any mutation. See `assert-no-foreign-upload.ts`.
    const storedArticleImageRefs = this.collectArticleImageRefs(
      article.socialImage,
      article.blocks,
    );
    // CON-04 — the lead art is a stored article image too, so an editor
    // re-saving a draft whose hero a DIFFERENT editor uploaded is allowed,
    // while pointing it at a new foreign upload is not.
    if (article.heroImageKey) {
      storedArticleImageRefs.push(article.heroImageKey);
    }
    if (dto.heroImageKey !== undefined) {
      assertNoForeignUploadIntroduced(
        actorId,
        dto.heroImageKey,
        storedArticleImageRefs,
      );
    }
    if (dto.socialImage !== undefined) {
      assertNoForeignUploadIntroduced(
        actorId,
        dto.socialImage,
        storedArticleImageRefs,
      );
    }
    if (blocks !== undefined) {
      for (const incomingImageRef of this.collectArticleImageRefs(
        undefined,
        blocks,
      )) {
        assertNoForeignUploadIntroduced(
          actorId,
          incomingImageRef,
          storedArticleImageRefs,
        );
      }
    }

    // The headline arrives as the contentEditable's raw `innerHTML`. It is
    // stored as PLAIN TEXT — the reader, the archive list, search results, the
    // slug and the `MagazinePiece.title` mirror all render it as text, so the
    // markup is stripped ONCE here at the write boundary rather than at each of
    // those read sites (several of which never stripped it, printing literal
    // `<em>` into a headline).
    const plainTitle =
      dto.title !== undefined ? toPlainText(dto.title) : undefined;
    const isRealTitleChange =
      plainTitle !== undefined &&
      plainTitle.length > 0 &&
      plainTitle !== article.title;

    const patch: Partial<MagazineArticle> = {
      ...(plainTitle !== undefined ? { title: plainTitle } : {}),
      ...(dto.standfirst !== undefined ? { standfirst: dto.standfirst } : {}),
      ...(dto.kicker !== undefined ? { kicker: toPlainText(dto.kicker) } : {}),
      ...(dto.section !== undefined ? { section: dto.section } : {}),
      ...(dto.role !== undefined ? { role: dto.role } : {}),
      ...(dto.metaDescription !== undefined
        ? // Emitted into `<meta name="description">` — plain text by
          // definition, same reasoning as the title.
          { metaDescription: toPlainText(dto.metaDescription) }
        : {}),
      ...(dto.socialImage !== undefined
        ? { socialImage: dto.socialImage }
        : {}),
      // CON-04. Arrives as a bare storage key, or as the resolved
      // `/files/<key>` URL the editor's upload field was seeded with — the
      // global `StorageKeyOwnershipInterceptor` has already collapsed the
      // latter back to a key by the time this runs, so the column stays
      // canonical either way.
      ...(dto.heroImageKey !== undefined
        ? { heroImageKey: dto.heroImageKey }
        : {}),
      ...(dto.canonicalUrl !== undefined
        ? { canonicalUrl: dto.canonicalUrl }
        : {}),
      ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
      ...(dto.contentNotes !== undefined
        ? { contentNotes: dto.contentNotes }
        : {}),
      ...(blocks !== undefined ? { blocks } : {}),
    };

    // The slug is server-generated and read-only in the editor (ArticleMetaRail)
    // — it's derived from the title, never typed directly. It's seeded once,
    // lazily, from whatever title existed the first time the editor opened
    // (`ensureArticleForPiece`), which is often still a commission-time
    // placeholder. Keep it following the real headline while the article is
    // still unpublished; once published the slug is a public URL and must
    // stay stable, so it stops tracking title edits at that point.
    if (isRealTitleChange && article.publishedAt === null) {
      patch.slug = await allocateUniqueSlug(
        slugify(plainTitle || 'draft', 'draft'),
        async (candidate) =>
          (await this.articles.findOne({
            where: { slug: candidate, id: Not(article.id) },
          })) !== null,
      );
    }

    await this.saveArticleDraftGuarded(article, patch);

    // `MagazinePiece.title` is what every surface outside the editor reads
    // (command palette, piece board, piece record) — sync it with the
    // article's real headline instead of leaving it frozen at whatever
    // placeholder was set at commission time (e.g. "Untitled piece"). It's
    // rendered as plain text everywhere it's read, and so, now, is
    // `article.title` — both hold the same normalised `plainTitle`.
    if (isRealTitleChange && plainTitle && piece.title !== plainTitle) {
      piece.title = plainTitle;
      await this.pieces.save(piece);
    }

    await this.recordEvent(pieceId, actorId, 'article_edited', undefined, {
      mergeWhileLatest: true,
    });

    return toArticleDraftResponse(article);
  }

  /**
   * Publishes, schedules, or unpublishes an article draft (CNT-1/CNT-2 audit
   * follow-up) — the richer sibling of `updateDeck`'s boolean `published`
   * toggle, needed here because `MagazineArticle.publishedAt` doubles as the
   * schedule instant: the public read paths (`MagazineService.listArticles`/
   * `getArticleBySlug`) already gate on `publishedAt > now`, so setting it to
   * a FUTURE instant schedules the piece for free, no separate column needed.
   *
   * `dto.publishedAt` reads three ways: omitted -> publish now; an ISO
   * string -> publish/schedule at exactly that instant (past or future);
   * `null` -> unpublish, back to draft.
   *
   * A transition INTO a published/scheduled state (`publishedAt` was `null`,
   * now isn't) is gated TWICE, in this order (PRD-119):
   *
   *   1. the piece's CARE GATE (`computePublishGate` over `piece.care`:
   *      consent settled for every named subject, the sensitivity read
   *      complete, content notes written), and
   *   2. FORMAT READINESS (`articlePublishBlockers`: the standfirst + image-alt
   *      bar `articlePublishChecklist.ts` enforces client-side).
   *
   * The care gate is the P0 fix. This endpoint is the article editor's own
   * publish rail and, until now, it checked ONLY readiness: one editor could
   * put a piece live while a named subject's consent was still `pending` and
   * the sensitivity read had not been started, on the only real publish path
   * there was. The gate card promises that cannot be overridden by one person,
   * so the promise is now enforced where it is made rather than only drawn.
   *
   * Reverting to draft (`publishedAt: null`) is never gated — an editor must
   * always be able to pull a live piece back down regardless of its current
   * shape, and a gate that blocked TAKEDOWNS would be a safety hazard of its
   * own.
   */
  async publishArticle(
    pieceId: string,
    dto: PublishArticleDto,
    actorId: string,
  ): Promise<ArticleDraftResponse> {
    const piece = await this.loadPieceOr404(pieceId);
    const article = await this.ensureArticleForPiece(piece, actorId);

    const wasPublished = article.publishedAt !== null;
    // Distinct from `wasPublished`: an article SCHEDULED for next Tuesday has
    // a `publishedAt` and is still invisible, so bringing it forward to now is
    // the moment it actually goes live and the moment its writer should hear
    // about it.
    const wasLive = isLiveInstant(article.publishedAt);
    const nextPublishedAt =
      dto.publishedAt === null
        ? null
        : dto.publishedAt !== undefined
          ? new Date(dto.publishedAt)
          : new Date();

    if (nextPublishedAt !== null && !wasPublished) {
      this.assertCareGateClear(piece);
      this.assertFormatReady(articlePublishBlockers(article));
    }

    article.publishedAt = nextPublishedAt;
    await this.articles.save(article);

    await this.applyPublishSideEffects(piece, {
      actorId,
      publishedAt: nextPublishedAt,
      wasLive,
      slug: article.slug,
    });

    return toArticleDraftResponse(article);
  }

  /**
   * PRD-119/PRD-120 — the piece record's own Publish action, for BOTH formats.
   *
   * The piece record page had a Publish button that did nothing but raise a
   * toast: the only real publish path was the article editor's rail, so a
   * DECK-format piece could be put live by nothing but shipping its issue, and
   * an editor working from the record had no way to publish at all.
   *
   * Gated exactly like `publishArticle`: the care gate first, then the
   * format's own readiness check (`articlePublishBlockers` /
   * `deckPublishBlockers`). Both failures carry a machine-readable `code` plus
   * the open items, so the desk can name what is missing instead of showing a
   * flat "not ready".
   */
  async publishPiece(
    pieceId: string,
    dto: PublishPieceDto,
    actorId: string,
  ): Promise<PieceRecordFull> {
    const piece = await this.loadPieceOr404(pieceId);

    // An explicit `null` means the same as omitting the field: publish now.
    // Taking a piece back down is `unpublishPiece`, never a null here, so the
    // gated act and the ungated one can never be confused for one another.
    const nextPublishedAt =
      dto.publishedAt === undefined || dto.publishedAt === null
        ? new Date()
        : new Date(dto.publishedAt);

    this.assertCareGateClear(piece);

    let slug: string;
    let wasLive: boolean;

    if (piece.format === 'deck') {
      const deck =
        piece.deckId === null
          ? null
          : await this.decks.findOne({ where: { id: piece.deckId } });
      if (deck === null) {
        this.assertFormatReady(['The deck has not been started yet.']);
        // `assertFormatReady` always throws on a non-empty list; this is here
        // only so the compiler can see `deck` narrowed below.
        throw new BadRequestException('This piece is not ready to publish.');
      }
      this.assertFormatReady(deckPublishBlockers(deck));
      wasLive = isLiveInstant(deck.publishedAt);
      deck.publishedAt = nextPublishedAt;
      await this.decks.save(deck);
      slug = deck.slug;
    } else {
      const article = await this.ensureArticleForPiece(piece, actorId);
      this.assertFormatReady(articlePublishBlockers(article));
      wasLive = isLiveInstant(article.publishedAt);
      article.publishedAt = nextPublishedAt;
      await this.articles.save(article);
      slug = article.slug;
    }

    await this.applyPublishSideEffects(piece, {
      actorId,
      publishedAt: nextPublishedAt,
      wasLive,
      slug,
    });

    return this.getPieceRecordFull(pieceId);
  }

  /**
   * PRD-119 — takes a live (or scheduled) piece back down, for both formats.
   *
   * NEVER gated. A takedown is the one publish-pipeline action that must work
   * on a piece in any shape whatsoever: the reason to pull something down is
   * usually that something about it is wrong, and a readiness or care check
   * standing between an editor and that button would be a safety hazard.
   */
  async unpublishPiece(
    pieceId: string,
    actorId: string,
  ): Promise<PieceRecordFull> {
    const piece = await this.loadPieceOr404(pieceId);

    if (piece.format === 'deck') {
      const deck =
        piece.deckId === null
          ? null
          : await this.decks.findOne({ where: { id: piece.deckId } });
      if (deck !== null && deck.publishedAt !== null) {
        deck.publishedAt = null;
        await this.decks.save(deck);
      }
    } else {
      const article =
        piece.articleId === null
          ? null
          : await this.articles.findOne({ where: { id: piece.articleId } });
      if (article !== null && article.publishedAt !== null) {
        article.publishedAt = null;
        await this.articles.save(article);
      }
    }

    if (piece.stage === 'published') {
      piece.stage = 'ready';
      await this.pieces.save(piece);
    }

    await this.recordEvent(pieceId, actorId, 'article_unpublished');

    return this.getPieceRecordFull(pieceId);
  }

  /**
   * The care gate as an assertion (PRD-119). Throws with a machine-readable
   * `code` and the LABELS of every open item, so the desk can say which
   * consent or which sensitivity check is still outstanding instead of a flat
   * refusal. Shared by every publish path so they can never drift apart, which
   * is exactly how the article rail ended up ungated.
   */
  private assertCareGateClear(piece: MagazinePiece): void {
    const openGateItems = computePublishGate(piece.care)
      .filter((gateItem) => !gateItem.done)
      .map((gateItem) => gateItem.label);
    if (openGateItems.length > 0) {
      throw new BadRequestException({
        message: 'This piece is behind its care gate and cannot be published.',
        code: 'magazine_care_gate_open',
        openGateItems,
      });
    }
  }

  /**
   * The format-readiness half of the publish gate: a no-op on an empty list,
   * and otherwise the same payload shape as `assertCareGateClear` with the
   * blockers already written as human sentences.
   */
  private assertFormatReady(blockers: string[]): void {
    if (blockers.length > 0) {
      throw new BadRequestException({
        message: 'This piece is not ready to publish.',
        code: 'magazine_publish_not_ready',
        openGateItems: blockers,
      });
    }
  }

  /**
   * Everything that happens AFTER a publish/schedule/unpublish has been
   * written to the article or deck row: the audit event, the piece's own
   * `stage`, and the writer's notification. One helper so the article rail and
   * the piece record's Publish button behave identically.
   *
   * A FUTURE instant is a schedule: the piece stays at `ready` and the writer
   * is not told, because nothing has gone live yet. `wasLive` keeps a re-save
   * of an already-published piece from ringing the writer's bell a second
   * time.
   */
  private async applyPublishSideEffects(
    piece: MagazinePiece,
    change: {
      actorId: string;
      publishedAt: Date | null;
      wasLive: boolean;
      slug: string;
    },
  ): Promise<void> {
    const isScheduledForFuture =
      change.publishedAt !== null && change.publishedAt.getTime() > Date.now();
    const publishEvent =
      change.publishedAt === null
        ? 'article_unpublished'
        : isScheduledForFuture
          ? 'article_scheduled'
          : 'article_published';
    // Its own distinct, un-merged audit row — never collapsed into the
    // autosave's `mergeWhileLatest` edit entry, so the desk timeline keeps a
    // clear record of exactly when the piece went live/was scheduled/came
    // down.
    await this.recordEvent(piece.id, change.actorId, publishEvent);

    const isLiveNow = change.publishedAt !== null && !isScheduledForFuture;
    const nextStage: PieceStage | null = isLiveNow
      ? 'published'
      : piece.stage === 'published'
        ? 'ready'
        : null;
    if (nextStage !== null && nextStage !== piece.stage) {
      piece.stage = nextStage;
      await this.pieces.save(piece);
    }

    if (isLiveNow && !change.wasLive) {
      await this.notifyWriterOfPiece(
        piece,
        change.actorId,
        NotificationType.MagazinePiecePublished,
        { href: toPiecePublicHref(piece.format, change.slug) },
      );
    }
  }

  /**
   * PRD-121 — the single emit point for every writer-facing piece
   * notification (commissioned, stage changed, published).
   *
   * Before this the desk was silent: commissioning, assigning, stage changes
   * and publishing all wrote nothing, and the only writer-facing piece
   * notification in the whole module was `MagazinePieceMessage`. A writer
   * found out they had been given a piece by opening `/magazine/writer` on a
   * hunch.
   *
   * Three rules, all enforced here so no caller can forget one:
   *   - No writer, no notification.
   *   - Never notify someone about their OWN action. The desk's "I write this
   *     one" makes an editor their own writer (`writerId === editorId`), and a
   *     bell that tells you what you just did is noise.
   *   - The acting editor rides along as the `actorId` argument, exactly like
   *     `MagazinePieceMessage`, so block/mute filtering applies.
   *
   * Emission NEVER fails the mutation it hangs off. A commission that rolled
   * back because a bell could not ring would be a far worse bug than a missing
   * bell, so this swallows and logs like `announceIssueIfScheduled`.
   */
  private async notifyWriterOfPiece(
    piece: MagazinePiece,
    actorId: string,
    type: NotificationType,
    extraPayload: Record<string, unknown> = {},
  ): Promise<void> {
    const writerId = piece.writerId;
    if (writerId === null || writerId === actorId) {
      return;
    }

    try {
      await this.notifications.create(
        writerId,
        type,
        {
          source: 'magazine',
          pieceId: piece.id,
          title: piece.title,
          // `actorId` rides in the payload as well as in the argument below:
          // the argument is the block/mute gate, and the payload key is what
          // `ACTOR_PAYLOAD_KEY` resolves into the bell row's `actor` (the
          // response mapper strips the raw id on the way out). Without it the
          // row would read as the platform speaking rather than the editor.
          actorId,
          ...extraPayload,
        },
        actorId,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to notify writer ${writerId} of piece ${piece.id} (${type}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Creates or updates the 1:1 `MagazinePayment` row for a piece (spec §7.2
   * Money tab). Moving `status` to `'paid'` stamps `paidOn` with today's date
   * when the caller didn't already supply one — a manual `paidOn` (e.g.
   * backfilling an earlier date) is never overwritten.
   */
  async upsertPayment(
    pieceId: string,
    dto: UpdatePaymentDto,
    actorId: string,
  ): Promise<PaymentResponse> {
    await this.loadPieceOr404(pieceId);

    let payment = await this.payments.findOne({ where: { pieceId } });
    if (!payment) {
      payment = this.payments.create({
        pieceId,
        currency: dto.currency ?? DEFAULT_MAGAZINE_CURRENCY,
        feeAmount: dto.fee ?? null,
      });
    }

    Object.assign(payment, {
      // CON-18 — `fee`/`expenses` arrive as validated decimal strings and go
      // straight into `numeric` columns; the desk's own wording keeps its own
      // fields. An empty string clears the amount rather than storing "" in a
      // numeric column, which Postgres would reject.
      ...(dto.fee !== undefined ? { feeAmount: dto.fee || null } : {}),
      ...(dto.feeText !== undefined ? { feeText: dto.feeText || null } : {}),
      ...(dto.expenses !== undefined
        ? { expensesAmount: dto.expenses || null }
        : {}),
      ...(dto.expensesText !== undefined
        ? { expensesText: dto.expensesText || null }
        : {}),
      ...(dto.currency !== undefined
        ? { currency: dto.currency.toUpperCase() }
        : {}),
      ...(dto.invoice !== undefined ? { invoice: dto.invoice } : {}),
      ...(dto.filedOn !== undefined ? { filedOn: dto.filedOn } : {}),
      ...(dto.terms !== undefined ? { terms: dto.terms } : {}),
      ...(dto.dueOn !== undefined ? { dueOn: dto.dueOn } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.paidOn !== undefined ? { paidOn: dto.paidOn } : {}),
    });

    if (dto.status === 'paid' && !payment.paidOn) {
      payment.paidOn = todayIsoDate();
    }

    await this.payments.save(payment);
    await this.recordEvent(pieceId, actorId, 'payment_updated');

    return toPaymentResponse(payment);
  }

  async addLetter(
    pieceId: string,
    dto: CreateLetterDto,
  ): Promise<LetterResponse> {
    await this.loadPieceOr404(pieceId);

    const letter = this.letters.create({
      pieceId,
      who: dto.who,
      body: dto.body,
      runInLetters: dto.runInLetters ?? false,
    });
    await this.letters.save(letter);

    return toLetterResponse(letter);
  }

  async listLetters(pieceId: string): Promise<LetterResponse[]> {
    const rows = await this.lettersFor(pieceId);
    return rows.map(toLetterResponse);
  }

  /**
   * Toggles a reader letter's "run in letters" flag (spec §7.2 After tab,
   * Magazine Desk Phase 7, Task B3). Idempotent — this only ever mutates the
   * existing row, never creates a new one, so flipping the toggle back and
   * forth leaves exactly one letter behind. `letterId` is asserted against
   * `pieceId` (not just looked up by its own id) so a caller can never
   * toggle a letter that belongs to a different piece via the URL.
   */
  async updateLetter(
    pieceId: string,
    letterId: string,
    runInLetters: boolean,
  ): Promise<LetterResponse> {
    const letter = await this.letters.findOne({ where: { id: letterId } });
    if (!letter || letter.pieceId !== pieceId) {
      throw new NotFoundException('Letter not found');
    }

    letter.runInLetters = runInLetters;
    await this.letters.save(letter);

    return toLetterResponse(letter);
  }

  async addCorrection(
    pieceId: string,
    dto: CreateCorrectionDto,
    actorId: string,
  ): Promise<CorrectionResponse> {
    await this.loadPieceOr404(pieceId);

    const correction = this.corrections.create({
      pieceId,
      text: dto.text,
      publishedOn: dto.publishedOn ?? todayIsoDate(),
    });
    await this.corrections.save(correction);
    await this.recordEvent(pieceId, actorId, 'correction_published');

    return toCorrectionResponse(correction);
  }

  /**
   * Create a piece. Two editorial acts share this one endpoint, told apart by
   * whether the editor is also the writer:
   *
   * - Commissioning someone else (`writerId` unset or another user): the piece
   *   starts at `commissioned`, because a brief still has to go out and come
   *   back before anyone drafts anything.
   * - Writing it yourself (`writerId === editorId`): there is no brief to
   *   send, so the piece starts at `drafting` and the audit trail says
   *   "started writing" rather than "commissioned". Nothing downstream needs
   *   a special case: `deriveWaitingOn` already reads a drafting piece with a
   *   writer as owed by that writer, who here is you.
   */
  async createPiece(
    dto: CreatePieceDto,
    actorId: string,
  ): Promise<PieceRecord> {
    const isSelfWritten =
      dto.writerId !== undefined && dto.writerId === dto.editorId;

    const piece = this.pieces.create({
      format: dto.format,
      title: dto.title,
      section: dto.section,
      kind: dto.kind ?? null,
      stage: isSelfWritten ? 'drafting' : 'commissioned',
      editorId: dto.editorId,
      writerId: dto.writerId ?? null,
      byline: dto.byline ?? '',
      dueOn: dto.dueOn ?? null,
      issueId: dto.issueId ?? null,
      wordTarget: dto.wordTarget ?? null,
      slideTarget: dto.slideTarget ?? null,
      fresh: dto.fresh ?? false,
      pitchId: dto.pitchId ?? null,
      art: dto.art ?? 'none',
      contentsBlurb: dto.contentsBlurb ?? '',
    });
    await this.pieces.save(piece);

    if (dto.pitchId) {
      const pitch = await this.loadPitchOr404(dto.pitchId);
      pitch.status = 'commissioned';
      await this.pitches.save(pitch);
    }

    await this.recordEvent(
      piece.id,
      actorId,
      isSelfWritten ? 'started_writing' : 'commissioned',
    );

    // PRD-121. `notifyWriterOfPiece` no-ops on a self-written piece
    // (`writerId === actorId`), so the self-written branch needs no special
    // case here.
    await this.notifyWriterOfPiece(
      piece,
      actorId,
      NotificationType.MagazinePieceCommissioned,
    );

    const events = await this.eventsFor(piece.id);
    return this.pieceRecordFor(piece, events);
  }

  async updatePiece(
    id: string,
    dto: UpdatePieceDto,
    actorId: string,
  ): Promise<PieceRecord> {
    const piece = await this.loadPieceOr404(id);

    // Validate the jsonb payloads BEFORE mutating the entity, so a malformed
    // brief/care never partially applies the rest of the patch.
    const brief =
      dto.brief !== undefined ? validatePieceBrief(dto.brief) : undefined;
    const care =
      dto.care !== undefined ? validatePieceCare(dto.care) : undefined;

    const previousStage = piece.stage;
    const previousEditorId = piece.editorId;
    const previousWriterId = piece.writerId;

    Object.assign(piece, {
      ...(dto.format !== undefined ? { format: dto.format } : {}),
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.section !== undefined ? { section: dto.section } : {}),
      ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
      ...(dto.byline !== undefined ? { byline: dto.byline } : {}),
      ...(dto.editorId !== undefined ? { editorId: dto.editorId } : {}),
      ...(dto.writerId !== undefined ? { writerId: dto.writerId } : {}),
      ...(dto.dueOn !== undefined ? { dueOn: dto.dueOn } : {}),
      ...(dto.issueId !== undefined ? { issueId: dto.issueId } : {}),
      ...(dto.wordTarget !== undefined ? { wordTarget: dto.wordTarget } : {}),
      ...(dto.slideTarget !== undefined
        ? { slideTarget: dto.slideTarget }
        : {}),
      ...(dto.fresh !== undefined ? { fresh: dto.fresh } : {}),
      ...(dto.stage !== undefined ? { stage: dto.stage } : {}),
      ...(brief !== undefined ? { brief } : {}),
      ...(care !== undefined ? { care } : {}),
      ...(dto.orderIndex !== undefined ? { orderIndex: dto.orderIndex } : {}),
      ...(dto.pages !== undefined ? { pages: dto.pages } : {}),
      ...(dto.laidOut !== undefined ? { laidOut: dto.laidOut } : {}),
      ...(dto.art !== undefined ? { art: dto.art } : {}),
      ...(dto.contentsBlurb !== undefined
        ? { contentsBlurb: dto.contentsBlurb }
        : {}),
    });

    await this.pieces.save(piece);

    if (dto.stage !== undefined && dto.stage !== previousStage) {
      await this.recordEvent(piece.id, actorId, 'stage_changed', dto.stage);
    }
    if (dto.editorId !== undefined && dto.editorId !== previousEditorId) {
      await this.recordEvent(
        piece.id,
        actorId,
        'assigned',
        `editor:${dto.editorId}`,
      );
    }
    if (dto.writerId !== undefined && dto.writerId !== previousWriterId) {
      await this.recordEvent(
        piece.id,
        actorId,
        'assigned',
        dto.writerId ? `writer:${dto.writerId}` : 'writer:unassigned',
      );
    }

    // PRD-121, both writer-facing signals on this endpoint. A piece moved onto
    // a NEW writer reads as a commission to that person, so they get the
    // commission notification rather than a stage one; an unassignment
    // (`writerId: null`) reaches `notifyWriterOfPiece` with no writer and
    // no-ops. A stage change tells whoever currently holds the piece, which is
    // why it reads `piece.writerId` (already patched above) and not
    // `previousWriterId`.
    const hasNewWriter =
      dto.writerId !== undefined &&
      dto.writerId !== previousWriterId &&
      dto.writerId !== null;
    if (hasNewWriter) {
      await this.notifyWriterOfPiece(
        piece,
        actorId,
        NotificationType.MagazinePieceCommissioned,
      );
    }
    if (dto.stage !== undefined && dto.stage !== previousStage) {
      await this.notifyWriterOfPiece(
        piece,
        actorId,
        NotificationType.MagazinePieceStageChanged,
        { stage: dto.stage },
      );
    }

    const events = await this.eventsFor(piece.id);
    return this.pieceRecordFor(piece, events);
  }

  /**
   * Deletes a piece AND the content it owns.
   *
   * The piece holds `articleId`/`deckId` as plain nullable uuid columns with no
   * reverse link from the content back to the piece, so removing the piece
   * alone used to leave the article/deck row behind with nothing pointing at
   * it. A PUBLISHED one kept serving to readers with no desk surface left to
   * take it down from; an unpublished one became unreachable while still
   * squatting its slug on the unique index and still turning up in
   * `searchArchive`.
   *
   * So: published content is REFUSED (409 — unpublish it first, which is one
   * click and keeps the destructive act explicit), and unpublished content is
   * deleted with the piece in one transaction. Article versions and editor
   * comments go with the article: neither carries a database-level cascade
   * (both model `article_id` as a plain indexed uuid, see
   * `AddMagazineArticleVersion`), so they are deleted here or not at all.
   * Reader comments are not swept because only a published article can have
   * them, and a published article never reaches this path.
   */
  async deletePiece(id: string, actorId: string): Promise<void> {
    const piece = await this.loadPieceOr404(id);

    const article =
      piece.articleId === null
        ? null
        : await this.articles.findOne({ where: { id: piece.articleId } });
    const deck =
      piece.deckId === null
        ? null
        : await this.decks.findOne({ where: { id: piece.deckId } });

    if (article !== null && article.publishedAt !== null) {
      throw new ConflictException(
        'This piece has a published article. Unpublish it before deleting the piece.',
      );
    }
    if (deck !== null && deck.publishedAt !== null) {
      throw new ConflictException(
        'This piece has a published deck. Unpublish it before deleting the piece.',
      );
    }

    // Record the audit event before removing the row so it isn't silently
    // dropped — `magazine_piece_event.piece_id` is unconstrained, so this
    // history entry (and any earlier ones) survives the piece's removal.
    await this.recordEvent(id, actorId, 'deleted');

    await this.dataSource.transaction(async (manager) => {
      if (article !== null) {
        await manager
          .getRepository(MagazineArticleVersion)
          .delete({ articleId: article.id });
        await manager
          .getRepository(MagazineArticleComment)
          .delete({ articleId: article.id });
        await manager.getRepository(MagazineArticle).delete({ id: article.id });
      }
      if (deck !== null) {
        await manager.getRepository(MagazineDeck).delete({ id: deck.id });
      }
      await manager.getRepository(MagazinePiece).delete({ id: piece.id });

      // ENG-113 — hand the originating pitch back to the inbox.
      //
      // Committing a pitch stamps it `commissioned`, and `listPitches` returns
      // only `waiting`/`maybe`. So deleting a piece that had been commissioned
      // in error used to strand its pitch: permanently invisible, never
      // re-triageable, never commissionable again, with the pitcher's idea
      // silently lost. The piece is gone, so the commission it recorded is no
      // longer true, and `waiting` is what the pitch actually is again.
      //
      // `returnedAt` records that this is a RETURNING pitch rather than a new
      // one, so the inbox can say so instead of surprising the editor with a
      // row they thought they had already dealt with. Inside the same
      // transaction as the delete: a pitch reopened against a piece that
      // survived would offer a second commission of the same idea.
      if (piece.pitchId !== null) {
        await manager.getRepository(MagazinePitch).update(
          { id: piece.pitchId },
          {
            status: 'waiting',
            returnedAt: new Date(),
            // The pitch was commissioned, so these are already null. Clearing
            // them anyway keeps a reopened pitch from ever carrying a stale
            // pass note from some earlier round of triage.
            passTemplate: null,
            passNote: null,
          },
        );
      }
    });
  }

  /**
   * The editor pitch inbox (spec §3.2): everything still awaiting a verdict.
   *
   * Submitter names are resolved in ONE batched lookup for the whole page
   * (PRD-123), never one per row. A pitch submitted from inside the platform
   * (the writer workspace, or a member story submission the desk commissioned)
   * stores `from: ''` and carries `submitterId`, so before this the inbox
   * printed a blank byline on every one of them.
   */
  async listPitches(): Promise<PitchResponse[]> {
    const rows = await this.pitches.find({
      where: [{ status: 'waiting' }, { status: 'maybe' }],
      order: { createdAt: 'DESC' },
    });

    const submitterNameById = await this.resolvePitchSubmitterNames(rows);
    return rows.map((pitch) =>
      toPitchResponse(
        pitch,
        pitch.submitterId === null
          ? null
          : (submitterNameById.get(pitch.submitterId) ?? null),
      ),
    );
  }

  async createPitch(dto: CreatePitchDto): Promise<PitchResponse> {
    const pitch = this.pitches.create({
      title: dto.title,
      from: dto.from,
      note: dto.note,
      tags: dto.tags ?? [],
      suggestFormat: dto.suggestFormat ?? null,
      status: 'waiting',
      fresh: dto.fresh ?? false,
      issueId: dto.issueId ?? null,
    });
    await this.pitches.save(pitch);
    // An editor-created pitch always has a free-text `from` and never a
    // `submitterId`, so there is nothing to resolve.
    return toPitchResponse(pitch);
  }

  async triagePitch(
    id: string,
    dto: TriagePitchDto,
    actorId: string,
  ): Promise<PitchResponse | PieceRecord> {
    if (dto.verdict === 'commission') {
      return this.commissionPitch(id, dto, actorId);
    }

    const pitch = await this.loadPitchOr404(id);

    if (dto.verdict === 'pass') {
      pitch.status = 'passed';
      pitch.passTemplate = dto.passTemplate ?? null;
      pitch.passNote = dto.passNote ?? null;
    } else {
      pitch.status = 'maybe';
    }

    await this.pitches.save(pitch);
    const submitterNameById = await this.resolvePitchSubmitterNames([pitch]);
    return toPitchResponse(
      pitch,
      pitch.submitterId === null
        ? null
        : (submitterNameById.get(pitch.submitterId) ?? null),
    );
  }

  async deskSummary(): Promise<DeskSummary> {
    const [pieces, events] = await Promise.all([
      // Unbounded over the whole `magazine_piece` table — project down to
      // what `toDeskSummary` (plus the `editorId` grouping just below) reads:
      // `stage` and `editorId` only. The full row also carries the jsonb
      // `brief`/`care` fields, neither of which a stage/editor-load rollup
      // ever touches.
      this.pieces.find({ select: { stage: true, editorId: true } }),
      this.pieceEvents.find({
        order: { createdAt: 'DESC' },
        take: RECENT_ACTIVITY_LIMIT,
      }),
    ]);

    const editorIds = [...new Set(pieces.map((piece) => piece.editorId))];
    const editors = editorIds.map((editorId) => ({
      id: editorId,
      cap: EDITOR_CAP,
    }));

    // The activity feed renders names and piece titles, never ids — resolve
    // both in ONE batched query each (same technique as
    // `listArticleComments`), never per event. The title lookup is its
    // own query rather than reusing `pieces` above: that projection carries
    // no `title`, and an event can outlive its piece anyway.
    const activityPieceIds = [...new Set(events.map((event) => event.pieceId))];
    const [activityPieces, actorNameById] = await Promise.all([
      activityPieceIds.length > 0
        ? this.pieces.find({
            where: { id: In(activityPieceIds) },
            select: { id: true, title: true },
          })
        : Promise.resolve([]),
      this.resolveActorDisplayNames(auditActorIds(events)),
    ]);
    const titleByPieceId = new Map(
      activityPieces.map((piece) => [piece.id, piece.title]),
    );

    return toDeskSummary(
      pieces,
      events,
      editors,
      titleByPieceId,
      actorNameById,
    );
  }

  /**
   * The editor directory for the desk's "viewing as" picker and sidebar
   * editor-load names (Magazine Desk Phase 7, Task A1): every user holding
   * the `magazine_editor` staff role, plus admins (`StaffRolesGuard`
   * treats admins as a superset, so the directory mirrors that here).
   * Hand-mapped via `toMagazineEditor` — never the raw `User`/`Profile`
   * rows — so this never leaks `email`, `googleId`, or any other account
   * column. Deduped by user id (an admin who also holds the staff-role
   * grant appears once) and sorted by name for a stable picker order.
   */
  async listMagazineEditors(): Promise<MagazineEditorResponse[]> {
    const [staffGrants, admins] = await Promise.all([
      this.staffRoles.find({ where: { role: 'magazine_editor' } }),
      this.users.find({ where: { role: UserRole.Admin } }),
    ]);

    const editorIds = new Set<string>();
    for (const grant of staffGrants) {
      editorIds.add(grant.userId);
    }
    for (const admin of admins) {
      editorIds.add(admin.id);
    }
    if (editorIds.size === 0) {
      return [];
    }

    const profiles = await this.profiles.find({
      where: { userId: In([...editorIds]) },
    });
    const profileByUserId = new Map(
      profiles.map((profile) => [profile.userId, profile]),
    );

    const editors: MagazineEditorResponse[] = [];
    for (const userId of editorIds) {
      const editor = toMagazineEditor(
        userId,
        profileByUserId.get(userId) ?? null,
      );
      if (editor) {
        editors.push(editor);
      }
    }

    return editors.sort((left, right) => left.name.localeCompare(right.name));
  }

  // --- article comments / NotesRail (Magazine Desk Phase 7, Task D1) ---

  /**
   * The full threaded comment tree for a piece's article (NotesRail).
   * Resolves the piece's linked article first — a piece with no article
   * draft yet has no comments, so this returns `[]` rather than creating one
   * (unlike `addArticleComment`, a read never has side effects). Author
   * names are resolved with the exact same batched editor-directory ∪
   * `Profile` lookup as `resolveActorDisplayNames`, so a writer commenting
   * on their own piece resolves to their real name rather than the
   * editor-only fallback.
   */
  async listArticleComments(
    pieceId: string,
  ): Promise<ArticleCommentResponse[]> {
    const piece = await this.loadPieceOr404(pieceId);
    if (piece.articleId === null) {
      return [];
    }

    const comments = await this.articleComments.find({
      where: { articleId: piece.articleId },
    });
    if (comments.length === 0) {
      return [];
    }

    const editors = await this.listMagazineEditors();
    const authorNameById = new Map(
      editors.map((editor) => [editor.id, editor.name]),
    );

    // A NULL `authorId` (the author erased their account) has nothing to look
    // up: `resolveCommentAuthorLabel` renders it as a former member without a
    // name map entry. Same filter shape as `listArticleVersions`.
    const unresolvedAuthorIds = [
      ...new Set(
        comments
          .map((comment) => comment.authorId)
          .filter(
            (authorId): authorId is string =>
              authorId !== null && !authorNameById.has(authorId),
          ),
      ),
    ];
    if (unresolvedAuthorIds.length > 0) {
      const unresolvedProfiles = await this.profiles.find({
        where: { userId: In(unresolvedAuthorIds) },
      });
      for (const profile of unresolvedProfiles) {
        authorNameById.set(profile.userId, toActorDisplayName(profile));
      }
    }

    return toArticleCommentTree(comments, authorNameById);
  }

  /**
   * Adds a top-level note to a piece's article (`parentId: null`), optionally
   * anchored to one block via `dto.blockId`. Auto-creates the article draft
   * first if the piece doesn't have one yet — same lazy-create as
   * `getArticleDraft`/`updateArticleDraft` — so a note can be left the moment
   * the editor opens the (empty) article editor. Records a lightweight
   * `commented` audit event; `action` is a plain string (see
   * `MagazinePieceEvent.action`), which `describePieceEventAction` renders as
   * "left a note on {piece}" wherever the trail surfaces.
   */
  async addArticleComment(
    pieceId: string,
    authorId: string,
    dto: CreateArticleCommentDto,
  ): Promise<ArticleCommentResponse> {
    const piece = await this.loadPieceOr404(pieceId);
    const article = await this.ensureArticleForPiece(piece, authorId);

    const comment = this.articleComments.create({
      articleId: article.id,
      blockId: dto.blockId ?? null,
      parentId: null,
      authorId,
      body: dto.body,
      resolved: false,
    });
    await this.articleComments.save(comment);
    await this.recordEvent(pieceId, authorId, 'commented');

    const authorName = await this.resolveCommentAuthorName(authorId);
    return toArticleCommentResponse(comment, authorName);
  }

  /**
   * Replies to an existing (top-level) comment. Inherits the parent's
   * `articleId` — the reply is never asked for its own article/piece — and
   * carries no `blockId` of its own (a reply threads under its parent's
   * anchor, not a second one). `NotFound` when the parent comment doesn't
   * exist, so a stale/garbage `commentId` never silently creates an orphaned
   * row.
   */
  async replyToArticleComment(
    commentId: string,
    authorId: string,
    dto: ReplyArticleCommentDto,
  ): Promise<ArticleCommentResponse> {
    const parent = await this.articleComments.findOne({
      where: { id: commentId },
    });
    if (!parent) {
      throw new NotFoundException('Comment not found');
    }

    const reply = this.articleComments.create({
      articleId: parent.articleId,
      blockId: null,
      parentId: parent.id,
      authorId,
      body: dto.body,
      resolved: false,
    });
    await this.articleComments.save(reply);

    const authorName = await this.resolveCommentAuthorName(authorId);
    return toArticleCommentResponse(reply, authorName);
  }

  /**
   * Sets a comment's `resolved` flag (idempotent — setting the same value
   * twice is a no-op write, not an error). `NotFound` when the comment
   * doesn't exist.
   */
  async resolveArticleComment(
    commentId: string,
    dto: ResolveArticleCommentDto,
  ): Promise<ArticleCommentResponse> {
    const comment = await this.articleComments.findOne({
      where: { id: commentId },
    });
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    comment.resolved = dto.resolved;
    await this.articleComments.save(comment);

    const authorName = await this.resolveCommentAuthorName(comment.authorId);
    return toArticleCommentResponse(comment, authorName);
  }

  // --- article versions / VersionsRail (Magazine Desk Phase 7, Task E1) ---

  /**
   * The version history for a piece's article (VersionsRail list),
   * newest-first, with author names resolved but NO `blocks` payload (see
   * `ArticleVersionSummaryResponse`'s doc comment) — the diff view fetches
   * one version's full blocks separately via `getArticleVersion`. A piece
   * with no article draft yet has no versions, same convention as
   * `listArticleComments`.
   */
  async listArticleVersions(
    pieceId: string,
  ): Promise<ArticleVersionSummaryResponse[]> {
    const piece = await this.loadPieceOr404(pieceId);
    if (piece.articleId === null) {
      return [];
    }

    const versions = await this.articleVersions.find({
      where: { articleId: piece.articleId },
      order: { createdAt: 'DESC' },
    });
    if (versions.length === 0) {
      return [];
    }

    const authorNameById = await this.resolveVersionAuthorNames(versions);
    return versions.map((version) =>
      toArticleVersionSummary(version, authorNameById),
    );
  }

  /**
   * A single version's full detail (id, label, author, createdAt, and the
   * `blocks` snapshot) for the VersionsRail diff view. `NotFound` when the
   * version doesn't exist.
   */
  async getArticleVersion(
    versionId: string,
  ): Promise<ArticleVersionDetailResponse> {
    const version = await this.loadArticleVersionOr404(versionId);
    const authorNameById = await this.resolveVersionAuthorNames([version]);
    return toArticleVersionDetail(version, authorNameById);
  }

  /**
   * An editor's explicit "save version now" action (VersionsRail). Snapshots
   * the article's CURRENT blocks (auto-creating the article draft first if
   * the piece doesn't have one yet, same lazy-create as `getArticleDraft`) —
   * `label` defaults to `"Manual save"` when the caller doesn't supply one.
   */
  async createArticleVersion(
    pieceId: string,
    authorId: string,
    label?: string,
  ): Promise<ArticleVersionSummaryResponse> {
    const piece = await this.loadPieceOr404(pieceId);
    const article = await this.ensureArticleForPiece(piece, authorId);

    const version = await this.snapshotArticleVersion(
      article,
      authorId,
      label ?? 'Manual save',
    );

    const authorNameById = await this.resolveVersionAuthorNames([version]);
    return toArticleVersionSummary(version, authorNameById);
  }

  /**
   * Restores a version's blocks onto the article (VersionsRail "Restore").
   * Nothing is ever lost: the CURRENT article state is snapshotted first
   * (label `"Before restore"`), so undoing a bad restore is just restoring
   * that checkpoint; only then are the version's blocks copied onto the
   * article (re-validated via `validateArticleBlocks`, since a version's
   * `blocks` predate any schema tightening) and a second, new version is
   * recorded (label `"Restored from {version's created date}"`) so the
   * restore itself shows up in the history. `NotFound` when the version
   * doesn't exist, has no article on the piece yet, or belongs to a
   * different piece's article — a caller can never restore across pieces via
   * the URL. Returns the updated article draft (the same shape
   * `updateArticleDraft`/`getArticleDraft` return), not a version summary,
   * so the editor UI can refresh the block editor directly from the result.
   */
  async restoreArticleVersion(
    pieceId: string,
    versionId: string,
    actorId: string,
  ): Promise<ArticleDraftResponse> {
    const piece = await this.loadPieceOr404(pieceId);
    if (piece.articleId === null) {
      throw new NotFoundException('This piece has no article draft yet.');
    }

    const version = await this.loadArticleVersionOr404(versionId);
    if (version.articleId !== piece.articleId) {
      throw new NotFoundException(
        'This version does not belong to this piece.',
      );
    }

    const article = await this.loadArticleOr404(piece.articleId);

    // Validate BEFORE any side effect (mirrors `updateArticleDraft`): a
    // version whose stored blocks fail today's validation must never leave
    // behind a stray "Before restore" checkpoint for a restore that didn't
    // actually happen.
    const restoredBlocks = validateArticleBlocks(
      structuredClone(version.blocks),
    );

    // Snapshot the state we're about to overwrite BEFORE mutating it, so the
    // restore is itself undoable.
    await this.snapshotArticleVersion(article, actorId, 'Before restore');

    // Guarded like every other draft-body write: bumping `version` is what
    // makes a tab that was open across the restore fail its next autosave with
    // a 409 instead of quietly writing its pre-restore blocks back over it.
    await this.saveArticleDraftGuarded(article, { blocks: restoredBlocks });
    await this.recordEvent(pieceId, actorId, 'version_restored');

    // Record the restore itself as a new version, so it shows up in the
    // history just like any other checkpoint.
    await this.snapshotArticleVersion(
      article,
      actorId,
      `Restored from ${version.createdAt.toISOString().slice(0, 10)}`,
    );

    return toArticleDraftResponse(article);
  }

  /**
   * The desk header's "current issue" summary (Magazine Desk Phase 7, Task
   * A2): the newest issue by display number (issue numbers are zero-padded
   * so a plain string sort is the highest number), how many of its slots
   * are filled, and how many slots exist in total. `null` when no issue has
   * been created yet, so the caller can keep the header honestly blank
   * rather than fabricate a placeholder issue.
   */
  async getCurrentIssueSummary(): Promise<CurrentIssueSummary | null> {
    const [issue] = await this.issues.find({
      order: { number: 'DESC' },
      take: 1,
    });
    if (!issue) {
      return null;
    }

    const [filled, sections] = await Promise.all([
      this.pieces.count({ where: { issueId: issue.id } }),
      this.sections.find(),
    ]);
    const slots = sections.reduce(
      (total, section) => total + section.target,
      0,
    );

    return {
      id: issue.id,
      number: issue.number,
      theme: issue.theme,
      filled,
      slots,
    };
  }

  /**
   * Every issue, newest first, for the desk's issue switcher and the
   * new-issue modal's suggested next number. `filled` is that issue's
   * assigned-piece count; `slots` is the shared section-target sum (the same
   * value for every issue, so the sections are read once, never per issue).
   *
   * Piece counts come from ONE grouped query rather than a `count()` per
   * issue — the switcher renders the whole archive, and an issue-per-query
   * loop would grow linearly with every issue ever shipped.
   */
  async listIssuesForDesk(): Promise<IssueSummaryResponse[]> {
    const [issues, sections] = await Promise.all([
      this.issues.find({ order: { number: 'DESC' } }),
      this.sections.find(),
    ]);
    if (issues.length === 0) {
      return [];
    }

    const slots = sections.reduce(
      (total, section) => total + section.target,
      0,
    );

    const countRows = await this.pieces
      .createQueryBuilder('piece')
      .select('piece.issueId', 'issueId')
      .addSelect('COUNT(*)', 'filled')
      .where('piece.issueId IN (:...issueIds)', {
        issueIds: issues.map((issue) => issue.id),
      })
      .groupBy('piece.issueId')
      .getRawMany<{ issueId: string; filled: string }>();
    // `COUNT(*)` comes back as a string from `pg` (bigint), never a number.
    const filledByIssueId = new Map(
      countRows.map((row) => [row.issueId, Number(row.filled)]),
    );

    return issues.map((issue) => ({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      theme: issue.theme,
      publishedOn: issue.publishedOn,
      filled: filledByIssueId.get(issue.id) ?? 0,
      slots,
    }));
  }

  /**
   * Creates an issue from the desk's "New issue" modal. `number` arrives
   * already zero-padded by `CreateIssueDto`'s `@Transform`, so the uniqueness
   * check and the stored value agree on the same normalized form ("1" and
   * "01" are the same issue, and only one of them can exist).
   *
   * The production-only fields (`runOrder`, `digest`, `coverlines`,
   * `coverUrl`) are left at their column defaults: they belong to the
   * issue-production page, and pre-filling them here would give an empty
   * issue a cover checklist that looks half-done.
   */
  async createIssue(
    dto: CreateIssueDto,
    actorId: string,
  ): Promise<IssueSummaryResponse> {
    const existing = await this.issues.findOne({
      where: { number: dto.number },
    });
    if (existing) {
      throw new ConflictException(`Issue ${dto.number} already exists`);
    }

    const issue = this.issues.create({
      number: dto.number,
      title: dto.title,
      theme: dto.theme,
      // NULL, not today's date: an unscheduled issue must read as unscheduled
      // everywhere rather than quietly claiming a publish day nobody chose.
      publishedOn: dto.publishedOn ?? null,
      dek: dto.dek ?? '',
      coverUrl: null,
    });
    await this.issues.save(issue);

    this.logger.log(
      `Magazine issue ${issue.number} created by user ${actorId}`,
    );

    const sections = await this.sections.find();
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      theme: issue.theme,
      publishedOn: issue.publishedOn,
      filled: 0,
      slots: sections.reduce((total, section) => total + section.target, 0),
    };
  }

  /**
   * Moves a batch of pieces onto one issue, or (with `issueId: null`) detaches
   * them back to the unassigned pool. Backs the desk's bulk-assign bar.
   *
   * One `UPDATE` for the whole batch instead of a save-per-piece: the batch
   * either lands or does not, so a half-assigned selection can never leave the
   * desk showing some rows moved and some not. The per-piece audit events are
   * written afterwards in one `save()` of the whole array.
   *
   * Unknown piece ids are ignored rather than rejected — a stale desk tab can
   * hold a selection containing a piece another editor has since deleted, and
   * failing the entire batch over one dead row would be worse than assigning
   * the rest. The count of rows actually moved is returned so the caller can
   * report what happened.
   */
  async assignPiecesToIssue(
    dto: AssignIssueDto,
    actorId: string,
  ): Promise<{ assigned: number; issueNumber: string | null }> {
    let issue: MagazineIssue | null = null;
    if (dto.issueId !== null) {
      issue = await this.issues.findOne({ where: { id: dto.issueId } });
      if (!issue) {
        throw new NotFoundException('Issue not found');
      }
    }

    const pieces = await this.pieces.find({
      where: { id: In(dto.pieceIds) },
    });
    // Already on the target issue: skip, so a re-run of the same bulk action
    // does not write a second identical audit event per piece.
    const movingPieces = pieces.filter(
      (piece) => piece.issueId !== (issue?.id ?? null),
    );
    if (movingPieces.length === 0) {
      return { assigned: 0, issueNumber: issue?.number ?? null };
    }

    await this.pieces.update(
      { id: In(movingPieces.map((piece) => piece.id)) },
      { issueId: issue?.id ?? null },
    );

    const events = movingPieces.map((piece) =>
      this.pieceEvents.create({
        pieceId: piece.id,
        actorId,
        action: issue ? 'issue_assigned' : 'issue_detached',
        detail: issue ? `issue ${issue.number}` : null,
      }),
    );
    await this.pieceEvents.save(events);

    return {
      assigned: movingPieces.length,
      issueNumber: issue?.number ?? null,
    };
  }

  /**
   * The editor desk's archive search (Magazine Desk Phase 7, Task B1):
   * published articles and decks (`publishedAt IS NOT NULL`) whose title,
   * byline, or tags match `query` — an empty `query` skips the text filter
   * entirely and just returns the most recently published items, so the
   * ArchiveTab has something to show before anyone types. Both entity kinds
   * are queried independently (an article's byline lives on the joined
   * `MagazineAuthor`; a deck's is inline), then merged and re-sorted by
   * publish date so the combined page reads newest-first regardless of
   * which kind a row came from.
   */
  async searchArchive(query: string): Promise<ArchiveEntryResponse[]> {
    const trimmedQuery = query.trim();

    const [articleRows, deckRows] = await Promise.all([
      this.searchPublishedArticlesForArchive(trimmedQuery),
      this.searchPublishedDecksForArchive(trimmedQuery),
    ]);

    const authorIds = [
      ...new Set(articleRows.map((article) => article.authorId)),
    ];
    const issueIds = [
      ...new Set(
        articleRows
          .map((article) => article.issueId)
          .filter((issueId): issueId is string => issueId !== null),
      ),
    ];
    const [authorRows, issueRows] = await Promise.all([
      authorIds.length
        ? this.authors.find({ where: { id: In(authorIds) } })
        : Promise.resolve([]),
      issueIds.length
        ? this.issues.find({ where: { id: In(issueIds) } })
        : Promise.resolve([]),
    ]);
    const authorNameById = new Map(
      authorRows.map((author) => [author.id, author.name]),
    );
    const issueNumberById = new Map(
      issueRows.map((issue) => [issue.id, issue.number]),
    );

    const dated: { publishedAt: Date; entry: ArchiveEntryResponse }[] = [
      ...articleRows.map((article) => ({
        // Non-null: both archive queries filter to `published_at IS NOT
        // NULL` in SQL.
        publishedAt: article.publishedAt as Date,
        entry: toArchiveEntryFromArticle(
          article,
          authorNameById.get(article.authorId) ?? '',
          article.issueId
            ? (issueNumberById.get(article.issueId) ?? null)
            : null,
        ),
      })),
      ...deckRows.map((deck) => ({
        publishedAt: deck.publishedAt as Date,
        entry: toArchiveEntryFromDeck(deck),
      })),
    ];

    return dated
      .sort(
        (left, right) =>
          right.publishedAt.getTime() - left.publishedAt.getTime(),
      )
      .slice(0, ARCHIVE_SEARCH_LIMIT)
      .map((row) => row.entry);
  }

  /**
   * Seeded section config (spec §3.5), read-only in Phase 1. Not part of
   * `DeskSummary` (the Issue-plan gap counts that consume it are a later
   * surface) — exposed here so the `MagazineSection` repo this service
   * already needs isn't wired for nothing.
   */
  async listSections(): Promise<MagazineSection[]> {
    return this.sections.find({ order: { orderIndex: 'ASC' } });
  }

  /**
   * The issue-production read model for `/magazine/editor/issue/:number`
   * (Magazine Desk Phase 5, spec §7.5). `number` is the issue's public
   * display number (`MagazineIssue.number`, e.g. `"01"`), not its uuid.
   */
  async getIssueProduction(
    issueNumber: string,
  ): Promise<IssueProductionResponse> {
    const issue = await this.loadIssueOr404(issueNumber);
    const pieces = await this.pieces.find({ where: { issueId: issue.id } });
    return toIssueProduction(issue, pieces);
  }

  /**
   * Replaces the issue's running order wholesale (spec §7.5 Task 2). Also
   * syncs each referenced piece's `orderIndex` (its position in `dto.items`)
   * and `pages` so the piece list and the issue-production page never drift
   * apart. The audit trail is per-piece (`MagazinePieceEvent.pieceId` is
   * required), so a reorder with no pieces resolved skips the event
   * entirely rather than crediting an arbitrary piece.
   */
  async updateRunOrder(
    issueNumber: string,
    dto: UpdateRunOrderDto,
    actorId: string,
  ): Promise<IssueProductionResponse> {
    const issue = await this.loadIssueOr404(issueNumber);
    issue.runOrder = dto.items.map((item): IssueRunOrderItem => ({
      pieceId: item.pieceId,
      pages: item.pages,
    }));
    await this.issues.save(issue);

    const pieceIds = dto.items.map((item) => item.pieceId);
    if (pieceIds.length > 0) {
      const matchingPieces = await this.pieces.find({
        where: { id: In(pieceIds) },
      });
      const pieceById = new Map(
        matchingPieces.map((piece) => [piece.id, piece]),
      );

      const resolvedPieces: MagazinePiece[] = [];
      dto.items.forEach((item, index) => {
        const piece = pieceById.get(item.pieceId);
        if (!piece) {
          return;
        }
        piece.orderIndex = index;
        piece.pages = item.pages;
        resolvedPieces.push(piece);
      });

      const [firstResolvedPiece] = resolvedPieces;
      if (firstResolvedPiece) {
        await this.pieces.save(resolvedPieces);
        await this.recordEvent(
          firstResolvedPiece.id,
          actorId,
          'run_order_updated',
        );
      }
    }

    return this.getIssueProduction(issueNumber);
  }

  /**
   * Replaces the issue-panel/social curation wholesale (spec §7.5 Task 2) — a
   * straight jsonb overwrite, mirroring `updateCover` below.
   *
   * The `digest` column name is historical (CON-05 retired the members' email
   * digest); the data is now what the issue's public "In this issue" panel
   * renders, and `sendOnPublish` toggles the in-app announcement on ship.
   */
  async updateDigest(
    issueNumber: string,
    dto: UpdateDigestDto,
  ): Promise<IssueProductionResponse> {
    const issue = await this.loadIssueOr404(issueNumber);
    issue.digest = dto.items;
    if (dto.sendOnPublish !== undefined) {
      issue.digestSendOnPublish = dto.sendOnPublish;
    }
    await this.issues.save(issue);
    return this.getIssueProduction(issueNumber);
  }

  /**
   * Patches the cover art URL and/or coverlines (spec §7.5 Task 2). Both
   * fields are independently optional so the cover-art field and the
   * coverline inputs can each save on their own without clobbering the
   * other.
   */
  async updateCover(
    issueNumber: string,
    dto: UpdateCoverDto,
    requesterUserId: string,
  ): Promise<IssueProductionResponse> {
    const issue = await this.loadIssueOr404(issueNumber);
    // Foreign-upload backstop (M1): the cover handler keeps the interceptor's
    // shared-upload exemption (any `magazine_editor` re-saves an issue whose
    // cover a DIFFERENT editor uploaded), so a foreign key reaches here. Allow
    // it only when it is UNCHANGED (already the stored cover); a new foreign
    // reference is refused. Runs BEFORE any mutation.
    assertNoForeignUploadIntroduced(requesterUserId, dto.coverUrl, [
      issue.coverUrl,
    ]);
    Object.assign(issue, {
      ...(dto.coverUrl !== undefined ? { coverUrl: dto.coverUrl } : {}),
      ...(dto.coverlines !== undefined ? { coverlines: dto.coverlines } : {}),
    });
    await this.issues.save(issue);
    return this.getIssueProduction(issueNumber);
  }

  /**
   * Sets, moves, or clears the issue's publish date. The date is optional at
   * creation, so this is the surface that fills it in afterwards: a `null`
   * `publishedOn` un-schedules the issue again rather than being ignored,
   * which is why the DTO field is required-but-nullable instead of optional.
   *
   * Shipping is unaffected either way: `shipIssue` stamps today's date on an
   * issue that still has none.
   */
  async updateIssueSchedule(
    issueNumber: string,
    dto: UpdateIssueScheduleDto,
    actorId: string,
  ): Promise<IssueProductionResponse> {
    const issue = await this.loadIssueOr404(issueNumber);
    issue.publishedOn = dto.publishedOn;
    await this.issues.save(issue);
    this.logger.log(
      `Magazine issue ${issue.number} publish date set to ${
        dto.publishedOn ?? 'none'
      } by user ${actorId}`,
    );
    return this.getIssueProduction(issueNumber);
  }

  /**
   * PRD-106 — the issue's submission deadline, read on its own.
   *
   * Deliberately a one-field read rather than another column on
   * `IssueProductionResponse`: the desk's Cover & contents tab is the only
   * surface that edits it, and this keeps the whole feature to the two
   * endpoints beside it. `null` means the desk has set no deadline, which is
   * what the public submit-story form treats as "print no deadline line".
   */
  async getSubmissionDeadline(
    issueNumber: string,
  ): Promise<{ submissionDeadline: string | null }> {
    const issue = await this.loadIssueOr404(issueNumber);
    return { submissionDeadline: issue.submissionDeadline };
  }

  /**
   * PRD-106 — sets, moves, or clears the issue's submission deadline. `null`
   * clears it rather than being ignored (same required-but-nullable contract
   * as `updateIssueSchedule` above), because clearing is how an editor takes
   * the deadline line back off the public submit-story form.
   *
   * Nothing enforces an ordering against `publishedOn`. A desk closes
   * submissions weeks before an issue runs, but it also reopens a number, and
   * refusing a deadline that sits after the publish date would block a real
   * editorial move to protect nobody.
   */
  async updateSubmissionDeadline(
    issueNumber: string,
    dto: UpdateSubmissionDeadlineDto,
    actorId: string,
  ): Promise<{ submissionDeadline: string | null }> {
    const issue = await this.loadIssueOr404(issueNumber);
    issue.submissionDeadline = dto.submissionDeadline;
    await this.issues.save(issue);
    this.logger.log(
      `Magazine issue ${issue.number} submission deadline set to ${
        dto.submissionDeadline ?? 'none'
      } by user ${actorId}`,
    );
    return { submissionDeadline: issue.submissionDeadline };
  }

  /**
   * Ships the issue (spec §7.5 Task 2), stamping `publishedOn` with today's
   * date if it isn't set yet and then publishing the linked article/deck of
   * every piece that CLEARS THE SAME BAR the Publish button enforces. Runs
   * inside a transaction since it may touch the issue plus every piece's
   * linked content in one go.
   *
   * Two things this used to get wrong.
   *
   * PRD-126: it published at the instant of the click. Ship copy promises the
   * issue goes live together at 09:00 on the issue date, so an editor shipping
   * on Friday for a Monday issue put every article live on Friday while the
   * issue page itself stayed hidden until Monday. `publishAt` is now resolved
   * ONCE per ship by `resolveIssuePublishInstant`, and a future instant
   * schedules for free because the public read paths already gate on it.
   *
   * ENG-110: it published anything whose care gate was clear, whatever state
   * the piece was actually in. A piece still at `drafting` shipped
   * half-written with an empty standfirst, and a deck shipped with no
   * readiness check at all, because the standfirst/image-alt bar lived only on
   * the Publish button. A ship now publishes a piece only when it is at
   * `ready` (or already `published`), its care gate is clear, AND its format
   * readiness check passes. Everything else HOLDS and the ship SAYS SO:
   * `issue.lastShip` records what published, what held, and why, so an editor
   * who ships half an issue can see which half and what is missing rather than
   * finding out from a reader.
   */
  async shipIssue(
    issueNumber: string,
    actorId: string,
  ): Promise<IssueProductionResponse> {
    let shippedIssue!: MagazineIssue;
    let shippedPieces!: MagazinePiece[];
    // Collected inside the transaction, emitted after it commits: a bell that
    // did not ring must never roll back a ship.
    const wentLive: { piece: MagazinePiece; slug: string }[] = [];

    await this.dataSource.transaction(async (manager) => {
      const issueRepository = manager.getRepository(MagazineIssue);
      const pieceRepository = manager.getRepository(MagazinePiece);
      const articleRepository = manager.getRepository(MagazineArticle);
      const deckRepository = manager.getRepository(MagazineDeck);
      const eventRepository = manager.getRepository(MagazinePieceEvent);

      const issue = await issueRepository.findOne({
        where: { number: issueNumber },
      });
      if (!issue) {
        throw new NotFoundException('Issue not found');
      }

      if (!issue.publishedOn) {
        issue.publishedOn = todayIsoDate();
      }

      const pieces = await pieceRepository.find({
        where: { issueId: issue.id },
      });
      const shippedAt = new Date();
      const publishAt = resolveIssuePublishInstant(
        issue.publishedOn,
        shippedAt,
      );
      const isScheduledForFuture = publishAt.getTime() > shippedAt.getTime();

      const publishedPieceIds: string[] = [];
      const held: IssueShipHeldPiece[] = [];

      for (const piece of pieces) {
        const reasons: string[] = [];

        // A ship is a bulk Publish, so it answers to the same gate. Stage
        // first, because "still being written" is the reason an editor most
        // needs to read.
        if (piece.stage !== 'ready' && piece.stage !== 'published') {
          reasons.push(
            `Still at ${piece.stage.replace(/_/g, ' ')}; a ship only publishes a piece marked ready.`,
          );
        }
        for (const gateItem of computePublishGate(piece.care)) {
          if (!gateItem.done) {
            reasons.push(gateItem.label);
          }
        }

        const article = piece.articleId
          ? await articleRepository.findOne({ where: { id: piece.articleId } })
          : null;
        const deck = piece.deckId
          ? await deckRepository.findOne({ where: { id: piece.deckId } })
          : null;

        if (piece.format === 'deck') {
          if (deck === null) {
            reasons.push('The deck has not been started yet.');
          } else {
            reasons.push(...deckPublishBlockers(deck));
          }
        } else if (article === null) {
          reasons.push('The article has not been started yet.');
        } else {
          reasons.push(...articlePublishBlockers(article));
        }

        if (reasons.length > 0) {
          held.push({ pieceId: piece.id, title: piece.title, reasons });
          continue;
        }

        let didPublish = false;

        if (article !== null) {
          // Stamp the issue onto the article itself, not only the piece.
          // `magazine_piece` is desk-side workflow state that no public read
          // touches; the public issue page resolves its contents from
          // `magazine_article.issueId` (see
          // `MagazineService.getIssueByNumber`). Without this, shipping
          // published every article and left the issue's public contents
          // empty. Applied even when the article is already published, so
          // pulling a web-only piece into an issue still files it under that
          // issue.
          const needsIssueStamp = article.issueId !== issue.id;
          const needsPublishStamp = article.publishedAt === null;
          if (needsPublishStamp) {
            article.publishedAt = publishAt;
          }
          if (needsIssueStamp) {
            article.issueId = issue.id;
          }
          if (needsPublishStamp || needsIssueStamp) {
            await articleRepository.save(article);
          }
          didPublish = needsPublishStamp;
        }

        if (deck !== null && deck.publishedAt === null) {
          deck.publishedAt = publishAt;
          await deckRepository.save(deck);
          didPublish = true;
        }

        if (!didPublish) {
          continue;
        }

        publishedPieceIds.push(piece.id);

        // A SCHEDULED ship leaves the stage at `ready`: nothing is live yet,
        // and a writer reading "Published" on a piece no reader can open would
        // be a lie the desk told itself.
        if (!isScheduledForFuture && piece.stage !== 'published') {
          piece.stage = 'published';
          await pieceRepository.save(piece);
        }

        const event = eventRepository.create({
          pieceId: piece.id,
          actorId,
          action: 'issue_shipped',
          detail: `issue ${issue.number}`,
        });
        await eventRepository.save(event);

        if (!isScheduledForFuture) {
          const slug = piece.format === 'deck' ? deck?.slug : article?.slug;
          if (slug) {
            wentLive.push({ piece, slug });
          }
        }
      }

      issue.lastShip = {
        shippedAt: shippedAt.toISOString(),
        publishAt: publishAt.toISOString(),
        publishedPieceIds,
        held,
      } satisfies IssueLastShip;
      await issueRepository.save(issue);

      shippedIssue = issue;
      shippedPieces = pieces;
    });

    // PRD-121, outside the transaction for the same reason the announcement
    // is: a writer's bell is best-effort and must never roll back a ship.
    for (const { piece, slug } of wentLive) {
      await this.notifyWriterOfPiece(
        piece,
        actorId,
        NotificationType.MagazinePiecePublished,
        { href: toPiecePublicHref(piece.format, slug) },
      );
    }

    // Outside the transaction, deliberately: the announcement is best-effort
    // fan-out across the whole membership and must never hold the
    // piece-publishing transaction open (or roll it back).
    // `announceIssueIfScheduled` re-checks `digestSentAt` itself, so this is
    // safe to call on every ship — it only ever announces once.
    await this.announceIssueIfScheduled(shippedIssue);

    return toIssueProduction(shippedIssue, shippedPieces);
  }

  /**
   * CON-05. The real dispatch behind the issue panel's "announce with the
   * issue" toggle. Fires from `shipIssue` right after a ship actually
   * publishes pieces — there is no cron in this module, so shipping IS the
   * scheduled moment.
   *
   * THIS USED TO SEND EMAIL. Shipping emitted `newsletter.digest_due`, which
   * wrote one ledger row per confirmed newsletter subscriber, and a
   * once-a-minute cron in the newsletter module drained that queue out through
   * an outbound mail transport. QueerPulse delivers no email and never will, so
   * shipping an issue would have started mailing members. The queue, the cron,
   * the `digest`/`digest_test` templates and the transport itself are all
   * deleted; this is the replacement, and it is in-app only.
   *
   * The desk's curation work survives untouched: the `digest` jsonb (the
   * curated order and the per-piece blurbs) is what
   * `MagazineIssueContentsService` renders on the issue's public page, which
   * is where this notification deep-links.
   *
   * ONE announcement per issue, ever. `digestSentAt === null` is the guard —
   * the issue's publish gate can be hit more than once as later pieces clear
   * it, and a re-ship must not re-ring every member's bell. Failures are
   * swallowed: the issue has already shipped and its pieces are already
   * published by the time this runs, and a bell that did not ring is never
   * worth failing a ship over.
   */
  private async announceIssueIfScheduled(issue: MagazineIssue): Promise<void> {
    if (!issue.digestSendOnPublish || issue.digestSentAt !== null) {
      return;
    }

    try {
      // Everyone who can read the magazine. `isSystem` accounts (the
      // QueerPulse house account) are excluded — nobody reads their bell.
      const recipientRows = await this.users.find({
        where: { status: UserStatus.Active, isSystem: false },
        select: { id: true },
      });
      const recipientIds = recipientRows.map((row) => row.id);
      const payload = {
        source: 'magazine',
        issueNumber: issue.number,
        issueTitle: issue.title,
      };
      // Chunked, like every other membership-wide fan-out: one multi-row
      // INSERT per chunk rather than a create per member.
      for (
        let offset = 0;
        offset < recipientIds.length;
        offset += ISSUE_ANNOUNCE_CHUNK_SIZE
      ) {
        await this.notifications.createForRecipients(
          recipientIds.slice(offset, offset + ISSUE_ANNOUNCE_CHUNK_SIZE),
          NotificationType.MagazineIssuePublished,
          payload,
        );
      }
      // Stamped only after the fan-out completed, so a crash mid-announce
      // leaves the issue re-announceable rather than silently half-announced.
      issue.digestSentAt = new Date();
      await this.issues.save(issue);
      this.logger.log(
        `Announced issue ${issue.number} to ${recipientIds.length} member(s)`,
      );
    } catch (error) {
      this.logger.warn(
        `Issue ${issue.number} announcement fan-out failed: ${String(error)}`,
      );
    }
  }

  /**
   * CNT-6 "Convert": one-way, one-time transform of a deck-format piece into
   * an article-format one. Looked up by `deckId` (not `pieceId`) since the
   * deck editor page only ever knows the deck's own id — never the piece's
   * (`DeckEditorPage`/`PieceRecordPage` link to it as `?id=<deckId>`).
   * `piece.articleId !== null` is the idempotency guard: a piece can only be
   * converted once, and the orphaned `MagazineDeck` row is deliberately left
   * alone (not deleted) in case of a future undo. Uses the same
   * slug-allocation and byline-resolution helpers as `ensureArticleForPiece`
   * so a converted article behaves identically to one drafted from scratch.
   */
  async convertDeckToArticle(
    deckId: string,
    actorId: string,
  ): Promise<{
    pieceId: string;
    articleId: string;
    droppedSlideKinds: string[];
  }> {
    const deck = await this.decks.findOne({ where: { id: deckId } });
    if (!deck) {
      throw new NotFoundException('Deck not found');
    }

    const piece = await this.pieces.findOne({ where: { deckId } });
    if (!piece) {
      throw new NotFoundException('No piece links to this deck.');
    }
    if (piece.articleId !== null) {
      throw new ConflictException(
        'This piece has already been converted to an article.',
      );
    }

    const { blocks, droppedSlideKinds } = mapDeckSlidesToArticleBlocks(
      deck.slides,
    );

    const authorId = await this.resolveAuthorId(piece.byline, piece.writerId);
    const slug = await allocateUniqueSlug(
      slugify(piece.title, 'draft'),
      async (candidate) =>
        (await this.articles.findOne({ where: { slug: candidate } })) !== null,
    );

    const article = this.articles.create({
      slug,
      title: piece.title,
      dek: '',
      body: '',
      standfirst: '',
      kicker: deck.kicker,
      section: deck.section || piece.section,
      contentNotes: [],
      blocks,
      authorId,
      issueId: piece.issueId,
      tags: deck.tags,
      readMinutes: 1,
      publishedAt: null,
      // Set explicitly rather than left to the column default, so the
      // in-memory row a caller keeps editing already carries the base version
      // `saveArticleDraftGuarded` will match on.
      version: 0,
    });
    await this.articles.save(article);

    piece.articleId = article.id;
    piece.deckId = null;
    piece.format = 'article';
    await this.pieces.save(piece);

    await this.recordEvent(
      piece.id,
      actorId,
      'converted_to_article',
      droppedSlideKinds.length > 0
        ? `dropped: ${droppedSlideKinds.join(', ')}`
        : null,
    );

    return { pieceId: piece.id, articleId: article.id, droppedSlideKinds };
  }

  // --- writer workspace (Magazine Desk Phase 6, Task 2) ---
  //
  // Every method below takes `writerId` (the authenticated writer's id, read
  // from the controller's `@CurrentUser()`) and scopes its query to it —
  // a writer must never be able to read or mutate another contributor's
  // piece/pitch/payment. Ownership on the two mutations (`updateMyByline`,
  // `fileDraft`) is asserted a second time against the loaded row (not just
  // trusted from the query filter), since both load by piece id first.

  /**
   * A writer's own commissioned work (spec §7.6 "Your work" tab). Scoped to
   * `piece.writerId === writerId` at the query level, so a piece assigned to
   * a different writer is never even loaded, let alone returned.
   */
  async listMyAssignments(
    writerId: string,
  ): Promise<WriterAssignmentResponse[]> {
    const myPieces = await this.pieces.find({
      where: { writerId },
      order: { createdAt: 'DESC' },
    });

    // ENG-114: one batched payment query for the whole page. This used to run
    // `payments.findOne` per piece inside a `Promise.all`, so a prolific
    // writer's workspace fired N+1 queries every time it opened AND again on
    // every mutation's invalidation.
    const paymentByPieceId = await this.loadPaymentsByPieceId(
      myPieces.map((piece) => piece.id),
    );

    return myPieces.map((piece) =>
      toWriterAssignment(piece, paymentByPieceId.get(piece.id) ?? null),
    );
  }

  /**
   * A writer's own pitches (spec §7.6 "Your pitches" tab). Scoped to
   * `pitch.submitterId === writerId` — pitches with no `submitterId` (e.g.
   * seeded/external pitches, see the entity's doc comment) never match.
   */
  async listMyPitches(writerId: string): Promise<WriterPitchResponse[]> {
    const myPitches = await this.pitches.find({
      where: { submitterId: writerId },
      order: { createdAt: 'DESC' },
    });
    return myPitches.map(toWriterPitch);
  }

  /**
   * Submits a new pitch from the writer workspace (spec §7.6 "Pitch
   * something"). `submitterId` is stamped from the authenticated writer, not
   * taken from the request body, so a writer can never submit a pitch on
   * another contributor's behalf. `from` is left blank — the editor desk
   * resolves a display name for the writer elsewhere — mirroring the
   * `WriterPitchResponse`/`toWriterPitch` mapper, which never reads `from`.
   */
  async submitPitch(
    writerId: string,
    dto: SubmitPitchDto,
  ): Promise<WriterPitchResponse> {
    const pitch = this.pitches.create({
      title: dto.title,
      from: '',
      note: dto.note,
      tags: dto.tags ?? [],
      suggestFormat: null,
      status: 'waiting',
      fresh: false,
      issueId: null,
      submitterId: writerId,
    });
    await this.pitches.save(pitch);
    return toWriterPitch(pitch);
  }

  /**
   * A writer's own payments (spec §7.6 "Payments" tab). Scoped the same way
   * as `listMyAssignments` — a piece with no payment row yet is still
   * surfaced (via `toWriterPayment(piece, null)`) so a writer can see a fee
   * hasn't been agreed rather than the row silently disappearing.
   */
  async listMyPayments(writerId: string): Promise<WriterPaymentResponse[]> {
    const myPieces = await this.pieces.find({
      where: { writerId },
      order: { createdAt: 'DESC' },
    });

    // ENG-114 again, plus the issue batch `toWriterPayment` needs: a piece
    // carries only `issueId`, and without the issue row the payments tab reads
    // "Unscheduled" for work that is scheduled. Two queries for the whole page,
    // whatever its length.
    const [paymentByPieceId, issueById] = await Promise.all([
      this.loadPaymentsByPieceId(myPieces.map((piece) => piece.id)),
      this.loadIssuesById(
        myPieces
          .map((piece) => piece.issueId)
          .filter((issueId): issueId is string => issueId !== null),
      ),
    ]);

    return myPieces.map((piece) =>
      toWriterPayment(
        piece,
        paymentByPieceId.get(piece.id) ?? null,
        piece.issueId === null ? null : (issueById.get(piece.issueId) ?? null),
      ),
    );
  }

  /**
   * Every piece's payment row in one query, keyed by `pieceId`. A piece with no
   * payment row agreed yet is simply absent from the map, which both writer
   * lists render as "not agreed" rather than dropping the row.
   *
   * `In([])` is never issued: an empty id list short-circuits, since a writer
   * with no assignments should cost zero queries.
   */
  private async loadPaymentsByPieceId(
    pieceIds: string[],
  ): Promise<Map<string, MagazinePayment>> {
    if (pieceIds.length === 0) {
      return new Map();
    }
    const rows = await this.payments.find({
      where: { pieceId: In(pieceIds) },
    });
    return new Map(rows.map((payment) => [payment.pieceId, payment]));
  }

  /** The issue rows for a page of pieces, in one query, keyed by id. Same
   *  empty-list short circuit as `loadPaymentsByPieceId`. */
  private async loadIssuesById(
    issueIds: string[],
  ): Promise<Map<string, MagazineIssue>> {
    const uniqueIssueIds = [...new Set(issueIds)];
    if (uniqueIssueIds.length === 0) {
      return new Map();
    }
    const rows = await this.issues.find({
      where: { id: In(uniqueIssueIds) },
    });
    return new Map(rows.map((issue) => [issue.id, issue]));
  }

  /**
   * Sets the writer's own byline (spec §7.6 "Byline safety"). Ownership is
   * asserted against the loaded piece (`ForbiddenException`, not
   * `NotFoundException`, so a writer probing another contributor's piece id
   * gets an unambiguous "not yours" rather than a leaked "doesn't exist"
   * that would let them distinguish valid ids by response shape) — the byline
   * also locks once the piece reaches `ready`, since layout has already run
   * with whatever byline was set at that point.
   */
  async updateMyByline(
    writerId: string,
    pieceId: string,
    dto: UpdateBylineDto,
  ): Promise<WriterAssignmentResponse> {
    const piece = await this.loadPieceOr404(pieceId);
    if (piece.writerId !== writerId) {
      throw new ForbiddenException('This piece is not assigned to you.');
    }
    if (piece.stage === 'ready') {
      throw new ForbiddenException(
        'The byline is locked once the piece is ready.',
      );
    }

    piece.byline = dto.byline;
    await this.pieces.save(piece);

    const payment = await this.payments.findOne({ where: { pieceId } });
    return toWriterAssignment(piece, payment);
  }

  /**
   * Files a draft (spec §7.6 "File a draft" action): moves the piece to
   * `in_review` when it's currently `drafting` or `commissioned`, and
   * records a `filed` audit event. Ownership is asserted the same way as
   * `updateMyByline`. A piece already past those two stages (already
   * `in_review`/beyond) is left as-is rather than erroring, so a duplicate
   * or out-of-order file action is a harmless no-op instead of a crash.
   *
   * `dto?.blocks` (CNT-6 audit follow-up): `FileDraftModal`'s "paste your
   * draft" textarea used to be captured into state and discarded — a real
   * data-loss bug. When present, these are already-converted paragraph
   * blocks (the frontend splits the pasted text on blank lines, same rule
   * `ArticleDocument`'s in-editor paste uses), validated here exactly like
   * `updateArticleDraft`'s `blocks` patch. Lazily creates the article row via
   * `ensureArticleForPiece` if the piece doesn't have one yet, same as
   * `updateArticleDraft`. This intentionally goes through the writer-scoped
   * `MagazineWriterController`, not the editor-only
   * `PATCH /magazine/admin/pieces/:id/article` — a plain writer (no
   * `magazine_editor` staff role) can't reach that admin route.
   *
   * `dto?.mode` decides how the filed blocks meet the draft that already
   * exists (PRD-122):
   *
   *   - `append` (the default) adds them after what is there, MINUS any run
   *     the draft already ends with. See `appendFiledBlocks` — this is what
   *     makes a refile idempotent. The old dedup compared block IDS, which
   *     could never match: `createParagraphBlocks` mints a fresh
   *     `crypto.randomUUID()` for every block on every call, so a second
   *     filing of the same text silently doubled the article.
   *   - `replace` makes the filed blocks the whole body, which is the only
   *     way a writer can correct a draft they already filed. The pre-replace
   *     body is snapshotted first (`"Before refile"`), so an editor's work is
   *     always recoverable from the VersionsRail.
   *
   * Both paths write through `saveArticleDraftGuarded`, so a filing that is
   * based on a version an editor has already moved past gets the same 409 the
   * editor's own autosave gets, carrying `expectedVersion` from
   * `GET /magazine/writer/pieces/:id/draft`.
   *
   * Also snapshots an article version (Magazine Desk Phase 7, Task E1,
   * label `"Filed draft"`) so the VersionsRail always has a checkpoint at
   * the moment a draft went to the editor — a piece with no article yet
   * (or no linked article row, defensively) simply skips the snapshot
   * rather than crashing the file action. The snapshot runs AFTER any pasted
   * blocks are applied, so it captures what was just filed.
   */
  async fileDraft(
    writerId: string,
    pieceId: string,
    dto?: FileDraftDto,
  ): Promise<WriterAssignmentResponse> {
    const piece = await this.loadPieceOr404(pieceId);
    if (piece.writerId !== writerId) {
      throw new ForbiddenException('This piece is not assigned to you.');
    }

    if (dto?.blocks !== undefined) {
      const filedBlocks = validateArticleBlocks(dto.blocks);
      const article = await this.ensureArticleForPiece(piece, writerId);
      this.assertArticleVersionCurrent(article, dto.expectedVersion);

      // Sanitized here as well as inside the guarded save, because the stored
      // blocks were sanitized on their way in: comparing raw incoming text
      // against sanitized stored text would never match, and the dedup below
      // would be as useless as the id comparison it replaces.
      const safeFiledBlocks = sanitizeArticleBlocks(filedBlocks);
      const nextBlocks =
        dto.mode === 'replace'
          ? this.replaceFiledBlocks(article.blocks, safeFiledBlocks)
          : this.appendFiledBlocks(article.blocks, safeFiledBlocks);

      if (nextBlocks !== null) {
        // A replace overwrites work this writer may not have seen (an editor's
        // line edits, an image block, a pull quote). Snapshot first so the
        // VersionsRail can put it back: a filing must never be the one write
        // in this service that loses something irrecoverably.
        if (dto.mode === 'replace' && article.blocks.length > 0) {
          await this.snapshotArticleVersion(article, writerId, 'Before refile');
        }
        await this.saveArticleDraftGuarded(article, { blocks: nextBlocks });
      }
    }

    if (piece.stage === 'drafting' || piece.stage === 'commissioned') {
      piece.stage = 'in_review';
      await this.pieces.save(piece);
    }
    await this.recordEvent(piece.id, writerId, 'filed');

    if (piece.articleId !== null) {
      const article = await this.articles.findOne({
        where: { id: piece.articleId },
      });
      if (article) {
        await this.snapshotArticleVersion(article, writerId, 'Filed draft');
        // PRD-127: record WHAT WAS FILED, in words, on the piece's brief. The
        // assignment card reads `brief.filedWords` for "Not filed yet" and for
        // the count against target, so without this a writer filed a draft and
        // then read their own card claiming nothing had been filed, while the
        // file modal promised the count was checked against the brief.
        // Counted off the article body itself rather than off the pasted
        // payload, so a writer who drafted in the block editor and filed with
        // no paste still gets a real number.
        const filedWords = countArticleWords(article.blocks);
        if (piece.brief?.filedWords !== filedWords) {
          // `brief` is ONE jsonb blob: spread it, never replace it, or the
          // angle, wants, rate, kill fee and commission record all vanish in
          // this save. `briefWithFiledWords` is the only way this is written.
          piece.brief = briefWithFiledWords(piece.brief, filedWords);
          await this.pieces.save(piece);
        }
      }
    }

    const payment = await this.payments.findOne({ where: { pieceId } });
    return toWriterAssignment(piece, payment);
  }

  /**
   * The article's blocks after an `append`-mode filing, or `null` when the
   * filing adds nothing and the write should be skipped entirely.
   *
   * PRD-122b. Filing has to be IDEMPOTENT: the route is a plain POST with no
   * idempotency key, so a network retry, a double click or a writer filing the
   * same pasted draft twice must not double the article. The previous guard
   * compared block IDS, which can never match: the client mints a fresh
   * `crypto.randomUUID()` for every block on every call
   * (`createParagraphBlocks`), so every incoming id was new by construction and
   * the "dedup" filtered nothing.
   *
   * So the comparison is on CONTENT. The rule is the classic overlap append:
   * find the longest suffix of the existing blocks that is also a prefix of the
   * filed run, and append only what comes after it. That covers the three real
   * cases in one pass:
   *
   *   - refiling the same draft: the existing blocks already END with the whole
   *     run, so nothing is appended and the second call is a true no-op;
   *   - refiling the same draft plus new paragraphs at the end: only the new
   *     paragraphs land;
   *   - filing genuinely new material: nothing overlaps, everything lands.
   *
   * The accepted cost: a filing whose FIRST paragraph is genuinely identical to
   * the draft's current LAST paragraph loses that one repeat. A writer who
   * needs the repeat can file it in `replace` mode, which never trims.
   */
  private appendFiledBlocks(
    existingBlocks: ArticleBlock[],
    filedBlocks: ArticleBlock[],
  ): ArticleBlock[] | null {
    if (filedBlocks.length === 0) {
      return null;
    }

    const existingKeys = existingBlocks.map((block) =>
      this.blockContentKey(block),
    );
    const filedKeys = filedBlocks.map((block) => this.blockContentKey(block));

    let overlap = Math.min(existingKeys.length, filedKeys.length);
    while (overlap > 0) {
      const isOverlap = filedKeys
        .slice(0, overlap)
        .every(
          (key, index) =>
            key === existingKeys[existingKeys.length - overlap + index],
        );
      if (isOverlap) {
        break;
      }
      overlap -= 1;
    }

    const additions = filedBlocks.slice(overlap);
    if (additions.length === 0) {
      return null;
    }

    // Ids stay unique inside the array even if a client ever does mint a stable
    // id: two blocks sharing an id break the editor's per-id block operations.
    const existingBlockIds = new Set(existingBlocks.map((block) => block.id));
    const uniqueAdditions = additions.filter(
      (block) => !existingBlockIds.has(block.id),
    );
    if (uniqueAdditions.length === 0) {
      return null;
    }

    return [...existingBlocks, ...uniqueAdditions];
  }

  /**
   * The article's blocks after a `replace`-mode filing, or `null` when the
   * draft already holds exactly this body (so a retried replace is a no-op too,
   * and costs neither a version bump nor a spurious snapshot).
   */
  private replaceFiledBlocks(
    existingBlocks: ArticleBlock[],
    filedBlocks: ArticleBlock[],
  ): ArticleBlock[] | null {
    // Replacing a draft with nothing is never what a filing means: the modal
    // sends `blocks` only when the writer typed something, so an empty array
    // here is a malformed call, and honouring it would empty the article.
    if (filedBlocks.length === 0) {
      return null;
    }
    const isUnchanged =
      existingBlocks.length === filedBlocks.length &&
      existingBlocks.every(
        (block, index) =>
          this.blockContentKey(block) ===
          this.blockContentKey(filedBlocks[index] as ArticleBlock),
      );
    return isUnchanged ? null : filedBlocks;
  }

  /**
   * A block's content as a comparable string, with its `id` dropped (the id is
   * exactly the part that differs between a filing and its retry) and object
   * keys SORTED. Sorting matters: `blocks` round-trips through a jsonb column,
   * and Postgres jsonb does not preserve key order, so a plain
   * `JSON.stringify` would call a stored block and the identical incoming
   * block different.
   */
  private blockContentKey(block: ArticleBlock): string {
    const content: Record<string, unknown> = { ...block };
    delete content.id;
    return this.canonicalJson(content);
  }

  /** `JSON.stringify` with object keys sorted at every depth, so two
   *  structurally equal values always produce the same string. Used only for
   *  comparison, never for storage. */
  private canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => this.canonicalJson(entry)).join(',')}]`;
    }
    if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
      return `{${entries
        .map(
          ([key, entryValue]) =>
            `${JSON.stringify(key)}:${this.canonicalJson(entryValue)}`,
        )
        .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  }

  /**
   * The writer's own view of their article draft
   * (`GET /magazine/writer/pieces/:id/draft`, PRD-122a).
   *
   * Scoped and asserted exactly like `updateMyByline`/`fileDraft`: loaded by
   * piece id, then refused with `ForbiddenException` unless the piece is this
   * writer's. The writer id is the authenticated one from the controller,
   * never a client-supplied value.
   *
   * Deliberately does NOT create the article row the way the editor's
   * `getArticleDraft` does. A read by a writer should not write: a piece with
   * no draft yet answers `hasDraft: false` with `version: 0`, which is the base
   * version `ensureArticleForPiece` creates the row at, so the filing that
   * follows still lines up with the optimistic-concurrency check.
   */
  async getMyDraft(
    writerId: string,
    pieceId: string,
  ): Promise<WriterDraftResponse> {
    const piece = await this.loadPieceOr404(pieceId);
    if (piece.writerId !== writerId) {
      throw new ForbiddenException('This piece is not assigned to you.');
    }

    const article =
      piece.articleId === null
        ? null
        : await this.articles.findOne({ where: { id: piece.articleId } });

    return toWriterDraft(piece, article);
  }

  // --- piece message thread / editor↔writer (Magazine Desk Phase 7, Task F1) ---
  //
  // SECURITY IS THE THEME: a per-piece message thread is visible/postable
  // ONLY to (a) the assigned editor/admin (the editor surface always passes
  // `isEditor: true`) or (b) the assigned writer of that piece
  // (`piece.writerId === userId`). Enforced here, server-side, in
  // `assertPieceThreadAccess` — never left to the controller/guard alone —
  // exactly mirroring how `updateMyByline`/`fileDraft` assert
  // `piece.writerId === writerId` above.

  /**
   * Throws `ForbiddenException` unless the caller is the editor/admin surface
   * (`isEditor: true`) or the piece's own assigned writer. `NotFound` for a
   * missing piece is asserted by the caller via `loadPieceOr404` before this
   * runs, so this never has to distinguish "no piece" from "not yours" — it
   * only ever answers the access question for a piece that exists.
   */
  private assertPieceThreadAccess(
    piece: MagazinePiece,
    userId: string,
    isEditor: boolean,
  ): void {
    if (isEditor) {
      return;
    }
    if (piece.writerId !== userId) {
      throw new ForbiddenException(
        'This piece thread is not accessible to you.',
      );
    }
  }

  /**
   * The full thread for a piece (chat order — oldest first), gated by
   * `assertPieceThreadAccess`. Author names are resolved with the same
   * batched editor-directory ∪ `Profile` lookup as `listArticleComments`;
   * `fromMe` is computed against `userId` (the
   * REQUESTING user), never a client-supplied flag.
   */
  async listPieceMessages(
    pieceId: string,
    userId: string,
    isEditor: boolean,
  ): Promise<PieceMessageResponse[]> {
    const piece = await this.loadPieceOr404(pieceId);
    this.assertPieceThreadAccess(piece, userId, isEditor);

    const messages = await this.pieceMessages.find({
      where: { pieceId },
      order: { createdAt: 'ASC' },
    });
    if (messages.length === 0) {
      return [];
    }

    const authorNameById = await this.resolveActorDisplayNames(
      messages.map((message) => message.authorId),
    );
    return messages.map((message) =>
      toPieceMessage(message, authorNameById, userId),
    );
  }

  /**
   * Posts a message to a piece's thread, gated the same way as
   * `listPieceMessages`, then notifies the OTHER party through the app's
   * normal notification path (`NotificationsService.create` —
   * `NotificationType.MagazinePieceMessage`, same infra every other
   * member-driven notification uses, no separate mechanism): if the author is
   * the editor, the recipient is the piece's assigned writer; if the author
   * is the writer, the recipient is the piece's assigned editor. A `null`
   * other-party id (an unassigned writer) skips the notification rather than
   * crashing the post. The notification is best-effort — its own try/catch,
   * same as `notifyStaffOfJoinRequest`/`notify()` elsewhere — so a failure to
   * write it never fails a message that already saved.
   */
  async postPieceMessage(
    pieceId: string,
    authorId: string,
    isEditor: boolean,
    dto: CreatePieceMessageDto,
  ): Promise<PieceMessageResponse> {
    const piece = await this.loadPieceOr404(pieceId);
    this.assertPieceThreadAccess(piece, authorId, isEditor);

    const message = this.pieceMessages.create({
      pieceId,
      authorId,
      body: dto.body,
    });
    await this.pieceMessages.save(message);

    const otherPartyId = isEditor ? piece.writerId : piece.editorId;
    if (otherPartyId !== null) {
      try {
        await this.notifications.create(
          otherPartyId,
          NotificationType.MagazinePieceMessage,
          { pieceId, messageId: message.id },
          authorId,
        );
      } catch (error) {
        this.logger.warn(
          `Failed to notify recipient ${otherPartyId} of piece ${pieceId} message: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const authorNameById = await this.resolveActorDisplayNames([authorId]);
    return toPieceMessage(message, authorNameById, authorId);
  }

  /**
   * Batched display-name resolution for any list of actor ids — the exact
   * same editor-directory-first, `Profile`-fallback technique as
   * `listArticleComments`, generalized to take an
   * explicit list of ids so the piece message thread (full read and a single
   * just-posted message) and the desk sidebar's activity feed all share it.
   */
  private async resolveActorDisplayNames(
    authorIds: string[],
  ): Promise<Map<string, string>> {
    const editors = await this.listMagazineEditors();
    const authorNameById = new Map(
      editors.map((editor) => [editor.id, editor.name]),
    );

    const unresolvedAuthorIds = [
      ...new Set(authorIds.filter((authorId) => !authorNameById.has(authorId))),
    ];
    if (unresolvedAuthorIds.length > 0) {
      const unresolvedProfiles = await this.profiles.find({
        where: { userId: In(unresolvedAuthorIds) },
      });
      for (const profile of unresolvedProfiles) {
        authorNameById.set(profile.userId, toActorDisplayName(profile));
      }
    }

    return authorNameById;
  }

  // --- internals ---

  /**
   * PRD-123 — display names for the accounts behind a page of pitches, in ONE
   * batched lookup for the whole page.
   *
   * A pitch submitted from inside the platform stores `from: ''` and carries
   * `submitterId` (see `submitPitch`, and `AdminStorySubmissionsService.decide`
   * for a commissioned member story). Nothing resolved that id, so the editor
   * inbox showed a blank byline on every internally-submitted pitch, and a
   * commission carried the blank straight onto the piece.
   *
   * Reuses `resolveActorDisplayNames`, which already checks the editor
   * directory before falling back to profiles, so a submitter who is also an
   * editor reads with the same name the rest of the desk shows them by.
   */
  private async resolvePitchSubmitterNames(
    pitches: MagazinePitch[],
  ): Promise<Map<string, string>> {
    const submitterIds = [
      ...new Set(
        pitches
          .map((pitch) => pitch.submitterId)
          .filter((submitterId): submitterId is string => submitterId !== null),
      ),
    ];
    if (submitterIds.length === 0) {
      // `resolveActorDisplayNames` loads the whole editor directory before it
      // looks at anything, so skipping the call entirely matters on the common
      // case of an inbox holding only external pitches.
      return new Map();
    }
    return this.resolveActorDisplayNames(submitterIds);
  }

  private async commissionPitch(
    id: string,
    dto: TriagePitchDto,
    actorId: string,
  ): Promise<PieceRecord> {
    if (!dto.editorId) {
      throw new BadRequestException(
        'editorId is required to commission a pitch',
      );
    }
    if (!dto.section) {
      throw new BadRequestException(
        'section is required to commission a pitch',
      );
    }
    const editorId = dto.editorId;
    const section = dto.section;

    // PRD-123 — resolve the submitter's name BEFORE the transaction opens.
    //
    // Commissioning used to hard-code `writerId: null` and `byline: pitch.from`.
    // For a pitch submitted from inside the platform `from` is empty by design,
    // so every workspace pitch and every commissioned member story produced a
    // piece with a blank byline and no writer: it never appeared in that
    // person's assignments, and their own tracker read "Commissioned" with
    // nothing behind it.
    //
    // The lookup reads the editor directory and profiles, none of which the
    // transaction below writes, so it stays outside the write path for the same
    // reason `pieceRecordFor` does.
    const pitchBeforeCommission = await this.loadPitchOr404(id);
    const submitterId = pitchBeforeCommission.submitterId;
    const submitterName =
      submitterId === null
        ? null
        : ((await this.resolveActorDisplayNames([submitterId])).get(
            submitterId,
          ) ?? null);

    const { piece, events } = await this.dataSource.transaction(
      async (manager) => {
        const pitchRepository = manager.getRepository(MagazinePitch);
        const pieceRepository = manager.getRepository(MagazinePiece);
        const eventRepository = manager.getRepository(MagazinePieceEvent);

        const pitch = await pitchRepository.findOne({ where: { id } });
        if (!pitch) {
          throw new NotFoundException('Pitch not found');
        }
        // Guard against a double-submit/retry re-commissioning a pitch that's
        // already been triaged — without this, a duplicate MagazinePiece would
        // get created against the same pitchId.
        if (pitch.status !== 'waiting' && pitch.status !== 'maybe') {
          throw new ConflictException('This pitch has already been triaged.');
        }

        pitch.status = 'commissioned';
        await pitchRepository.save(pitch);

        const piece = pieceRepository.create({
          format: dto.format ?? pitch.suggestFormat ?? 'article',
          title: pitch.title,
          section,
          kind: null,
          stage: 'commissioned',
          editorId,
          // PRD-123 — the person who pitched IS the writer of the piece
          // commissioned from it. `null` here is what dropped them: the piece
          // never reached their assignments tab and `deriveWaitingOn` read the
          // commission as still owing an assignment. An external pitch has no
          // account, so it keeps `null` and the desk assigns a writer later,
          // exactly as before.
          writerId: pitch.submitterId,
          // The stored `from` still wins for an external pitch (free text the
          // editor typed). An internal one stores `from: ''`, so without the
          // resolved name the piece shipped with a blank byline.
          byline: submitterName ?? pitch.from,
          dueOn: dto.dueOn ?? null,
          issueId: pitch.issueId,
          wordTarget: dto.wordTarget ?? null,
          slideTarget: null,
          fresh: pitch.fresh,
          pitchId: pitch.id,
        });
        await pieceRepository.save(piece);

        const event = eventRepository.create({
          pieceId: piece.id,
          actorId,
          action: 'commissioned',
          detail: 'from pitch',
        });
        await eventRepository.save(event);

        const events = await eventRepository.find({
          where: { pieceId: piece.id },
          order: { createdAt: 'ASC' },
        });
        return { piece, events };
      },
    );

    // PRD-121/PRD-123 — now that a commission from an internal pitch carries a
    // real `writerId`, tell that person. `notifyWriterOfPiece` no-ops on an
    // external pitch (no writer) and on an editor commissioning their own
    // pitch, and it swallows its own failures, so a bell that cannot ring
    // never rolls back the commission.
    await this.notifyWriterOfPiece(
      piece,
      actorId,
      NotificationType.MagazinePieceCommissioned,
    );

    // Name resolution reads the editor directory and profiles — nothing the
    // transaction above wrote — so it stays outside the write path.
    return this.pieceRecordFor(piece, events);
  }

  private async recordEvent(
    pieceId: string,
    actorId: string | null,
    action: string,
    detail?: string | null,
    options?: { mergeWhileLatest?: boolean },
  ): Promise<void> {
    if (options?.mergeWhileLatest) {
      const latestOnPiece = await this.pieceEvents.findOne({
        where: { pieceId },
        order: { createdAt: 'DESC' },
      });
      if (
        latestOnPiece &&
        latestOnPiece.actorId === actorId &&
        latestOnPiece.action === action
      ) {
        latestOnPiece.detail = detail ?? null;
        latestOnPiece.createdAt = new Date();
        await this.pieceEvents.save(latestOnPiece);
        return;
      }
    }

    const event = this.pieceEvents.create({
      pieceId,
      actorId,
      action,
      detail: detail ?? null,
    });
    await this.pieceEvents.save(event);
  }

  private async eventsFor(pieceId: string): Promise<MagazinePieceEvent[]> {
    return this.pieceEvents.find({
      where: { pieceId },
      order: { createdAt: 'ASC' },
    });
  }

  private async lettersFor(pieceId: string): Promise<MagazineLetter[]> {
    return this.letters.find({
      where: { pieceId },
      order: { createdAt: 'DESC' },
    });
  }

  private async correctionsFor(pieceId: string): Promise<MagazineCorrection[]> {
    return this.corrections.find({
      where: { pieceId },
      order: { createdAt: 'DESC' },
    });
  }

  private async loadPieceOr404(id: string): Promise<MagazinePiece> {
    const piece = await this.pieces.findOne({ where: { id } });
    if (!piece) {
      throw new NotFoundException('Piece not found');
    }
    return piece;
  }

  private async loadPitchOr404(id: string): Promise<MagazinePitch> {
    const pitch = await this.pitches.findOne({ where: { id } });
    if (!pitch) {
      throw new NotFoundException('Pitch not found');
    }
    return pitch;
  }

  /** `number` is the issue's public display number, not its uuid. */
  private async loadIssueOr404(number: string): Promise<MagazineIssue> {
    const issue = await this.issues.findOne({ where: { number } });
    if (!issue) {
      throw new NotFoundException('Issue not found');
    }
    return issue;
  }

  /**
   * Published articles for `searchArchive`, optionally filtered by title,
   * byline (joined `MagazineAuthor.name`), or tag — mirrors
   * `MagazineService.searchByText`'s `published_at <= now` shape exactly
   * (NOT just `IS NOT NULL`): `publishArticle` can stamp `publishedAt` with a
   * FUTURE instant to schedule a piece, so a plain not-null check would leak
   * a scheduled-but-not-yet-live article into the archive early. Decks have
   * no scheduling path (`updateDeck` only ever stamps "now"), so
   * `searchPublishedDecksForArchive` below keeps the simpler `IS NOT NULL`.
   */
  private async searchPublishedArticlesForArchive(
    term: string,
  ): Promise<MagazineArticle[]> {
    const queryBuilder = this.articles
      .createQueryBuilder('article')
      .leftJoin(MagazineAuthor, 'author', 'author.id = article.author_id')
      .where('article.published_at IS NOT NULL')
      .andWhere('article.published_at <= :now', { now: new Date() });

    if (term.length > 0) {
      const pattern = `%${escapeLikeTerm(term)}%`;
      queryBuilder.andWhere(
        `(article.title ILIKE :pattern
          OR author.name ILIKE :pattern
          OR EXISTS (SELECT 1 FROM unnest(article.tags) AS tag WHERE tag ILIKE :pattern))`,
        { pattern },
      );
    }

    return queryBuilder
      .orderBy('article.published_at', 'DESC')
      .take(ARCHIVE_SEARCH_LIMIT)
      .getMany();
  }

  /** Published decks for `searchArchive` — see `searchPublishedArticlesForArchive`. */
  private async searchPublishedDecksForArchive(
    term: string,
  ): Promise<MagazineDeck[]> {
    const queryBuilder = this.decks
      .createQueryBuilder('deck')
      .where('deck.published_at IS NOT NULL');

    if (term.length > 0) {
      const pattern = `%${escapeLikeTerm(term)}%`;
      queryBuilder.andWhere(
        `(deck.title ILIKE :pattern
          OR deck.byline ILIKE :pattern
          OR EXISTS (SELECT 1 FROM unnest(deck.tags) AS tag WHERE tag ILIKE :pattern))`,
        { pattern },
      );
    }

    return queryBuilder
      .orderBy('deck.published_at', 'DESC')
      .take(ARCHIVE_SEARCH_LIMIT)
      .getMany();
  }

  /**
   * Resolves a single comment author's display name (editor directory first,
   * then a `Profile` fallback) for the single-row comment mutations
   * (`addArticleComment`/`replyToArticleComment`/`resolveArticleComment`).
   * `listArticleComments` does its own BATCHED version of this same
   * resolution (via `resolveActorDisplayNames`) since it resolves
   * many comments' authors at once; this is the one-off equivalent for a
   * single actor.
   */
  private async resolveCommentAuthorName(
    authorId: string | null,
  ): Promise<string> {
    if (authorId === null) {
      return FORMER_MEMBER_COMMENT_AUTHOR_LABEL;
    }

    const editors = await this.listMagazineEditors();
    const editor = editors.find((candidate) => candidate.id === authorId);
    if (editor) {
      return editor.name;
    }

    const profile = await this.profiles.findOne({
      where: { userId: authorId },
    });
    return profile
      ? toActorDisplayName(profile)
      : UNRESOLVED_COMMENT_AUTHOR_LABEL;
  }

  /**
   * Cheap pre-flight for the optimistic-concurrency precondition: refuses a
   * save whose client-declared base `expectedVersion` already disagrees with
   * the row we just loaded. `saveArticleDraftGuarded` re-checks the same thing
   * atomically — this only saves the losing request from doing work first.
   *
   * A caller that sends no `expectedVersion` is not refused here (see
   * `UpdateArticleDto.expectedVersion` for why it is still optional); it still
   * gets the load→write race closed by the guarded save.
   */
  private assertArticleVersionCurrent(
    article: MagazineArticle,
    expectedVersion: number | undefined,
  ): void {
    if (expectedVersion === undefined || expectedVersion === article.version) {
      return;
    }
    throw new ConflictException({
      message:
        'This draft changed since you loaded it. Reload to see the current version before saving again.',
      currentVersion: article.version,
    });
  }

  /**
   * Every image storage key referenced by an article: the social image plus
   * each image block's `src`. Blank values are dropped. Used as the
   * `alreadyStored` baseline for the M1 foreign-upload backstop, so a foreign
   * key already on the article (uploaded by another editor) is allowed while a
   * new foreign reference is refused.
   */
  private collectArticleImageRefs(
    socialImage: string | null | undefined,
    blocks: readonly ArticleBlock[],
  ): string[] {
    const refs: string[] = [];
    if (socialImage) {
      refs.push(socialImage);
    }
    for (const block of blocks) {
      if (block.kind === 'image' && block.src) {
        refs.push(block.src);
      }
    }
    return refs;
  }

  /**
   * The ONLY way the article draft body is written.
   *
   * Applies `patch` to `article` under an optimistic-concurrency precondition:
   * the row must still be at the version this request loaded. Two editors (or
   * an editor and the piece's writer filing a draft) autosaving the same
   * article otherwise overwrite each other's whole `blocks` array, and a tab
   * left open across a "Restore version" silently undoes the restore on its
   * next autosave. Autosaves are not snapshotted, so what is lost is gone.
   *
   * The conditional UPDATE and the save share ONE transaction on purpose. The
   * `UPDATE ... WHERE version = :baseVersion` takes the row lock, so a
   * concurrent request blocks on it, and by the time it is let through the
   * version no longer matches and it gets its 409 — rather than both requests
   * reading the same version, both passing, and one of them winning silently.
   */
  private async saveArticleDraftGuarded(
    article: MagazineArticle,
    patch: Partial<MagazineArticle>,
  ): Promise<void> {
    // Sanitize block rich text on the WRITE boundary (M3): this is the ONE
    // path that writes the draft body, so sanitizing `blocks` here guarantees
    // no unsanitized `html`/`q`/`caption` is ever persisted, whichever handler
    // supplied it (editor autosave, writer file-draft, version restore).
    const safePatch: Partial<MagazineArticle> =
      patch.blocks !== undefined
        ? { ...patch, blocks: sanitizeArticleBlocks(patch.blocks) }
        : patch;

    const baseVersion = article.version;
    const nextVersion = baseVersion + 1;

    const applied = await this.dataSource.transaction(async (manager) => {
      const articleRepository = manager.getRepository(MagazineArticle);
      const claim = await articleRepository.update(
        { id: article.id, version: baseVersion },
        { version: nextVersion },
      );
      if (claim.affected === 0) {
        return false;
      }
      Object.assign(article, safePatch, { version: nextVersion });
      await articleRepository.save(article);
      return true;
    });

    if (!applied) {
      throw new ConflictException({
        message:
          'This draft changed while you were saving. Reload to see the current version before saving again.',
      });
    }
  }

  private async loadArticleOr404(id: string): Promise<MagazineArticle> {
    const article = await this.articles.findOne({ where: { id } });
    if (!article) {
      throw new NotFoundException('Article not found');
    }
    return article;
  }

  private async loadArticleVersionOr404(
    id: string,
  ): Promise<MagazineArticleVersion> {
    const version = await this.articleVersions.findOne({ where: { id } });
    if (!version) {
      throw new NotFoundException('Article version not found');
    }
    return version;
  }

  /**
   * Writes one `MagazineArticleVersion` snapshot of `article`'s CURRENT
   * blocks (Magazine Desk Phase 7, Task E1). `structuredClone` deep-copies
   * `blocks` so the stored snapshot can never be mutated later just because
   * some other code still holds a reference to the same in-memory article —
   * a version must stay frozen at the moment it was taken. `authorId` is
   * `null` for a system-attributed snapshot (mirrors `recordEvent`'s
   * `actorId`), though every current call site passes a real actor.
   */
  private async snapshotArticleVersion(
    article: MagazineArticle,
    authorId: string | null,
    label: string,
  ): Promise<MagazineArticleVersion> {
    const version = this.articleVersions.create({
      articleId: article.id,
      label,
      authorId,
      blocks: structuredClone(article.blocks),
    });
    await this.articleVersions.save(version);
    return version;
  }

  /**
   * Resolves a batch of versions' `authorId`s to display names — the same
   * editor-directory-first, batched-`Profile`-fallback resolution as
   * `listArticleComments`, reused here rather than duplicated ad hoc. A
   * `null` `authorId` (a system/auto snapshot) is left out of the lookup;
   * `toArticleVersionSummary`/`toArticleVersionDetail` map that case to
   * `UNRESOLVED_VERSION_AUTHOR_LABEL` themselves.
   */
  private async resolveVersionAuthorNames(
    versions: MagazineArticleVersion[],
  ): Promise<Map<string, string>> {
    const editors = await this.listMagazineEditors();
    const authorNameById = new Map(
      editors.map((editor) => [editor.id, editor.name]),
    );

    const unresolvedAuthorIds = [
      ...new Set(
        versions
          .map((version) => version.authorId)
          .filter(
            (authorId): authorId is string =>
              authorId !== null && !authorNameById.has(authorId),
          ),
      ),
    ];
    if (unresolvedAuthorIds.length > 0) {
      const unresolvedProfiles = await this.profiles.find({
        where: { userId: In(unresolvedAuthorIds) },
      });
      for (const profile of unresolvedProfiles) {
        authorNameById.set(profile.userId, toActorDisplayName(profile));
      }
    }

    return authorNameById;
  }

  /**
   * Loads the piece's linked article, or lazily creates + links an empty
   * draft when it has none yet (spec §7.3 Task 3). `actorId` is `null` when
   * called from a read (`getArticleDraft`) — the auto-create audit event is
   * then system-attributed rather than crediting whoever happened to load
   * the page first.
   */
  private async ensureArticleForPiece(
    piece: MagazinePiece,
    actorId: string | null,
  ): Promise<MagazineArticle> {
    if (piece.articleId !== null) {
      return this.loadArticleOr404(piece.articleId);
    }

    const authorId = await this.resolveAuthorId(piece.byline, piece.writerId);
    const slug = await allocateUniqueSlug(
      slugify(piece.title, 'draft'),
      async (candidate) => {
        const existing = await this.articles.findOne({
          where: { slug: candidate },
        });
        return existing !== null;
      },
    );

    const article = this.articles.create({
      slug,
      title: piece.title,
      dek: '',
      body: '',
      standfirst: '',
      kicker: '',
      section: piece.section,
      contentNotes: [],
      blocks: [],
      authorId,
      issueId: piece.issueId,
      tags: [],
      readMinutes: 1,
      publishedAt: null,
      // See `convertDeckToArticle` — the in-memory row must carry its base
      // version, not `undefined`, for the guarded save to match on.
      version: 0,
    });
    await this.articles.save(article);

    piece.articleId = article.id;
    await this.pieces.save(piece);
    await this.recordEvent(piece.id, actorId, 'article_created');

    return article;
  }

  /**
   * Finds or creates the `MagazineAuthor` byline row for a piece's free-text
   * `byline` field. `MagazineArticle.authorId` is a NOT NULL foreign key to
   * `magazine_author`, but a commissioned `MagazinePiece` only ever carries a
   * `byline` string (spec §3.1), so there's no existing id to reuse. Keyed by
   * the slugified byline so the same writer's name resolves to the same
   * author row across pieces.
   *
   * CON-11: when the piece's assigned writer is a member whose display name
   * IS this byline, the row is linked to their account (`userId`), which is
   * what makes the byline a real person — the author page links to their
   * profile, their profile credits the piece, and they can edit their own
   * author bio. A byline that doesn't match stays free text, so a
   * non-member contributor and a pen name both keep working.
   */
  private async resolveAuthorId(
    byline: string,
    writerUserId: string | null,
  ): Promise<string> {
    const name = byline.trim().length > 0 ? byline.trim() : 'Staff writer';
    const slug = slugify(name, 'staff-writer');
    const memberUserId = await this.bylineMemberUserId(slug, writerUserId);

    const existing = await this.authors.findOne({ where: { slug } });
    if (existing) {
      // Backfill only: an existing link is left alone, so a staff editor's
      // deliberate link/unlink is never silently reversed by the next piece.
      if (memberUserId !== null && existing.userId === null) {
        existing.userId = memberUserId;
        await this.authors.save(existing);
      }
      return existing.id;
    }

    const author = this.authors.create({
      slug,
      name,
      bio: null,
      avatarUrl: null,
      userId: memberUserId,
    });
    await this.authors.save(author);
    return author.id;
  }

  /**
   * The member account to link a byline to, or `null` to leave it free text.
   *
   * Deliberately strict. `piece.writerId` alone is not enough: a desk editor
   * files under "Staff writer" or a photographer's name all the time, and
   * linking those to whoever happened to be assigned would credit the wrong
   * person on their own profile. So the byline must slugify to the same value
   * as the writer's own display name, and the member must not already hold a
   * different byline (`magazine_author.user_id` is uniquely indexed).
   */
  private async bylineMemberUserId(
    bylineSlug: string,
    writerUserId: string | null,
  ): Promise<string | null> {
    if (!writerUserId) return null;
    const profile = await this.profiles.findOne({
      where: { userId: writerUserId },
    });
    if (!profile) return null;
    if (slugify(toActorDisplayName(profile), 'member') !== bylineSlug) {
      return null;
    }
    const alreadyLinked = await this.authors.findOne({
      where: { userId: writerUserId },
    });
    if (alreadyLinked && alreadyLinked.slug !== bylineSlug) {
      return null;
    }
    return writerUserId;
  }
}
