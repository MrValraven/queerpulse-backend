import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { Profile } from '../users/entities/profile.entity';
import { MemberLookup, MemberRef } from '../common/member-ref';
import {
  optionalQueueAssigneeName,
  setQueueAssignment,
} from '../common/queue-assignment';
import { Paginated, normalizePage, paginate } from '../common/pagination';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { ListIntakesQuery } from './dto/list-intakes.query';
import { IntakeSubmission } from './entities/intake-submission.entity';
import {
  AdminTriageStatus,
  MEMBER_ONLY_INTAKE_KINDS,
  isIntakeKind,
} from './intake-kinds';
import { intakeDueAt } from './intake-sla';
import {
  ConcernStatusDTO,
  IntakeAckDTO,
  IntakeSubmissionDTO,
  toConcernStatusDTO,
  toIntakeAckDTO,
  toIntakeSubmissionDTO,
} from './intakes-response';

/**
 * PRD-261. Width of the reference code minted for a governance concern. 32
 * bytes of `randomBytes` is 256 bits, the same size
 * `JoinRequestsService.STATUS_TOKEN_BYTES` uses, and base64url-encodes to 43
 * characters. Guessing is not what the throttle on the lookup defends against;
 * the entropy is.
 */
const CONCERN_STATUS_TOKEN_BYTES = 32;

/**
 * The stored form of a reference code. Sha256 hex, matching
 * `AuthService.hashToken` and the join-request status tokens: the column holds
 * this, the submitter holds the plaintext, and the two only ever meet inside a
 * lookup.
 */
function hashConcernStatusToken(statusToken: string): string {
  return createHash('sha256').update(statusToken).digest('hex');
}

/**
 * PRD-261. The status moves a concern submitter is told about, in-app and via
 * their reference code.
 *
 * `reviewing` is here alongside the two terminal states because "somebody has
 * picked this up" is the single most useful thing a person waiting on a report
 * about harm can learn, and it is the transition the form's own promise ("a
 * confirmation within 48 hours") was really about. Before this, the first and
 * only signal was the outcome, which for a concern under the 3-day SLA window
 * meant days of silence indistinguishable from the report being dropped.
 */
type NotifiedIntakeStatus = 'reviewing' | 'resolved' | 'dismissed';

function isNotifiedIntakeStatus(
  status: AdminTriageStatus,
): status is NotifiedIntakeStatus {
  return (
    status === 'reviewing' || status === 'resolved' || status === 'dismissed'
  );
}

@Injectable()
export class IntakesService {
  private readonly logger = new Logger(IntakesService.name);

  constructor(
    @InjectRepository(IntakeSubmission)
    private readonly submissions: Repository<IntakeSubmission>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly notifications: NotificationsService,
    private readonly adminQueueNotifications: AdminQueueNotificationsService,
  ) {}

  /** Batch-resolve a set of user-ids — submitters AND triaging admins — to
   *  member display refs (one query for the whole set — never one per row).
   *  Both id sets go in together so a page costs ONE profile query, not two.
   *  Skips the lookup entirely when the page has neither. */
  private async resolveMemberRefs(
    userIds: (string | null)[],
  ): Promise<Map<string, MemberRef>> {
    const ids = [...new Set(userIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map<string, MemberRef>();
    return new MemberLookup(this.profiles).byUserIds(ids);
  }

  /**
   * Records one intake submission. `rawKind` is the untrusted `:kind` path
   * param — validated against the allowlist first, so an unknown kind can never
   * create a row. Member-only kinds require an authenticated caller; the public
   * kinds accept anonymous submissions and capture `submitterId` only when the
   * caller happened to be signed in (best-effort, via OptionalJwtAuthGuard).
   */
  async submit(
    rawKind: string,
    payload: Record<string, unknown>,
    user: CurrentUserData | undefined,
  ): Promise<IntakeAckDTO> {
    if (!isIntakeKind(rawKind)) {
      throw new BadRequestException(`Unknown intake kind: ${rawKind}`);
    }

    // Member-only kinds require an ACTIVE member — a valid cookie alone isn't
    // enough, since the JWT strategy still issues a principal for suspended /
    // pending / deactivated accounts.
    if (
      MEMBER_ONLY_INTAKE_KINDS.has(rawKind) &&
      user?.status !== UserStatus.Active
    ) {
      throw new UnauthorizedException(
        'This form requires you to be a signed-in member.',
      );
    }

    // PRD-261. A concern is the one kind with a submitter-facing worklist, so
    // it is the one kind that mints a reference code. Minted HERE because this
    // response is the only delivery channel that will ever exist for it: the
    // platform sends no email, so a code generated any later than the 201 could
    // never reach the person who needs it. Only the hash is persisted.
    const statusToken =
      rawKind === 'governance_concern'
        ? randomBytes(CONCERN_STATUS_TOKEN_BYTES).toString('base64url')
        : undefined;

    const saved = await this.submissions.save(
      this.submissions.create({
        kind: rawKind,
        submitterId: user?.userId ?? null,
        payload,
        status: 'new',
        // OPS-04. Stamped once, from the per-kind windows in
        // `intake-sla.ts` — a governance concern is owed an answer far sooner
        // than a playlist submission, and the queue should say so.
        dueAt: intakeDueAt(rawKind, new Date()),
        statusTokenHash: statusToken
          ? hashConcernStatusToken(statusToken)
          : null,
      }),
    );

    // `governance_concern` has its own console (/admin/concerns) and its own
    // reviewers; every other intake kind is worked in /admin/intakes. The
    // branch is here rather than in the registry because one method feeds two
    // queues.
    await this.adminQueueNotifications.announce(
      saved.kind === 'governance_concern'
        ? AdminQueueKey.Concerns
        : AdminQueueKey.Intakes,
      saved.id,
    );

    return toIntakeAckDTO(saved, statusToken);
  }

  /**
   * PRD-261. Where one concern stands, for whoever holds its reference code.
   *
   * PUBLIC AND UNAUTHENTICATED BY DESIGN: the person this answers usually has
   * no account, which is the whole point of an anonymous reporting form. The
   * code is the entire credential.
   *
   * Three properties make that safe, and all three are load-bearing:
   *
   *  1. Looked up BY HASH. The plaintext is never stored, so this is the only
   *     way a code can resolve, and the unique index makes it at most one row.
   *  2. Scoped to `governance_concern`. A code minted for some other kind
   *     (there are none today, and there must be none tomorrow either) could
   *     not be walked into this reader.
   *  3. Returns null for every miss, which the controller turns into ONE
   *     indistinguishable 404. Nothing here reports whether a code exists,
   *     whether a concern exists, or whether a given person filed one.
   *
   * Read-only, unlike `JoinRequestsService.getPublicStatus`, which latches a
   * deadline on first read. A concern has no clock the submitter starts.
   */
  async getConcernStatus(
    statusToken: string,
  ): Promise<ConcernStatusDTO | null> {
    const submission = await this.submissions.findOne({
      where: {
        statusTokenHash: hashConcernStatusToken(statusToken),
        kind: 'governance_concern',
      },
    });
    return submission ? toConcernStatusDTO(submission) : null;
  }

  /** Admin triage list, newest first, optionally filtered by kind/status. */
  async list(query: ListIntakesQuery): Promise<Paginated<IntakeSubmissionDTO>> {
    const page = normalizePage(query.page);
    const qb = this.submissions
      .createQueryBuilder('intake')
      .orderBy('intake.createdAt', 'DESC');

    if (query.kind) {
      qb.andWhere('intake.kind = :kind', { kind: query.kind });
    }
    if (query.status) {
      qb.andWhere('intake.status = :status', { status: query.status });
    }

    return paginate(qb, page, async (rows) => {
      const refs = await this.resolveMemberRefs([
        ...rows.map((row) => row.submitterId),
        ...rows.map((row) => row.reviewedById),
        // OPS-04 folds the claiming staff into the SAME lookup, so showing who
        // holds each row still costs one query for the whole page.
        ...rows.map((row) => row.assignedStaffId),
      ]);
      return rows.map((row) =>
        toIntakeSubmissionDTO(
          row,
          row.submitterId ? (refs.get(row.submitterId) ?? null) : null,
          row.reviewedById ? (refs.get(row.reviewedById) ?? null) : null,
          optionalQueueAssigneeName(row.assignedStaffId, refs),
        ),
      );
    });
  }

  /**
   * Claim or release one intake submission (OPS-04).
   *
   * Mirrors `ModerationService.setAssignment`, including the property that
   * makes it safe when two admins claim at once: a conditional UPDATE guarded
   * on the assignment this caller read, so the loser gets a 409 rather than
   * quietly taking the row. Additionally guarded on the submission still being
   * OPEN (`new` or the governance worklist's `reviewing`), so a closed row
   * cannot be claimed from a stale console.
   */
  async setAssignment(
    id: string,
    actorId: string,
    actorRole: string,
    assign: boolean,
  ): Promise<IntakeSubmissionDTO> {
    const submission = await this.submissions.findOne({ where: { id } });
    if (!submission) {
      throw new NotFoundException('No submission with that id.');
    }

    await setQueueAssignment({
      repository: this.submissions,
      id,
      currentAssigneeId: submission.assignedStaffId,
      actorId,
      // `actorRole` is a JWT claim, typed `string` on `CurrentUserData`.
      isAdmin: actorRole === (UserRole.Admin as string),
      assign,
      rowLabel: 'submission',
      claimableStatuses: { column: 'status', values: ['new', 'reviewing'] },
    });

    const saved = await this.submissions.findOne({ where: { id } });
    if (!saved) {
      throw new NotFoundException('No submission with that id.');
    }
    const refs = await this.resolveMemberRefs([
      saved.submitterId,
      saved.reviewedById,
      saved.assignedStaffId,
    ]);
    return toIntakeSubmissionDTO(
      saved,
      saved.submitterId ? (refs.get(saved.submitterId) ?? null) : null,
      saved.reviewedById ? (refs.get(saved.reviewedById) ?? null) : null,
      optionalQueueAssigneeName(saved.assignedStaffId, refs),
    );
  }

  /**
   * Admin triage action: move one submission out of `new`.
   *
   * Backs BOTH consoles. The governance-concern dashboard walks the
   * `reviewing` / `resolved` / `dismissed` worklist; the other eleven kinds
   * flip to the plain `reviewed`, which is all "seen and dealt with" needs to
   * mean for a grant application or a playlist submission. `new` is never a
   * target (the DTO rejects it), so a row only ever moves forward out of the
   * queue.
   *
   * Every move stamps `reviewedById` / `reviewedAt` — with two admins working
   * one pile, a status with no name attached is a guess, not a queue. The stamp
   * always reflects the LATEST move (unlike an inquiry's handler stamp, which
   * is set once): the concern worklist has real intermediate states, so "who
   * moved it to resolved" is the useful fact, not "who first touched it".
   *
   * 404s when no row has the id so a stale dashboard doesn't silently no-op.
   * When a concern reaches a terminal outcome (resolved/dismissed) its
   * submitter is notified — closing the "you'll get an update when it's
   * resolved" loop the form promises.
   */
  async updateStatus(
    id: string,
    status: AdminTriageStatus,
    adminUserId: string,
  ): Promise<IntakeSubmissionDTO> {
    const submission = await this.submissions.findOne({ where: { id } });
    if (!submission) {
      throw new NotFoundException('No submission with that id.');
    }
    const previousStatus = submission.status;
    submission.status = status;
    submission.reviewedById = adminUserId;
    submission.reviewedAt = new Date();
    const saved = await this.submissions.save(submission);

    // PRD-261. `reviewing` joins the two terminal states here: for the one kind
    // that walks a real worklist, "somebody has picked this up" is news the
    // person waiting actually needs, and it used to reach nobody. The eleven
    // other kinds never enter `reviewing`, so nothing else changes.
    if (previousStatus !== status && isNotifiedIntakeStatus(status)) {
      await this.notifySubmitter(saved, status);
    }

    const refs = await this.resolveMemberRefs([
      saved.submitterId,
      saved.reviewedById,
      saved.assignedStaffId,
    ]);
    return toIntakeSubmissionDTO(
      saved,
      saved.submitterId ? (refs.get(saved.submitterId) ?? null) : null,
      saved.reviewedById ? (refs.get(saved.reviewedById) ?? null) : null,
      optionalQueueAssigneeName(saved.assignedStaffId, refs),
    );
  }

  /**
   * Tell the submitter their concern moved, in-app, when the submission is
   * tied to an account. QueerPulse delivers no email, so an anonymous
   * submitter still gets nothing pushed to them — what they get instead
   * (PRD-261) is the reference code from their own 201 and the public
   * `GET /intakes/concerns/status` lookup it opens, which reports exactly the
   * transitions this method notifies on. Best-effort: the status change is
   * already committed,
   * so a flaky notifier is logged, never fatal (mirrors `RoadmapAdminService`).
   * No `actorId`: an admin decision is the platform's word, so block/mute must
   * not suppress it.
   *
   * The notification type branches on the KIND. `governance_concern` is the one
   * kind this table holds that actually is a concern, and it keeps
   * `ConcernUpdate`. Every other kind — a Culture playlist submission, a
   * micro-grant application, a sober-host listing, a glossary edit — now gets
   * `IntakeReviewed`, because they all used to land in the member's bell
   * reading "The concern you raised has been reviewed", which is wrong for the
   * form they filled in and unsettling for a member who never raised anything.
   */
  private async notifySubmitter(
    submission: IntakeSubmission,
    status: NotifiedIntakeStatus,
  ): Promise<void> {
    const rawCategory = submission.payload.category;
    const category = typeof rawCategory === 'string' ? rawCategory : undefined;
    const isGovernanceConcern = submission.kind === 'governance_concern';
    try {
      if (submission.submitterId) {
        await this.notifications.create(
          submission.submitterId,
          isGovernanceConcern
            ? NotificationType.ConcernUpdate
            : NotificationType.IntakeReviewed,
          isGovernanceConcern
            ? { source: 'concern', status, ...(category ? { category } : {}) }
            : { source: 'intake', kind: submission.kind, status },
        );
      }
    } catch (error) {
      this.logger.error(
        `Concern ${submission.id} moved to ${status} but notifying the ` +
          `submitter failed: ${String(error)}`,
      );
    }
  }
}
