import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { CreateStorySubmissionDto } from './dto/create-story-submission.dto';
import {
  MagazineStorySubmission,
  SubmissionStatus,
} from './entities/magazine-story-submission.entity';
import {
  StorySubmissionResponse,
  toStorySubmissionResponse,
} from './magazine-response';

/**
 * The two statuses a member can still pull a story back from: it has landed in
 * the queue and nobody has answered it yet (PRD-129). `draft` never reaches the
 * server, and `accepted`/`rejected`/`published` are all the desk having spoken.
 */
const WITHDRAWABLE_SUBMISSION_STATUSES: SubmissionStatus[] = [
  SubmissionStatus.Submitted,
  SubmissionStatus.InReview,
];

/**
 * The member-facing side of story submissions: writing one, and reading your
 * own back with whatever the desk decided. The editorial DECISION lives on
 * `AdminStorySubmissionsService` (accept / decline / commission), guarded
 * separately — this service never mutates a status.
 */
@Injectable()
export class StorySubmissionsService {
  constructor(
    @InjectRepository(MagazineStorySubmission)
    private readonly submissions: Repository<MagazineStorySubmission>,
    private readonly adminQueueNotifications: AdminQueueNotificationsService,
  ) {}

  async create(
    userId: string,
    dto: CreateStorySubmissionDto,
  ): Promise<StorySubmissionResponse> {
    const deck = dto.deck?.trim() || null;
    const body = dto.body?.trim() || null;
    const saved = await this.submissions.save(
      this.submissions.create({
        userId,
        format: dto.format,
        workingTitle: dto.workingTitle,
        pitch: dto.pitch,
        deck,
        body,
        // An empty string means "no cover" on every form in this codebase (see
        // `IsImageReference`), so normalise it to null rather than storing a
        // blank key that `toImageUrl` would then have to defend against.
        coverImageKey: dto.coverImageKey?.trim() || null,
      }),
    );
    // Tell whoever works the magazine-submission queue that a story landed.
    // Awaited, but safe to await: `announce` catches everything internally,
    // so a notification failure can never fail the member's submission.
    await this.adminQueueNotifications.announce(
      AdminQueueKey.MagazineSubmissions,
      saved.id,
    );
    return toStorySubmissionResponse(saved);
  }

  async listMine(userId: string): Promise<StorySubmissionResponse[]> {
    const rows = await this.submissions.find({
      // A withdrawn story is gone from the member's point of view (PRD-129):
      // they pulled it back, and the tracker card would otherwise keep offering
      // a Withdraw button on a row that is already withdrawn. The row itself
      // survives in the table, it just stops being part of "your submissions".
      where: { userId, withdrawnAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
    return rows.map(toStorySubmissionResponse);
  }

  /**
   * The member pulls their own story back before the desk answers (PRD-129).
   *
   * Until this there was no way out: "Submit for review" was one-way, and a
   * member with second thoughts (the wrong draft, a story that names someone
   * who has since asked them not to, plain regret) could only find a human to
   * ask. The tracker showed a Withdraw button with nothing behind it.
   *
   * Three rules:
   *   - Own submission only, and `userId` comes from the session. The row is
   *     LOADED scoped to the caller, so someone else's id is a plain 404 rather
   *     than a 403 that would confirm the row exists.
   *   - Only while the desk has not answered: `decision === null` AND the
   *     status is still `submitted`/`in_review`. Anything else is a 409, so a
   *     member whose story was accepted while the page sat open sees the
   *     decision instead of a button that keeps failing.
   *   - Soft, never a delete. The row stays for both sides if the story is ever
   *     argued about later; it simply stops appearing as awaiting an answer,
   *     here and in the desk queue.
   *
   * Withdrawing twice is a no-op that returns the row rather than a 409: the
   * member asked for a state the row is already in, and the frontend refetches
   * on a 409, which would make a double-tap look like a failure.
   */
  async withdrawMine(
    userId: string,
    submissionId: string,
  ): Promise<StorySubmissionResponse> {
    const submission = await this.submissions.findOne({
      where: { id: submissionId, userId },
    });
    if (!submission) {
      throw new NotFoundException('Story submission not found');
    }

    if (submission.withdrawnAt !== null) {
      return toStorySubmissionResponse(submission);
    }

    const isStillOpen =
      submission.decision === null &&
      submission.decidedAt === null &&
      WITHDRAWABLE_SUBMISSION_STATUSES.includes(submission.status);
    if (!isStillOpen) {
      throw new ConflictException(
        'The desk has already answered this story, so it can no longer be withdrawn.',
      );
    }

    // Claimed with a conditional UPDATE rather than a read-modify-save, for the
    // same reason `AdminStorySubmissionsService.decide` guards its claim on
    // `decided_at IS NULL`: a decision landing between the read above and the
    // write here must win, so the member cannot pull back a story the desk has
    // just accepted and published.
    const withdrawnAt = new Date();
    const claim = await this.submissions.update(
      { id: submission.id, decidedAt: IsNull(), withdrawnAt: IsNull() },
      { withdrawnAt },
    );
    if (claim.affected === 0) {
      throw new ConflictException(
        'The desk has already answered this story, so it can no longer be withdrawn.',
      );
    }

    submission.withdrawnAt = withdrawnAt;
    return toStorySubmissionResponse(submission);
  }
}
