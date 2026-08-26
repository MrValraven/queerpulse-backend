import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { MagazinePitch } from './entities/magazine-pitch.entity';
import {
  MagazineStorySubmission,
  SubmissionDecision,
  SubmissionStatus,
} from './entities/magazine-story-submission.entity';
import {
  AdminStorySubmissionDTO,
  AdminStorySubmissionsPageDTO,
  toAdminStorySubmissionDTO,
} from './admin-story-submissions-response';
import { DecideStorySubmissionDto } from './dto/decide-story-submission.dto';
import { ListAdminStorySubmissionsQuery } from './dto/list-admin-story-submissions.query';

/** One page of the admin story-submission list. */
export const ADMIN_STORY_SUBMISSIONS_PAGE_SIZE = 20;

/** The `status` each decision lands the row on. `accepted` and `commissioned`
 *  share `Accepted`: both are a yes, and `status` is a published contract that
 *  cannot grow a value without breaking every exhaustive map keyed on it. The
 *  two are told apart by `decision` (and by `commissionedPitchId`). */
const STATUS_FOR_DECISION: Record<SubmissionDecision, SubmissionStatus> = {
  accepted: SubmissionStatus.Accepted,
  declined: SubmissionStatus.Rejected,
  commissioned: SubmissionStatus.Accepted,
};

/**
 * The admin dashboard's magazine-submission surface: every reader story, newest
 * first, optionally filtered by status and paginated, PLUS the editorial
 * decision (CON-01). Before that decision existed this table was read-only and
 * a member's submission sat at "submitted" forever with no way to hear back.
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
      where: query.status ? { status: query.status } : {},
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    if (!rows.length) {
      return { items: [], total, page, pageSize };
    }

    const memberLookup = new MemberLookup(this.profiles);
    const userIds = [...new Set(rows.map((row) => row.userId))];
    const refsByUserId = await memberLookup.byUserIds(userIds);

    const items: AdminStorySubmissionDTO[] = rows.map((submission) =>
      toAdminStorySubmissionDTO(
        submission,
        refsByUserId.get(submission.userId) ?? null,
      ),
    );

    return { items, total, page, pageSize };
  }

  /**
   * Accept, decline, or commission a reader's story.
   *
   * The claim and the commissioned pitch are written in ONE transaction, with
   * the claim guarded on `decided_at IS NULL`, so two editors deciding at once
   * cannot both win and a failed pitch insert can never leave a row reading
   * "commissioned" with nothing in the desk's inbox.
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
    if (submission.decidedAt !== null) {
      throw new ConflictException('Submission already decided');
    }

    const decision = dto.decision;
    const status = STATUS_FOR_DECISION[decision];
    const decisionNote = dto.replyNote?.trim() || null;
    const submitterRef = await this.lookupSubmitter(submission.userId);

    const decidedAt = new Date();

    // The claim and the commissioned pitch commit together. The claim is
    // guarded on `decidedAt IS NULL`, so a second editor pressing the same
    // button concurrently loses the race with a 409 instead of overwriting a
    // decision that already went out.
    const commissionedPitchId = await this.submissions.manager.transaction(
      async (manager): Promise<string | null> => {
        const claim = await manager.update(
          MagazineStorySubmission,
          { id: submission.id, decidedAt: IsNull() },
          { status, decision, decisionNote, decidedBy: actorUserId, decidedAt },
        );
        if (claim.affected === 0) {
          throw new ConflictException('Submission already decided');
        }

        if (decision !== 'commissioned') {
          return null;
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
        return pitch.id;
      },
    );

    try {
      await this.notifications.create(
        submission.userId,
        NotificationType.StorySubmissionDecided,
        { decision, workingTitle: submission.workingTitle },
      );
    } catch {
      // Intentionally ignored — the decision already committed.
    }

    return toAdminStorySubmissionDTO(
      {
        ...submission,
        status,
        decision,
        decisionNote,
        decidedBy: actorUserId,
        decidedAt,
        commissionedPitchId,
      },
      submitterRef,
    );
  }

  private async lookupSubmitter(userId: string): Promise<MemberRef | null> {
    const memberLookup = new MemberLookup(this.profiles);
    return (await memberLookup.byUserIds([userId])).get(userId) ?? null;
  }
}
