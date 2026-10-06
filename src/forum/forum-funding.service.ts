import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, IsNull, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import {
  VerificationLevel,
  meetsLevel,
} from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { ForumThreadFunding } from './entities/forum-thread-funding.entity';
import { ForumThread } from './entities/forum-thread.entity';
import {
  FORUM_FUNDING_DEADLINE_CHANGED,
  ForumFundingDeadlineChangedEvent,
} from './forum.events';
import {
  ASK_AUTO_END_MS,
  AskEndedReason,
  FundingInput,
  FundingKind,
  FundingValidationContext,
  ResolvedFundingFields,
  containsPaymentDetails,
  fundingException,
  hasDeadlineChanged,
  isFundingCategory,
  isFundingKind,
  validateFundingInput,
} from './forum-funding';
import { hostOfStoredLink } from './forum-response';

/** What `ForumThreadsService.create` hands over before its insert. */
export interface FundingCreateRequest {
  kind: string | undefined;
  category: string;
  title: string;
  body: string;
  /** The author's raw request, before any category coercion. */
  isAnonymous: boolean;
  funding: FundingInput | undefined;
}

/** A validated funding replacement, ready to write inside the edit transaction. */
export interface PreparedFundingEdit {
  threadId: string;
  resolved: ResolvedFundingFields;
  previousDeadline: Date | null;
  isDeadlineChanged: boolean;
}

type FundingColumns = Pick<
  ForumThreadFunding,
  | 'linkUrl'
  | 'linkKey'
  | 'funderName'
  | 'amountMin'
  | 'amountMax'
  | 'deadline'
  | 'eligibility'
  | 'scope'
  | 'goalAmount'
  | 'askPurpose'
  | 'beneficiary'
  | 'endsAt'
>;

function fundingColumns(resolved: ResolvedFundingFields): FundingColumns {
  return {
    linkUrl: resolved.linkUrl,
    linkKey: resolved.linkKey,
    funderName: resolved.funderName,
    amountMin: resolved.amountMin,
    amountMax: resolved.amountMax,
    deadline: resolved.deadline,
    eligibility: resolved.eligibility,
    scope: resolved.scope,
    goalAmount: resolved.goalAmount,
    askPurpose: resolved.askPurpose,
    beneficiary: resolved.beneficiary,
    endsAt: resolved.endsAt,
  };
}

const REVIEW_STATE_PENDING = 'pending';
const REVIEW_STATE_APPROVED = 'approved';
const DAY_MS = 24 * 60 * 60 * 1000;

/** What a reviewer sees beside a fundraiser in `GET /admin/forum/review`. */
export interface ForumFundingReviewFacts {
  /** Where donations would go, lowercased and without `www.`. */
  linkHost: string;
  posterVerificationLevel: VerificationLevel;
  /** Whole days since the poster's account was created. */
  posterAccountAgeDays: number;
}

// The member's other fundraisers that still count against the one-at-a-time
// limit: still standing (no withdrawal), with no ending from its author, and
// either waiting on a moderator or approved and still running (by `ends_at`,
// or within 90 days of approval when there is none). An approved ask with no
// approval date yet counts as running. The running test uses the comparisons
// `deriveAskState` uses for `active`. A rejected ask counts for nothing here
// (`deriveAskState` reads it as pending), so a member whose ask was turned
// down can submit a corrected one.
const ACTIVE_ASK_COUNT_SQL = `
  SELECT COUNT(*)::int AS "active_count"
    FROM "forum_thread" "t"
    JOIN "forum_thread_funding" "funding"
      ON "funding"."thread_id" = "t"."id"
   WHERE "t"."author_id" = $1
     AND "t"."kind" = 'ask'
     AND "t"."deleted_at" IS NULL
     AND "t"."id" <> $2
     AND "funding"."ended_at" IS NULL
     AND (
           "t"."review_state" = 'pending'
           OR (
                "t"."review_state" = 'approved'
                AND (
                      "funding"."ends_at" >= $3
                      OR (
                           "funding"."ends_at" IS NULL
                           AND (
                                 "funding"."approved_at" IS NULL
                                 OR "funding"."approved_at" >= $4
                               )
                         )
                    )
              )
         )`;

/**
 * Funding & Grants: the side table behind open calls and fundraisers
 * (`forum_thread_funding`, one row per thread).
 *
 * `ForumThreadsService` calls this at the same points it calls the poll
 * helpers: resolve before the insert transaction, insert inside it, batch-load
 * for every page and echo. This service never reads `forum_thread` gates; the
 * threads service owns visibility, so the arrow stays one-way and the module
 * needs no `forwardRef`.
 */
@Injectable()
export class ForumFundingService {
  constructor(
    @InjectRepository(ForumThreadFunding)
    private readonly fundingRows: Repository<ForumThreadFunding>,
    private readonly eventEmitter: EventEmitter2,
    // P4: the phone-level gate on asks and the poster facts in the review
    // queue. `VerificationModule` exports it; `ForumModule` imports that
    // module (coordinator step).
    private readonly verification: VerificationService,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  /**
   * The create-time pairing and field rules. Answers null for a thread that is
   * neither a call nor an ask and carries no funding object, which is nearly
   * every thread. Throws the coded error for everything else that is wrong.
   */
  resolveForCreate(
    request: FundingCreateRequest,
    now: Date = new Date(),
  ): ResolvedFundingFields | null {
    const kind = request.kind ?? null;
    if (!isFundingKind(kind)) {
      if (request.funding !== undefined && request.funding !== null) {
        throw fundingException('funding_details_not_allowed');
      }
      return null;
    }
    if (!isFundingCategory(request.category)) {
      throw fundingException('funding_kind_category_mismatch');
    }
    if (!request.funding) {
      throw fundingException('funding_details_required');
    }
    if (kind === 'ask') {
      // Donors need to know who they are trusting, so a fundraiser carries
      // its author's name. Refused outright (the category would otherwise let
      // the flag through), so the composer can say why.
      if (request.isAnonymous) {
        throw fundingException('funding_ask_not_anonymous');
      }
      this.assertAskTextAllowed(kind, request.title, request.body);
    }
    return this.validateOrThrow(kind, request.funding, { now });
  }

  /** Inside the create transaction, next to the thread and its OP. */
  async insertForThread(
    manager: EntityManager,
    threadId: string,
    resolved: ResolvedFundingFields,
    now: Date = new Date(),
  ): Promise<ForumThreadFunding> {
    const repository = manager.getRepository(ForumThreadFunding);
    return repository.save(
      repository.create({
        threadId,
        ...fundingColumns(resolved),
        updatedAt: now,
        endedAt: null,
        endedReason: null,
        approvedAt: null,
      }),
    );
  }

  /** One query for a whole page; a thread with no row is absent from the map. */
  async rowsByThread(
    threadIds: readonly string[],
  ): Promise<Map<string, ForumThreadFunding>> {
    if (!threadIds.length) return new Map();
    const rows = await this.fundingRows.find({
      where: { threadId: In([...threadIds]) },
    });
    return new Map(rows.map((row) => [row.threadId, row]));
  }

  /**
   * Validates a PATCH replacement before the edit transaction opens, against
   * the stored row so an unchanged past deadline still passes.
   */
  async prepareEdit(
    thread: Pick<ForumThread, 'id' | 'kind'>,
    input: FundingInput,
    now: Date = new Date(),
  ): Promise<PreparedFundingEdit> {
    const kind = thread.kind;
    if (!isFundingKind(kind)) {
      throw fundingException('funding_details_not_allowed');
    }
    const current = await this.fundingRows.findOne({
      where: { threadId: thread.id },
    });
    const previousDeadline = current?.deadline ?? null;
    const resolved = this.validateOrThrow(kind, input, {
      now,
      previousDeadline,
      previousEndsAt: current?.endsAt ?? null,
    });
    return {
      threadId: thread.id,
      resolved,
      previousDeadline,
      isDeadlineChanged:
        kind === 'call' &&
        current !== null &&
        hasDeadlineChanged(previousDeadline, resolved.deadline),
    };
  }

  /**
   * Writes the replacement inside the edit transaction. The ask lifecycle
   * columns (`endedAt`, `endedReason`, `approvedAt`) are left out of the
   * entity, so TypeORM leaves them untouched on the update.
   */
  async saveEdit(
    manager: EntityManager,
    prepared: PreparedFundingEdit,
    now: Date = new Date(),
  ): Promise<void> {
    const repository = manager.getRepository(ForumThreadFunding);
    await repository.save(
      repository.create({
        threadId: prepared.threadId,
        ...fundingColumns(prepared.resolved),
        updatedAt: now,
      }),
    );
  }

  /** After the edit committed: tell the savers' listener the date moved. */
  emitDeadlineChanged(
    thread: Pick<ForumThread, 'id' | 'slug' | 'title' | 'authorId'>,
    prepared: PreparedFundingEdit,
    editorId: string,
  ): void {
    if (!prepared.isDeadlineChanged) return;
    this.eventEmitter.emit(FORUM_FUNDING_DEADLINE_CHANGED, {
      threadId: thread.id,
      threadSlug: thread.slug,
      threadTitle: thread.title,
      authorId: thread.authorId,
      editorId,
      deadline: prepared.resolved.deadline
        ? prepared.resolved.deadline.toISOString()
        : null,
    } satisfies ForumFundingDeadlineChangedEvent);
  }

  /**
   * An ask's title and body may carry no IBAN and no Portuguese mobile:
   * QueerPulse never handles money, so donors go through the allow-listed
   * crowdfunding link and nowhere else. A no-op for every other kind.
   */
  assertAskTextAllowed(kind: string | null, title: string, body: string): void {
    if (kind !== 'ask') return;
    if (containsPaymentDetails(`${title}\n${body}`)) {
      throw fundingException('funding_payment_details_in_body');
    }
  }

  /**
   * Fundraisers need a verified phone (`phone` level or above). Phone level is
   * reached today only through the staff review path; that is accepted.
   *
   * The gate belongs to the AUTHOR and runs once, when they post. Edits are
   * never phone-gated: an author's edit sends the ask back to the moderators
   * (who see the author's current level in the review queue), and a
   * moderator editing someone else's ask needs no phone level of their own.
   */
  async assertCanPostAsk(authorId: string): Promise<void> {
    const level = await this.verification.levelForUser(authorId);
    if (!meetsLevel(level, VerificationLevel.Phone)) {
      throw fundingException('funding_ask_verification_required');
    }
  }

  /**
   * One live or pending fundraiser per member. Runs INSIDE the create
   * transaction after the new thread's insert, under a transaction-scoped
   * advisory lock keyed on the author, so two concurrent submissions
   * serialise: the second one's count sees the first one's committed row and
   * is refused. The new thread itself is excluded by id.
   *
   * That relies on the transaction keeping Postgres's default READ COMMITTED
   * isolation (`DataSource.transaction` with no level): each statement takes a
   * fresh snapshot, so the count that runs after the lock is granted reads
   * rows committed while this transaction waited for it. Under REPEATABLE READ
   * the snapshot would predate the wait and both submissions would pass.
   */
  async assertAskLimit(
    manager: EntityManager,
    authorId: string,
    newThreadId: string,
    now: Date = new Date(),
  ): Promise<void> {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`funding-ask:${authorId}`],
    );
    const rows = await manager.query<Array<{ active_count: number }>>(
      ACTIVE_ASK_COUNT_SQL,
      [authorId, newThreadId, now, new Date(now.getTime() - ASK_AUTO_END_MS)],
    );
    if ((rows[0]?.active_count ?? 0) > 0) {
      throw fundingException('funding_ask_limit_reached');
    }
  }

  /**
   * An author's edit of an APPROVED ask (title, tags, funding fields or the
   * opening post) sends it back to the moderators: `review_state` returns to
   * `pending`, which the shared read gate hides from everyone but the author
   * and staff (saved lists included), and `approved_at` is cleared so the
   * "checked on" date can never describe words a moderator has not read.
   *
   * A moderator's edit keeps it live: the moderator is the reviewer. Pending
   * and rejected asks stay as they are. Mutates `thread.reviewState` so the
   * caller's later save and echo agree. Returns whether it reset anything.
   */
  async sendBackToReview(
    manager: EntityManager,
    thread: ForumThread,
    editorIsModerator: boolean,
  ): Promise<boolean> {
    if (
      thread.kind !== 'ask' ||
      editorIsModerator ||
      thread.reviewState !== REVIEW_STATE_APPROVED
    ) {
      return false;
    }
    thread.reviewState = REVIEW_STATE_PENDING;
    await manager.update(
      ForumThread,
      { id: thread.id },
      { reviewState: REVIEW_STATE_PENDING },
    );
    await manager.update(
      ForumThreadFunding,
      { threadId: thread.id },
      { approvedAt: null },
    );
    return true;
  }

  /**
   * `PATCH /forum/posts/:id` on an opening post (through
   * `ForumThreadsService.applyOpBodyEditRules`), inside the edit transaction:
   * the payment-details rule first, so a refusal writes nothing, then the
   * re-review rule.
   */
  async onOpBodyEdit(
    manager: EntityManager,
    threadId: string,
    nextBody: string,
    editorIsModerator: boolean,
  ): Promise<void> {
    const thread = await manager.findOne(ForumThread, {
      where: { id: threadId },
    });
    if (!thread || thread.kind !== 'ask') return;
    this.assertAskTextAllowed(thread.kind, thread.title, nextBody);
    await this.sendBackToReview(manager, thread, editorIsModerator);
  }

  /**
   * A moderator approved the ask: the date the safety strip shows. Written on
   * the approving transaction's manager, so the approval and its date commit
   * together and an approved ask never reads back with no date behind it.
   */
  async markAskApproved(
    manager: EntityManager,
    threadId: string,
    now: Date = new Date(),
  ): Promise<void> {
    await manager.update(ForumThreadFunding, { threadId }, { approvedAt: now });
  }

  /**
   * `POST /forum/threads/:slug/funding/end`: the author says the goal was
   * reached or the fundraiser is closed. Author only. A second call keeps the
   * first ending, so a double tap cannot rewrite the reason.
   *
   * The write is conditional (`ended_at IS NULL`) and the row is read back
   * after it, so two ends racing past the first read still settle on one
   * reason: whichever UPDATE lands first wins, the other matches no row, and
   * both callers echo the stored ending.
   */
  async endAsk(
    thread: ForumThread,
    userId: string,
    reason: AskEndedReason,
    now: Date = new Date(),
  ): Promise<ForumThreadFunding> {
    if (thread.kind !== 'ask') {
      throw new NotFoundException('Fundraiser not found');
    }
    if (thread.authorId !== userId) {
      throw new ForbiddenException('Only the author can end this fundraiser');
    }
    const row = await this.fundingRows.findOne({
      where: { threadId: thread.id },
    });
    if (!row) throw new NotFoundException('Fundraiser not found');
    if (row.endedAt !== null) return row;
    await this.fundingRows.update(
      { threadId: thread.id, endedAt: IsNull() },
      { endedAt: now, endedReason: reason, updatedAt: now },
    );
    const storedRow = await this.fundingRows.findOne({
      where: { threadId: thread.id },
    });
    if (!storedRow) throw new NotFoundException('Fundraiser not found');
    return storedRow;
  }

  /**
   * The review queue's facts for the asks on one page: where the money would
   * go, how verified the poster is and how old their account is. Three
   * batched reads for the page, none for a page without asks. An ask whose
   * author erased their account gets no facts (there is nobody to describe).
   */
  async reviewFactsFor(
    rows: ForumThread[],
    now: Date = new Date(),
  ): Promise<Map<string, ForumFundingReviewFacts>> {
    const askRows = rows.filter(
      (row): row is ForumThread & { authorId: string } =>
        row.kind === 'ask' && row.authorId !== null,
    );
    if (!askRows.length) return new Map();
    const authorIds = [...new Set(askRows.map((row) => row.authorId))];
    const [fundingByThread, levelsByUser, authors] = await Promise.all([
      this.rowsByThread(askRows.map((row) => row.id)),
      this.verification.levelsForUsers(authorIds),
      this.users.find({
        where: { id: In(authorIds) },
        select: { id: true, createdAt: true },
      }),
    ]);
    const createdAtByUser = new Map(
      authors.map((author) => [author.id, author.createdAt]),
    );
    const facts = new Map<string, ForumFundingReviewFacts>();
    for (const row of askRows) {
      const fundingRow = fundingByThread.get(row.id);
      const createdAt = createdAtByUser.get(row.authorId);
      if (!fundingRow || !createdAt) continue;
      facts.set(row.id, {
        // The card's own host (`stripLeadingWww` underneath), so the reviewer
        // reads the host a donor will see.
        linkHost: hostOfStoredLink(fundingRow.linkUrl),
        posterVerificationLevel:
          levelsByUser.get(row.authorId) ?? VerificationLevel.Email,
        posterAccountAgeDays: Math.max(
          0,
          Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS),
        ),
      });
    }
    return facts;
  }

  private validateOrThrow(
    kind: FundingKind,
    input: FundingInput,
    context: FundingValidationContext,
  ): ResolvedFundingFields {
    const result = validateFundingInput(kind, input, context);
    if (!result.ok) throw fundingException(result.code, result.message);
    return result.value;
  }
}
