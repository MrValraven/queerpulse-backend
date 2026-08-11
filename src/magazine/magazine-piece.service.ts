import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { CreateArticleCommentDto } from './dto/create-article-comment.dto';
import { CreateCorrectionDto } from './dto/create-correction.dto';
import { CreateLetterDto } from './dto/create-letter.dto';
import { CreatePieceDto } from './dto/create-piece.dto';
import { CreatePieceMessageDto } from './dto/create-piece-message.dto';
import { CreatePitchDto } from './dto/create-pitch.dto';
import { ListPiecesQuery, SavedViewId } from './dto/list-pieces.query';
import { ReplyArticleCommentDto } from './dto/reply-article-comment.dto';
import { ResolveArticleCommentDto } from './dto/resolve-article-comment.dto';
import { SubmitPitchDto } from './dto/submit-pitch.dto';
import { TriagePitchDto } from './dto/triage-pitch.dto';
import { UpdateArticleDto } from './dto/update-article.dto';
import { UpdateBylineDto } from './dto/update-byline.dto';
import { UpdateCoverDto } from './dto/update-cover.dto';
import { UpdateDigestDto } from './dto/update-digest.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { UpdatePieceDto } from './dto/update-piece.dto';
import { UpdateRunOrderDto } from './dto/update-run-order.dto';
import { MagazineArticle } from './entities/magazine-article.entity';
import { MagazineArticleComment } from './entities/magazine-article-comment.entity';
import { MagazineArticleVersion } from './entities/magazine-article-version.entity';
import { MagazineAuthor } from './entities/magazine-author.entity';
import { MagazineCorrection } from './entities/magazine-correction.entity';
import { MagazineDeck } from './entities/magazine-deck.entity';
import {
  IssueRunOrderItem,
  MagazineIssue,
} from './entities/magazine-issue.entity';
import { MagazineLetter } from './entities/magazine-letter.entity';
import { MagazinePayment } from './entities/magazine-payment.entity';
import { MagazinePieceEvent } from './entities/magazine-piece-event.entity';
import { MagazinePieceMessage } from './entities/magazine-piece-message.entity';
import { MagazinePiece } from './entities/magazine-piece.entity';
import { MagazinePitch } from './entities/magazine-pitch.entity';
import { MagazineSection } from './entities/magazine-section.entity';
import {
  ArchiveEntryResponse,
  ArticleDraftResponse,
  computePublishGate,
  CorrectionResponse,
  CurrentIssueSummary,
  deriveLate,
  deriveWaitingOn,
  DeskSummary,
  IssueProductionResponse,
  LetterResponse,
  MagazineEditorResponse,
  MagazineNotificationResponse,
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
  toMagazineNotification,
  toPaymentResponse,
  toPieceListItem,
  toPieceRecordFull,
  toPieceRecordSummary,
  toPitchResponse,
} from './magazine-piece-response';
import {
  ArticleCommentResponse,
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
  toWriterPayment,
  toWriterPitch,
  WriterAssignmentResponse,
  WriterPaymentResponse,
  WriterPitchResponse,
} from './magazine-writer-response';
import { validateArticleBlocks } from './magazine-article-blocks.validation';
import {
  validatePieceBrief,
  validatePieceCare,
} from './piece-jsonb.validation';

/** Today as a `date`-column-shaped ISO string (`YYYY-MM-DD`), UTC. */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
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
 * Default number of rows `listMagazineNotifications` returns (Magazine Desk
 * Phase 7, Task C1) — matches the desk's "Since Friday" panel page size.
 */
const NOTIFICATIONS_DEFAULT_LIMIT = 20;

/**
 * In-memory saved-view predicates, applied AFTER the SQL filters load a page
 * of pieces — mirrors the frontend `VIEW_TEST` map (spec §4.1 / plan Task 4)
 * exactly, so a saved view means the same thing whether it's evaluated
 * client-side (demo mode) or server-side (live mode).
 */
const SAVED_VIEW_TEST: Record<SavedViewId, (piece: MagazinePiece) => boolean> =
  {
    'v-late': (piece) =>
      deriveLate(piece) || deriveWaitingOn(piece) === 'writer',
    // Real art state (Magazine Desk Phase 7, Task A3): a piece still needs
    // art work when nothing has been requested yet, or a brief has gone out
    // but nothing has come in ('in') or been marked not-applicable ('na').
    'v-art': (piece) => piece.art === 'none' || piece.art === 'brief',
    'v-sens': (piece) =>
      piece.stage === 'sensitivity_read' || piece.stage === 'edit',
    'v-pay': (piece) => piece.stage === 'layout' || piece.stage === 'ready',
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

  async listPieces(query: ListPiecesQuery): Promise<PieceListItem[]> {
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

    queryBuilder.orderBy('piece.createdAt', 'DESC');

    const rows = await queryBuilder.getMany();
    const visibleRows = query.savedView
      ? rows.filter(SAVED_VIEW_TEST[query.savedView])
      : rows;

    return visibleRows.map(toPieceListItem);
  }

  async getPieceById(id: string): Promise<PieceRecord> {
    const piece = await this.loadPieceOr404(id);
    const events = await this.eventsFor(id);
    return toPieceRecordSummary(piece, events);
  }

  /**
   * Full piece record for `PieceRecordPage` (spec §7.2, Task 4): the summary
   * plus the 1:1 payment row (may not exist yet), the letters/corrections
   * lists, and the derived publish gate.
   */
  async getPieceRecordFull(id: string): Promise<PieceRecordFull> {
    const piece = await this.loadPieceOr404(id);
    const [events, payment, letters, corrections] = await Promise.all([
      this.eventsFor(id),
      this.payments.findOne({ where: { pieceId: id } }),
      this.lettersFor(id),
      this.correctionsFor(id),
    ]);
    return toPieceRecordFull(piece, events, payment, letters, corrections);
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
   */
  async updateArticleDraft(
    pieceId: string,
    dto: UpdateArticleDto,
    actorId: string,
  ): Promise<ArticleDraftResponse> {
    const piece = await this.loadPieceOr404(pieceId);
    const article = await this.ensureArticleForPiece(piece, actorId);

    const blocks =
      dto.blocks !== undefined ? validateArticleBlocks(dto.blocks) : undefined;

    Object.assign(article, {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.standfirst !== undefined ? { standfirst: dto.standfirst } : {}),
      ...(dto.kicker !== undefined ? { kicker: dto.kicker } : {}),
      ...(dto.section !== undefined ? { section: dto.section } : {}),
      ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
      ...(dto.contentNotes !== undefined
        ? { contentNotes: dto.contentNotes }
        : {}),
      ...(blocks !== undefined ? { blocks } : {}),
    });

    await this.articles.save(article);
    await this.recordEvent(pieceId, actorId, 'article_edited');

    return toArticleDraftResponse(article);
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
        fee: dto.fee ?? '',
      });
    }

    Object.assign(payment, {
      ...(dto.fee !== undefined ? { fee: dto.fee } : {}),
      ...(dto.expenses !== undefined ? { expenses: dto.expenses } : {}),
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

  async createPiece(
    dto: CreatePieceDto,
    actorId: string,
  ): Promise<PieceRecord> {
    const piece = this.pieces.create({
      format: dto.format,
      title: dto.title,
      section: dto.section,
      kind: dto.kind ?? null,
      stage: 'commissioned',
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

    await this.recordEvent(piece.id, actorId, 'commissioned');

    const events = await this.eventsFor(piece.id);
    return toPieceRecordSummary(piece, events);
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

    const events = await this.eventsFor(piece.id);
    return toPieceRecordSummary(piece, events);
  }

  async deletePiece(id: string, actorId: string): Promise<void> {
    const piece = await this.loadPieceOr404(id);
    // Record the audit event before removing the row so it isn't silently
    // dropped — Task 8's migration should either cascade
    // `magazine_piece_event.piece_id` or leave it unconstrained so this
    // history entry (and any earlier ones) survives the piece's removal.
    await this.recordEvent(id, actorId, 'deleted');
    await this.pieces.remove(piece);
  }

  async listPitches(): Promise<PitchResponse[]> {
    const rows = await this.pitches.find({
      where: [{ status: 'waiting' }, { status: 'maybe' }],
      order: { createdAt: 'DESC' },
    });
    return rows.map(toPitchResponse);
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
    return toPitchResponse(pitch);
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

    return toDeskSummary(pieces, events, editors);
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

  /**
   * The desk's "Since Friday" notifications panel (Magazine Desk Phase 7,
   * Task C1): the most recent `magazine_piece_event` rows — the same audit
   * trail `deskSummary().activity` reads — resolved down to display strings
   * (piece title, actor name via the Wave A editor directory, a human phrase
   * for the action, and the piece-record route). Newest first, limited to
   * `limit` rows at the SQL level. Batches the piece-title and actor-name
   * lookups (mirrors `searchArchive`'s author/issue resolution) rather than
   * querying per event. Actor names resolve editor-directory-first, then fall
   * back to a second batched `Profile` lookup for any actor the directory
   * doesn't cover — most notably a writer (e.g. a `filed` event) — so
   * attribution is truthful instead of misreading a writer's action as an
   * editor's.
   */
  async listMagazineNotifications(
    limit = NOTIFICATIONS_DEFAULT_LIMIT,
  ): Promise<MagazineNotificationResponse[]> {
    const events = await this.pieceEvents.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
    if (events.length === 0) {
      return [];
    }

    const pieceIds = [...new Set(events.map((event) => event.pieceId))];
    const [pieces, editors] = await Promise.all([
      this.pieces.find({ where: { id: In(pieceIds) } }),
      this.listMagazineEditors(),
    ]);

    const titleByPieceId = new Map(
      pieces.map((piece) => [piece.id, piece.title]),
    );
    const actorNameById = new Map(
      editors.map((editor) => [editor.id, editor.name]),
    );

    // Non-editor actors (e.g. writers) never appear in the editor directory,
    // so they'd otherwise misattribute to the "unresolved" fallback. Resolve
    // them with ONE additional batched `Profile` lookup — never per event.
    const unresolvedActorIds = [
      ...new Set(
        events
          .map((event) => event.actorId)
          .filter(
            (actorId): actorId is string =>
              actorId !== null && !actorNameById.has(actorId),
          ),
      ),
    ];
    if (unresolvedActorIds.length > 0) {
      const unresolvedProfiles = await this.profiles.find({
        where: { userId: In(unresolvedActorIds) },
      });
      for (const profile of unresolvedProfiles) {
        actorNameById.set(profile.userId, toActorDisplayName(profile));
      }
    }

    return events.map((event) =>
      toMagazineNotification(
        event,
        titleByPieceId.get(event.pieceId),
        actorNameById,
      ),
    );
  }

  // --- article comments / NotesRail (Magazine Desk Phase 7, Task D1) ---

  /**
   * The full threaded comment tree for a piece's article (NotesRail).
   * Resolves the piece's linked article first — a piece with no article
   * draft yet has no comments, so this returns `[]` rather than creating one
   * (unlike `addArticleComment`, a read never has side effects). Author
   * names are resolved with the exact same batched editor-directory ∪
   * `Profile` lookup as `listMagazineNotifications`, so a writer commenting
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

    const unresolvedAuthorIds = [
      ...new Set(
        comments
          .map((comment) => comment.authorId)
          .filter((authorId) => !authorNameById.has(authorId)),
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
   * `MagazinePieceEvent.action`), so this reads sensibly via
   * `describeNotificationAction`'s default case without any new branch.
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

    article.blocks = restoredBlocks;
    await this.articles.save(article);
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
   * Replaces the members' digest/social curation wholesale (spec §7.5
   * Task 2) — a straight jsonb overwrite, mirroring `updateCover` below.
   */
  async updateDigest(
    issueNumber: string,
    dto: UpdateDigestDto,
  ): Promise<IssueProductionResponse> {
    const issue = await this.loadIssueOr404(issueNumber);
    issue.digest = dto.items;
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
  ): Promise<IssueProductionResponse> {
    const issue = await this.loadIssueOr404(issueNumber);
    Object.assign(issue, {
      ...(dto.coverUrl !== undefined ? { coverUrl: dto.coverUrl } : {}),
      ...(dto.coverlines !== undefined ? { coverlines: dto.coverlines } : {}),
    });
    await this.issues.save(issue);
    return this.getIssueProduction(issueNumber);
  }

  /**
   * Ships the issue (spec §7.5 Task 2): stamps `publishedOn` with today's
   * date if it isn't set yet, then publishes the linked article/deck of
   * every piece that is past its publish gate (`computePublishGate` on the
   * piece's `care`). Pieces still behind the gate are left unpublished —
   * the issue does not wait for them. Runs inside a transaction since it
   * may touch the issue plus every piece's linked content in one go.
   */
  async shipIssue(
    issueNumber: string,
    actorId: string,
  ): Promise<IssueProductionResponse> {
    return this.dataSource.transaction(async (manager) => {
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
        await issueRepository.save(issue);
      }

      const pieces = await pieceRepository.find({
        where: { issueId: issue.id },
      });
      const publishedAt = new Date();

      for (const piece of pieces) {
        const pastPublishGate = computePublishGate(piece.care).every(
          (gate) => gate.done,
        );
        if (!pastPublishGate) {
          // Behind-gate pieces hold and publish later; the issue does not
          // wait for them.
          continue;
        }

        let published = false;

        if (piece.articleId) {
          const article = await articleRepository.findOne({
            where: { id: piece.articleId },
          });
          if (article && article.publishedAt === null) {
            article.publishedAt = publishedAt;
            await articleRepository.save(article);
            published = true;
          }
        }

        if (piece.deckId) {
          const deck = await deckRepository.findOne({
            where: { id: piece.deckId },
          });
          if (deck && deck.publishedAt === null) {
            deck.publishedAt = publishedAt;
            await deckRepository.save(deck);
            published = true;
          }
        }

        if (published) {
          const event = eventRepository.create({
            pieceId: piece.id,
            actorId,
            action: 'issue_shipped',
            detail: `issue ${issue.number}`,
          });
          await eventRepository.save(event);
        }
      }

      return toIssueProduction(issue, pieces);
    });
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

    return Promise.all(
      myPieces.map(async (piece) => {
        const payment = await this.payments.findOne({
          where: { pieceId: piece.id },
        });
        return toWriterAssignment(piece, payment);
      }),
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

    return Promise.all(
      myPieces.map(async (piece) => {
        const payment = await this.payments.findOne({
          where: { pieceId: piece.id },
        });
        return toWriterPayment(piece, payment);
      }),
    );
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
   * Also snapshots an article version (Magazine Desk Phase 7, Task E1,
   * label `"Filed draft"`) so the VersionsRail always has a checkpoint at
   * the moment a draft went to the editor — a piece with no article yet
   * (or no linked article row, defensively) simply skips the snapshot
   * rather than crashing the file action.
   */
  async fileDraft(
    writerId: string,
    pieceId: string,
  ): Promise<WriterAssignmentResponse> {
    const piece = await this.loadPieceOr404(pieceId);
    if (piece.writerId !== writerId) {
      throw new ForbiddenException('This piece is not assigned to you.');
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
      }
    }

    const payment = await this.payments.findOne({ where: { pieceId } });
    return toWriterAssignment(piece, payment);
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
   * batched editor-directory ∪ `Profile` lookup as `listArticleComments`/
   * `listMagazineNotifications`; `fromMe` is computed against `userId` (the
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

    const authorNameById = await this.resolvePieceMessageAuthorNames(
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

    const authorNameById = await this.resolvePieceMessageAuthorNames([
      authorId,
    ]);
    return toPieceMessage(message, authorNameById, authorId);
  }

  /**
   * Batched author-name resolution for the piece message thread — the exact
   * same editor-directory-first, `Profile`-fallback technique as
   * `listArticleComments`/`listMagazineNotifications`, generalized to take an
   * explicit list of ids so both the full-thread read and a single
   * just-posted message can share it.
   */
  private async resolvePieceMessageAuthorNames(
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

    return this.dataSource.transaction(async (manager) => {
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
        writerId: null,
        byline: pitch.from,
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
      return toPieceRecordSummary(piece, events);
    });
  }

  private async recordEvent(
    pieceId: string,
    actorId: string | null,
    action: string,
    detail?: string | null,
  ): Promise<void> {
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
   * `MagazineService.searchByText`'s `published_at <= now` shape but reads
   * `IS NOT NULL` directly (spec wording), which is equivalent for any row
   * whose `publishedAt` was ever stamped by `shipIssue`/`updateDeck`
   * (never future-dated).
   */
  private async searchPublishedArticlesForArchive(
    term: string,
  ): Promise<MagazineArticle[]> {
    const queryBuilder = this.articles
      .createQueryBuilder('article')
      .leftJoin(MagazineAuthor, 'author', 'author.id = article.author_id')
      .where('article.published_at IS NOT NULL');

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
   * resolution (mirroring `listMagazineNotifications`) since it resolves
   * many comments' authors at once; this is the one-off equivalent for a
   * single actor.
   */
  private async resolveCommentAuthorName(authorId: string): Promise<string> {
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

    const authorId = await this.resolveAuthorId(piece.byline);
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
   * `byline` string (spec §3.1) — bylines are seeded editorial content, not
   * member accounts (see `MagazineAuthor`'s doc comment), so there's no
   * existing id to reuse. Keyed by the slugified byline so the same writer's
   * name resolves to the same author row across pieces.
   */
  private async resolveAuthorId(byline: string): Promise<string> {
    const name = byline.trim().length > 0 ? byline.trim() : 'Staff writer';
    const slug = slugify(name, 'staff-writer');

    const existing = await this.authors.findOne({ where: { slug } });
    if (existing) {
      return existing.id;
    }

    const author = this.authors.create({
      slug,
      name,
      bio: null,
      avatarUrl: null,
    });
    await this.authors.save(author);
    return author.id;
  }
}
