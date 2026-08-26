import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
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
import { ListIntakesQuery } from './dto/list-intakes.query';
import { IntakeSubmission } from './entities/intake-submission.entity';
import {
  AdminTriageStatus,
  MEMBER_ONLY_INTAKE_KINDS,
  isIntakeKind,
} from './intake-kinds';
import { intakeDueAt } from './intake-sla';
import {
  IntakeAckDTO,
  IntakeSubmissionDTO,
  toIntakeAckDTO,
  toIntakeSubmissionDTO,
} from './intakes-response';

@Injectable()
export class IntakesService {
  private readonly logger = new Logger(IntakesService.name);

  constructor(
    @InjectRepository(IntakeSubmission)
    private readonly submissions: Repository<IntakeSubmission>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly notifications: NotificationsService,
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
      }),
    );

    return toIntakeAckDTO(saved);
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

    if (
      previousStatus !== status &&
      (status === 'resolved' || status === 'dismissed')
    ) {
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
   * Tell the submitter their concern reached an outcome, in-app, when the
   * submission is tied to an account. QueerPulse delivers no email, so a
   * concern submitted anonymously with only an email address gets NO outbound
   * update at all: the outcome is recorded on the submission and nothing
   * reaches the address. Best-effort: the status change is already committed,
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
    status: 'resolved' | 'dismissed',
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
