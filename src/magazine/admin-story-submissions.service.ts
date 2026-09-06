import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { sanitizeArticleBlocks } from './article-html-sanitizer';
import {
  ArticleBlock,
  MagazineArticle,
} from './entities/magazine-article.entity';
import { MagazineAuthor } from './entities/magazine-author.entity';
import { MagazinePieceEvent } from './entities/magazine-piece-event.entity';
import { MagazinePiece, PieceBrief } from './entities/magazine-piece.entity';
import { MagazinePitch } from './entities/magazine-pitch.entity';
import {
  MagazineStorySubmission,
  SubmissionDecision,
  SubmissionStatus,
} from './entities/magazine-story-submission.entity';
import {
  MAX_BLOCKS_PER_ARTICLE,
  MAX_BLOCK_HTML_LENGTH,
  validateArticleBlocks,
} from './magazine-article-blocks.validation';
import { toActorDisplayName, toPlainText } from './magazine-piece-response';
import {
  AdminStorySubmissionDTO,
  AdminStorySubmissionsPageDTO,
  toAdminStorySubmissionDTO,
} from './admin-story-submissions-response';
import { DecideStorySubmissionDto } from './dto/decide-story-submission.dto';
import { ListAdminStorySubmissionsQuery } from './dto/list-admin-story-submissions.query';

/** One page of the admin story-submission list. */
export const ADMIN_STORY_SUBMISSIONS_PAGE_SIZE = 20;

/**
 * The article validator's own ceilings, imported rather than copied. It stays
 * the authority: it REJECTS a payload past either one with a 400. Accepting a
 * story must never fail because the member wrote a long one, so the conversion
 * below stays inside both ceilings by construction and the validator only ever
 * confirms it. These were local mirrors of the same two numbers until the
 * constants were exported; one rule, one copy, so the two cannot drift.
 */
const STORY_BLOCK_HTML_LIMIT = MAX_BLOCK_HTML_LENGTH;
const STORY_BLOCK_COUNT_LIMIT = MAX_BLOCKS_PER_ARTICLE;

/** What joins two of the member's paragraphs when they have to share one
 *  block. `br` is on the article sanitizer's allowlist. */
const PARAGRAPH_JOINER = '<br><br>';

/** Words a reader gets through in a minute, for the article's `readMinutes`
 *  seed. The desk can correct it; a rough true number beats the flat `1`
 *  every lazily-created draft starts on. */
const READING_WORDS_PER_MINUTE = 200;

/**
 * The submitted body is PLAIN TEXT: it comes from the `SubmitStoryEditor`
 * textarea and is rendered as a JSX text node everywhere it is read today.
 * Article blocks hold rich text, so every character that means something in
 * HTML is escaped on the way in. Without this, a member who typed `a < b`
 * would have the rest of their sentence swallowed as a tag by the sanitizer.
 */
function escapeAsBlockHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Splits one over-long paragraph across several blocks, preferring a
 * whitespace boundary so a word (or an escaped `&amp;`) is not cut in half.
 * A 20,000-character run with no whitespace at all is cut hard: the sanitizer
 * discards whatever half-written entity that leaves, which is cosmetic, and
 * the alternative is dropping the member's text.
 */
function splitOversizedParagraph(html: string): string[] {
  if (html.length <= STORY_BLOCK_HTML_LIMIT) {
    return [html];
  }
  const parts: string[] = [];
  let remaining = html;
  while (remaining.length > STORY_BLOCK_HTML_LIMIT) {
    const window = remaining.slice(0, STORY_BLOCK_HTML_LIMIT);
    const lastSpace = window.lastIndexOf(' ');
    const cut = lastSpace > 0 ? lastSpace : STORY_BLOCK_HTML_LIMIT;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining.length > 0) {
    parts.push(remaining);
  }
  return parts;
}

/**
 * Packs paragraphs into as few blocks as the html ceiling allows. Only used
 * when a story has more paragraphs than one article can hold (400): a body is
 * capped at 120,000 characters, which escapes to at most ~720,000, so packing
 * to 20,000 per block always lands well under forty blocks. Merging beats
 * truncating; the point of this whole change is that the member's words reach
 * the desk.
 */
function packParagraphsIntoBlocks(paragraphs: string[]): string[] {
  const packed: string[] = [];
  for (const paragraph of paragraphs) {
    const current = packed[packed.length - 1];
    if (
      current !== undefined &&
      current.length + PARAGRAPH_JOINER.length + paragraph.length <=
        STORY_BLOCK_HTML_LIMIT
    ) {
      packed[packed.length - 1] = `${current}${PARAGRAPH_JOINER}${paragraph}`;
      continue;
    }
    packed.push(paragraph);
  }
  return packed;
}

/**
 * Turns the story the member filed into article paragraph blocks, splitting
 * on blank lines. This is deliberately the SAME rule the desk's own paste
 * paths use (`splitIntoParagraphTexts` + `createParagraphBlocks` in the
 * frontend, reached from `FileDraftModal` and `ArticleDocument`), so a
 * reader's accepted story segments identically to a writer's filed draft and
 * the editor cannot tell which route a draft arrived by.
 */
export function storyBodyToArticleBlocks(body: string): ArticleBlock[] {
  const paragraphs = body
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map(escapeAsBlockHtml)
    .flatMap(splitOversizedParagraph);

  const blockHtml =
    paragraphs.length > STORY_BLOCK_COUNT_LIMIT
      ? packParagraphsIntoBlocks(paragraphs)
      : paragraphs;

  return blockHtml.map((html): ArticleBlock => ({
    id: randomUUID(),
    kind: 'paragraph',
    html,
  }));
}

/** Whitespace-delimited words in the filed story, for `readMinutes`. */
function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

/** The `status` each decision lands the row on. `accepted` and `commissioned`
 *  share `Accepted`: both are a yes, and `status` is a published contract that
 *  cannot grow a value without breaking every exhaustive map keyed on it. The
 *  two are told apart by `decision`, and by which desk link they stamped:
 *  `commissionedPitchId` for a commission, `acceptedPieceId` for an accept. */
const STATUS_FOR_DECISION: Record<SubmissionDecision, SubmissionStatus> = {
  accepted: SubmissionStatus.Accepted,
  declined: SubmissionStatus.Rejected,
  commissioned: SubmissionStatus.Accepted,
};

/** What a decision left behind on the desk. At most one is ever set: a
 *  commission makes a pitch, an acceptance makes a piece, a decline makes
 *  neither. */
interface DeskLinks {
  commissionedPitchId: string | null;
  acceptedPieceId: string | null;
}

/**
 * The admin dashboard's magazine-submission surface: every reader story, newest
 * first, optionally filtered by status and paginated, PLUS the editorial
 * decision (CON-01). Before that decision existed this table was read-only and
 * a member's submission sat at "submitted" forever with no way to hear back.
 *
 * PRD-124: a decision now reaches the desk as well as the member. Accepting a
 * story creates its `MagazinePiece` and files the member's own text as the
 * article draft, so "accepted" is a record an editor can open, assign and pay
 * against instead of a status word with nothing behind it.
 *
 * A decline is the one decision that can be taken back (`reopen`). Every other
 * decision left something on the desk and stays final.
 *
 * Every row is hand-mapped to `AdminStorySubmissionDTO` (never a raw entity),
 * and the submitting members are resolved in ONE batched profile lookup across
 * the whole page — never one query per row — mirroring `AdminInvitesService`.
 */
@Injectable()
export class AdminStorySubmissionsService {
  constructor(
    @InjectRepository(MagazineStorySubmission)
    private readonly submissions: Repository<MagazineStorySubmission>,
    @InjectRepository(MagazinePitch)
    private readonly pitches: Repository<MagazinePitch>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly notifications: NotificationsService,
  ) {}

  async list(
    query: ListAdminStorySubmissionsQuery,
  ): Promise<AdminStorySubmissionsPageDTO> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = ADMIN_STORY_SUBMISSIONS_PAGE_SIZE;

    const [rows, total] = await this.submissions.findAndCount({
      // A story the member withdrew (PRD-129) leaves this queue. It is still in
      // the table, and `decide` refuses it, but leaving it listed would have an
      // editor reading and deciding on a piece its author has explicitly pulled
      // back, which is the one outcome a withdraw exists to prevent.
      where: query.status
        ? { status: query.status, withdrawnAt: IsNull() }
        : { withdrawnAt: IsNull() },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    if (!rows.length) {
      return { items: [], total, page, pageSize };
    }

    // One batched lookup for BOTH people a row can name: the submitter, and
    // the staff member who reopened it if a decline on it was ever taken back.
    // Folded into the same query rather than a second one, for the same reason
    // the submitters were: never one query per row.
    const memberLookup = new MemberLookup(this.profiles);
    const userIds = [
      ...new Set(
        rows.flatMap((row) =>
          row.reopenedBy === null ? [row.userId] : [row.userId, row.reopenedBy],
        ),
      ),
    ];
    const refsByUserId = await memberLookup.byUserIds(userIds);

    const items: AdminStorySubmissionDTO[] = rows.map((submission) =>
      toAdminStorySubmissionDTO(
        submission,
        refsByUserId.get(submission.userId) ?? null,
        submission.reopenedBy === null
          ? null
          : (refsByUserId.get(submission.reopenedBy) ?? null),
      ),
    );

    return { items, total, page, pageSize };
  }

  /**
   * Accept, decline, or commission a reader's story.
   *
   * The claim and whatever the decision produces on the desk (a pitch for a
   * commission, a piece for an acceptance) are written in ONE transaction,
   * with the claim guarded on `decided_at IS NULL`, so two editors deciding
   * at once cannot both win and a failed desk insert can never leave a row
   * reading "accepted" with nothing behind it.
   *
   * The submitter is notified in-app afterwards, outside the transaction and
   * best-effort: the decision has already committed, and a bell that could not
   * be written must not roll it back. There is no email in this product, so
   * the bell plus the note on their tracker card IS how they hear.
   */
  async decide(
    actorUserId: string,
    id: string,
    dto: DecideStorySubmissionDto,
  ): Promise<AdminStorySubmissionDTO> {
    const submission = await this.submissions.findOne({ where: { id } });
    if (!submission) {
      throw new NotFoundException('Story submission not found');
    }

    // The member pulled this story back (PRD-129). It has already left the
    // queue, so this can only be an editor acting on a stale page: deciding it
    // anyway would tell them the magazine accepted, commissioned or declined
    // something they had withdrawn. Checked before the "finish an earlier
    // accept" path below, which only ever applies to a row that was decided
    // while it was still open.
    if (submission.withdrawnAt !== null) {
      throw new ConflictException(
        'The member withdrew this story, so it can no longer be decided.',
      );
    }

    const decision = dto.decision;

    // An acceptance is only finished once the story is on the desk. Rows
    // accepted BEFORE an accept produced a piece carry a decision and nothing
    // else, and the `decidedAt` guard below would strand them there for good:
    // the member was told yes, and there is no piece to edit, assign or pay.
    // Re-sending `accepted` finishes such a row instead of answering 409. It
    // never re-decides (the note, the decider and the instant all stand) and
    // never rings the member a second time.
    const isFinishingEarlierAccept =
      submission.decidedAt !== null &&
      submission.decision === 'accepted' &&
      submission.acceptedPieceId === null &&
      decision === 'accepted';

    if (submission.decidedAt !== null && !isFinishingEarlierAccept) {
      throw new ConflictException('Submission already decided');
    }

    const status = isFinishingEarlierAccept
      ? submission.status
      : STATUS_FOR_DECISION[decision];
    const decisionNote = isFinishingEarlierAccept
      ? submission.decisionNote
      : dto.replyNote?.trim() || null;
    const decidedBy = isFinishingEarlierAccept
      ? submission.decidedBy
      : actorUserId;
    const decidedAt: Date = isFinishingEarlierAccept
      ? (submission.decidedAt ?? new Date())
      : new Date();

    // One batched profile lookup for every person the write needs: the
    // submitter (byline, pitch `from`, the response's member block), the
    // decider (the brief's `commissionedBy`), and, when an earlier decline on
    // this row was taken back, whoever reopened it, so the response carries the
    // same reopen block the list does.
    const memberLookup = new MemberLookup(this.profiles);
    const refsByUserId = await memberLookup.byUserIds(
      submission.reopenedBy === null
        ? [submission.userId, actorUserId]
        : [submission.userId, actorUserId, submission.reopenedBy],
    );
    const submitterRef = refsByUserId.get(submission.userId) ?? null;
    const deciderRef = refsByUserId.get(actorUserId) ?? null;
    const reopenerRef =
      submission.reopenedBy === null
        ? null
        : (refsByUserId.get(submission.reopenedBy) ?? null);

    // The claim and the desk row commit together. The claim is guarded on
    // `decidedAt IS NULL`, so a second editor pressing the same button
    // concurrently loses the race with a 409 instead of overwriting a
    // decision that already went out.
    const deskLinks = await this.submissions.manager.transaction(
      async (manager): Promise<DeskLinks> => {
        if (!isFinishingEarlierAccept) {
          const claim = await manager.update(
            MagazineStorySubmission,
            { id: submission.id, decidedAt: IsNull() },
            {
              status,
              decision,
              decisionNote,
              decidedBy: actorUserId,
              decidedAt,
            },
          );
          if (claim.affected === 0) {
            throw new ConflictException('Submission already decided');
          }
        }

        if (decision === 'accepted') {
          const acceptedPieceId = await this.createDeskPieceForStory(
            manager,
            submission,
            submitterRef,
            deciderRef,
            actorUserId,
          );
          // The piece slot is claimed exactly the way the decision itself is.
          // Two accepts racing (or a retry of the finish-an-earlier-accept
          // path) would otherwise each build a piece, and the second would
          // overwrite the link and orphan the first on the desk. Losing this
          // race rolls the whole transaction back, piece included, so one
          // submission can only ever produce one piece.
          const pieceClaim = await manager.update(
            MagazineStorySubmission,
            { id: submission.id, acceptedPieceId: IsNull() },
            { acceptedPieceId },
          );
          if (pieceClaim.affected === 0) {
            throw new ConflictException(
              'This submission already has a desk piece.',
            );
          }
          return { commissionedPitchId: null, acceptedPieceId };
        }

        if (decision !== 'commissioned') {
          return { commissionedPitchId: null, acceptedPieceId: null };
        }

        const pitchRepository = manager.getRepository(MagazinePitch);
        const pitch = await pitchRepository.save(
          pitchRepository.create({
            title: submission.workingTitle,
            // The desk's inbox shows who it came from. Blank when the profile
            // is gone, exactly like `submitPitch` leaves it — never a
            // fabricated name.
            from: submitterRef
              ? `${submitterRef.firstName} ${submitterRef.lastName}`.trim()
              : '',
            note: submission.deck?.trim() || submission.pitch,
            tags: [],
            suggestFormat: null,
            status: 'waiting',
            // Fresh: it has just landed in the inbox and has not been triaged.
            fresh: true,
            issueId: null,
            submitterId: submission.userId,
            storySubmissionId: submission.id,
          }),
        );
        await manager.update(
          MagazineStorySubmission,
          { id: submission.id },
          { commissionedPitchId: pitch.id },
        );
        return { commissionedPitchId: pitch.id, acceptedPieceId: null };
      },
    );

    if (!isFinishingEarlierAccept) {
      try {
        await this.notifications.create(
          submission.userId,
          NotificationType.StorySubmissionDecided,
          { decision, workingTitle: submission.workingTitle },
        );
      } catch {
        // Intentionally ignored — the decision already committed.
      }
    }

    return toAdminStorySubmissionDTO(
      {
        ...submission,
        status,
        decision,
        decisionNote,
        decidedBy,
        decidedAt,
        commissionedPitchId:
          deskLinks.commissionedPitchId ?? submission.commissionedPitchId,
        acceptedPieceId:
          deskLinks.acceptedPieceId ?? submission.acceptedPieceId,
      },
      submitterRef,
      reopenerRef,
    );
  }

  /**
   * Put a DECLINED story back in the queue, undoing the decline.
   *
   * A decline used to be the end of the story in every sense. `decide` guards
   * its claim on `decided_at IS NULL`, so the second decision on a row is a
   * 409: an editor who pressed the wrong button, changed their mind after
   * reading it properly, or received a revision from the member had no route
   * back at all. The member could not refile either, since their tracker card
   * showed the answer and the submit form starts a new row with no connection
   * to the one the desk had already read.
   *
   * Only a decline can be taken back:
   *
   *  - **Accepted or commissioned** is refused. Both yeses left something on
   *    the desk (`acceptedPieceId` a piece with an article draft and a writer
   *    assigned, `commissionedPitchId` a pitch in the inbox), and clearing the
   *    decision here would strand that record with nothing pointing at it while
   *    the story went back in the queue to be decided, and accepted, a second
   *    time. The way back from a yes is to deal with the desk record.
   *  - **Withdrawn** is refused. That was the member's decision about their own
   *    story, and the desk pulling it back into the queue would override it.
   *    Checked first, exactly as `decide` checks it first.
   *  - **Undecided** is refused, because there is nothing to undo. It is
   *    already in the queue.
   *
   * The undo is a single conditional UPDATE guarded on the row still being
   * declined, the same shape as `decide`'s claim: an accept landing between the
   * read and the write must win, so nobody can reopen a story onto a desk piece
   * created a moment earlier.
   *
   * Reopening CLEARS the decision (`decision`, `decisionNote`, `decidedBy`,
   * `decidedAt` back to null, `status` back to `submitted`), because that is
   * the only shape `list` puts back in the queue. `reopenedBy` / `reopenedAt` /
   * `reopenCount` are what keep that erasure visible: a reopened row would
   * otherwise be indistinguishable from one nobody had ever decided, and the
   * editor who wrote the decline would find it back in the queue with nothing
   * saying why. This table has no audit-trail table of its own, so those
   * stamped columns are the record, following `withdrawnAt`. A full history of
   * every decision a submission ever carried would need its own table and is
   * deliberately not invented here.
   */
  async reopen(
    actorUserId: string,
    id: string,
  ): Promise<AdminStorySubmissionDTO> {
    const submission = await this.submissions.findOne({ where: { id } });
    if (!submission) {
      throw new NotFoundException('Story submission not found');
    }

    if (submission.withdrawnAt !== null) {
      throw new ConflictException(
        'The member withdrew this story, so the desk cannot put it back in the queue.',
      );
    }

    if (submission.decidedAt === null || submission.decision === null) {
      throw new ConflictException(
        'This submission has not been decided, so there is nothing to reopen.',
      );
    }

    if (submission.decision !== 'declined') {
      throw new ConflictException(
        'Only a declined story can be reopened. This one was ' +
          `${submission.decision}, and the desk record it created would be ` +
          'left behind. Deal with that piece instead.',
      );
    }

    // A declined row should carry neither link. Checked anyway, and matched on
    // in the claim below, because the harm this guard exists to prevent is
    // stranding a desk record: if a row ever did hold one, the cheap check is
    // the one that keeps the piece attached to something.
    if (
      submission.acceptedPieceId !== null ||
      submission.commissionedPitchId !== null
    ) {
      throw new ConflictException(
        'This submission already has a desk record, so it cannot be reopened.',
      );
    }

    const reopenedAt = new Date();
    const claim = await this.submissions.update(
      {
        id: submission.id,
        decision: 'declined',
        withdrawnAt: IsNull(),
        acceptedPieceId: IsNull(),
        commissionedPitchId: IsNull(),
      },
      {
        // Back to where a story sits before anyone has answered it. The
        // pre-decision status is not recoverable (a decline overwrote it with
        // `Rejected`), and `submitted` is the honest re-entry point: the desk
        // has not answered, and nobody is part-way through reviewing it either.
        status: SubmissionStatus.Submitted,
        decision: null,
        decisionNote: null,
        decidedBy: null,
        decidedAt: null,
        reopenedBy: actorUserId,
        reopenedAt,
        // Incremented in SQL rather than read-modify-written, so two editors
        // reopening in the same instant cannot both write the same number.
        reopenCount: () => '"reopen_count" + 1',
      },
    );
    if (claim.affected === 0) {
      throw new ConflictException(
        'This story was decided again while the page was open, so it could not be reopened.',
      );
    }

    const memberLookup = new MemberLookup(this.profiles);
    const refsByUserId = await memberLookup.byUserIds([
      submission.userId,
      actorUserId,
    ]);

    // The member is told, best-effort and outside any transaction, exactly as
    // the decision itself is. They were rung when the story was declined and
    // they can open their tracker to find that answer gone: the decline, the
    // desk's reply note and all. Saying nothing would leave them to discover
    // an answer they had already received had been quietly withdrawn, which
    // reads worse than the message does.
    //
    // It rides `StorySubmissionDecided` with `decision: 'reopened'` rather than
    // a new notification type, so it inherits that type's delivery, preference
    // gate and no-actor rule unchanged, and needs no Postgres enum change. The
    // copy the client renders for it deliberately promises nothing: the story
    // is open again and has no answer, which is the whole of what is true.
    // Bell plus push, like every decision on this surface. QueerPulse sends no
    // email and never will.
    try {
      await this.notifications.create(
        submission.userId,
        NotificationType.StorySubmissionDecided,
        { decision: 'reopened', workingTitle: submission.workingTitle },
      );
    } catch {
      // Intentionally ignored — the reopen already committed.
    }

    return toAdminStorySubmissionDTO(
      {
        ...submission,
        status: SubmissionStatus.Submitted,
        decision: null,
        decisionNote: null,
        decidedBy: null,
        decidedAt: null,
        reopenedBy: actorUserId,
        reopenedAt,
        reopenCount: submission.reopenCount + 1,
      },
      refsByUserId.get(submission.userId) ?? null,
      refsByUserId.get(actorUserId) ?? null,
    );
  }

  /**
   * Builds the desk record an accepted story becomes: a `MagazinePiece` in
   * `article` format, its `MagazineArticle` draft already holding the text the
   * member filed, and the audit trail that says where both came from. Returns
   * the new piece's id; the caller claims it onto the submission.
   *
   * Shaped after `MagazinePieceService.commissionPitch` (the pitch route onto
   * the desk) and adapted to a story that arrives already written:
   *
   * - The DECIDER becomes the piece's editor. They made the call, so the piece
   *   is owed by them until the desk reassigns it, and `editorId` is NOT NULL.
   * - The SUBMITTER becomes the writer (`writerId`) and the byline, which is
   *   what gives them the piece in their own writer workspace, a payment row
   *   the desk can fill in, and, through CON-11 byline linking, the credit on
   *   their profile once it runs.
   * - The stage starts at `in_review`, the same place `fileDraft` leaves a
   *   piece a writer has just handed in. The story is written; parking it at
   *   `commissioned` would show the desk a piece waiting on a writer for work
   *   that is already done.
   * - The member's cover carries over as the article's lead art, so the file
   *   they uploaded is used rather than uploaded and abandoned.
   *
   * Every repository comes off the caller's `manager`, so the piece, the
   * article, the byline row and the audit events live or die with the
   * decision claim.
   */
  private async createDeskPieceForStory(
    manager: EntityManager,
    submission: MagazineStorySubmission,
    submitterRef: MemberRef | null,
    deciderRef: MemberRef | null,
    actorUserId: string,
  ): Promise<string> {
    const pieceRepository = manager.getRepository(MagazinePiece);
    const articleRepository = manager.getRepository(MagazineArticle);
    const eventRepository = manager.getRepository(MagazinePieceEvent);

    const byline = submitterRef
      ? `${submitterRef.firstName} ${submitterRef.lastName}`.trim()
      : '';
    // `workingTitle`, `deck` and `pitch` are declared plain text and rendered
    // as text everywhere, so they are normalised once here at the write
    // boundary, exactly as `updateArticleDraft` normalises a headline.
    const title = toPlainText(submission.workingTitle) || 'Untitled story';
    const standfirst = toPlainText(submission.deck ?? '');
    // Rows written before deck and body were split out carry the whole thing
    // in `pitch`; that is the documented fallback, and it is better on the
    // desk than an empty draft.
    const storyText = submission.body?.trim() || submission.pitch;
    const filedWords = countWords(storyText);

    // Validated then sanitized, the same order and the same two helpers the
    // guarded article-draft write uses, so text arriving by this route is
    // held to the identical bar.
    const blocks = sanitizeArticleBlocks(
      validateArticleBlocks(storyBodyToArticleBlocks(storyText)),
    );

    const brief: PieceBrief = {
      // The member's own summary line IS the angle: it is what they told the
      // magazine the piece was for.
      angle: toPlainText(submission.pitch),
      wants: [],
      avoid: '',
      wordCount: null,
      filedWords,
      rate: '',
      killFee: '',
      commissionedBy: deciderRef
        ? `${deciderRef.firstName} ${deciderRef.lastName}`.trim()
        : '',
      commissionedOn: new Date().toISOString().slice(0, 10),
      art: '',
    };

    const piece = pieceRepository.create({
      format: 'article',
      title,
      // The submission's `format` is the section the member picked on the
      // submit form (the FE field is literally named `section`).
      section: submission.format,
      kind: null,
      stage: 'in_review',
      editorId: actorUserId,
      writerId: submission.userId,
      byline,
      dueOn: null,
      issueId: null,
      wordTarget: null,
      slideTarget: null,
      // Fresh: it has just landed on the desk and nobody has worked it.
      fresh: true,
      pitchId: null,
      // The cover is the article's lead art, not the piece's, so `art` tracks
      // whether the desk still needs to commission anything of its own.
      art: submission.coverImageKey ? 'in' : 'none',
      brief,
    });
    await pieceRepository.save(piece);

    const authorId = await this.resolveBylineAuthorId(
      manager,
      byline,
      submission.userId,
    );
    const slug = await allocateUniqueSlug(
      slugify(title, 'draft'),
      async (candidate) =>
        (await articleRepository.findOne({ where: { slug: candidate } })) !==
        null,
    );

    const article = articleRepository.create({
      slug,
      title,
      dek: standfirst,
      body: '',
      standfirst,
      kicker: '',
      section: submission.format,
      heroImageKey: submission.coverImageKey ?? '',
      contentNotes: [],
      blocks,
      authorId,
      issueId: null,
      tags: [],
      readMinutes: Math.max(
        1,
        Math.round(filedWords / READING_WORDS_PER_MINUTE),
      ),
      publishedAt: null,
      // See `ensureArticleForPiece`: the in-memory row must carry its base
      // version, not `undefined`, for the guarded save to match on.
      version: 0,
    });
    await articleRepository.save(article);

    piece.articleId = article.id;
    await pieceRepository.save(piece);

    // Three rows, because three things really happened and the desk timeline
    // is the only place an editor can see them: the story was taken, a draft
    // was created for it, and the text was filed. The filing is credited to
    // the member, who wrote it.
    await eventRepository.save([
      eventRepository.create({
        pieceId: piece.id,
        actorId: actorUserId,
        action: 'commissioned',
        detail: 'from reader submission',
      }),
      eventRepository.create({
        pieceId: piece.id,
        actorId: actorUserId,
        action: 'article_created',
        detail: null,
      }),
      eventRepository.create({
        pieceId: piece.id,
        actorId: submission.userId,
        action: 'filed',
        detail: 'reader submission',
      }),
    ]);

    return piece.id;
  }

  /**
   * Finds or creates the `magazine_author` byline row for the accepted
   * story's writer. Deliberately the same rule as
   * `MagazinePieceService.resolveAuthorId` + `bylineMemberUserId`, because
   * `MagazineArticle.authorId` is a NOT NULL foreign key and a byline that
   * resolves differently depending on which route a piece took onto the desk
   * would split one writer across two author pages.
   *
   * CON-11: the row is linked to the member's account only when the byline
   * really is their own display name and they do not already hold a different
   * byline (`magazine_author.user_id` is uniquely indexed). Here that is
   * normally true, since the byline is composed from their profile.
   */
  private async resolveBylineAuthorId(
    manager: EntityManager,
    byline: string,
    submitterUserId: string,
  ): Promise<string> {
    const authorRepository = manager.getRepository(MagazineAuthor);
    const name = byline.trim().length > 0 ? byline.trim() : 'Staff writer';
    const slug = slugify(name, 'staff-writer');

    const profile = await manager
      .getRepository(Profile)
      .findOne({ where: { userId: submitterUserId } });
    const alreadyLinked = await authorRepository.findOne({
      where: { userId: submitterUserId },
    });
    const memberUserId =
      profile !== null &&
      slugify(toActorDisplayName(profile), 'member') === slug &&
      (alreadyLinked === null || alreadyLinked.slug === slug)
        ? submitterUserId
        : null;

    const existing = await authorRepository.findOne({ where: { slug } });
    if (existing) {
      // Backfill only: an existing link is left alone, so a staff editor's
      // deliberate link/unlink is never silently reversed.
      if (memberUserId !== null && existing.userId === null) {
        existing.userId = memberUserId;
        await authorRepository.save(existing);
      }
      return existing.id;
    }

    const author = authorRepository.create({
      slug,
      name,
      bio: null,
      avatarUrl: null,
      userId: memberUserId,
    });
    await authorRepository.save(author);
    return author.id;
  }
}
