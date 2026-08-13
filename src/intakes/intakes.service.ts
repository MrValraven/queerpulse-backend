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
import { UserStatus } from '../users/entities/user.entity';
import { Profile } from '../users/entities/profile.entity';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { Paginated, normalizePage, paginate } from '../common/pagination';
import { MailerService } from '../mailer/mailer.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { ListIntakesQuery } from './dto/list-intakes.query';
import { IntakeSubmission } from './entities/intake-submission.entity';
import {
  ConcernTriageStatus,
  MEMBER_ONLY_INTAKE_KINDS,
  isIntakeKind,
} from './intake-kinds';
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
    private readonly mailer: MailerService,
  ) {}

  /** Batch-resolve a set of submitter user-ids to member display refs (one
   *  query for the whole set — never one per row). Skips the lookup entirely
   *  when the page has no signed-in submitters. */
  private async resolveSubmitters(
    submitterIds: (string | null)[],
  ): Promise<Map<string, MemberRef>> {
    const ids = [...new Set(submitterIds.filter((id): id is string => !!id))];
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
      const refs = await this.resolveSubmitters(
        rows.map((row) => row.submitterId),
      );
      return rows.map((row) =>
        toIntakeSubmissionDTO(
          row,
          row.submitterId ? (refs.get(row.submitterId) ?? null) : null,
        ),
      );
    });
  }

  /**
   * Admin triage action: move one submission into a new state (`reviewing` /
   * `resolved` / `dismissed`). Backs the governance-concern dashboard. 404s when
   * no row has the id so a stale dashboard doesn't silently no-op. When the
   * concern reaches a terminal outcome (resolved/dismissed) its submitter is
   * notified — closing the "you'll get an update when it's resolved" loop the
   * form promises.
   */
  async updateStatus(
    id: string,
    status: ConcernTriageStatus,
  ): Promise<IntakeSubmissionDTO> {
    const submission = await this.submissions.findOne({ where: { id } });
    if (!submission) {
      throw new NotFoundException('No submission with that id.');
    }
    const previousStatus = submission.status;
    submission.status = status;
    const saved = await this.submissions.save(submission);

    if (
      previousStatus !== status &&
      (status === 'resolved' || status === 'dismissed')
    ) {
      await this.notifySubmitter(saved, status);
    }

    const refs = await this.resolveSubmitters([saved.submitterId]);
    return toIntakeSubmissionDTO(
      saved,
      saved.submitterId ? (refs.get(saved.submitterId) ?? null) : null,
    );
  }

  /**
   * Tell the submitter their concern reached an outcome: an in-app notification
   * for a signed-in member (identified by their account), or an email for a
   * logged-out submitter who left one. Best-effort — the status change is
   * already committed, so a flaky mailer/notifier is logged, never fatal
   * (mirrors `InquiriesService.notifyOps` and `RoadmapAdminService`). No
   * `actorId`: an admin decision is the platform's word, so block/mute must not
   * suppress it.
   */
  private async notifySubmitter(
    submission: IntakeSubmission,
    status: 'resolved' | 'dismissed',
  ): Promise<void> {
    const rawCategory = submission.payload.category;
    const category = typeof rawCategory === 'string' ? rawCategory : undefined;
    try {
      if (submission.submitterId) {
        await this.notifications.create(
          submission.submitterId,
          NotificationType.ConcernUpdate,
          { source: 'concern', status, ...(category ? { category } : {}) },
        );
        return;
      }
      const rawEmail = submission.payload.email;
      const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';
      if (email) {
        await this.mailer.send(email, 'concern_update', { status });
      }
    } catch (error) {
      this.logger.error(
        `Concern ${submission.id} moved to ${status} but notifying the ` +
          `submitter failed: ${String(error)}`,
      );
    }
  }
}
