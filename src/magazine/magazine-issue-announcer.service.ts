import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { MagazineIssue } from './entities/magazine-issue.entity';
import { MagazinePiece } from './entities/magazine-piece.entity';
import { magazineIssueVisibleThroughDate } from './magazine-clock';

/**
 * How many members one `createForRecipients` call announces a shipped issue to
 * (CON-05). Matches the community post fan-out's chunk size: each call is
 * already batched internally into one multi-row INSERT plus two filter
 * queries, and chunking keeps a membership-wide announcement off a single
 * enormous statement.
 */
const ISSUE_ANNOUNCE_CHUNK_SIZE = 500;

/**
 * CON-05. The real dispatch behind the issue panel's "announce with the
 * issue" toggle. `MagazinePieceService.shipIssue` calls it right after a ship.
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
 * An issue is announced only once it is actually readable, so the bell never
 * deep-links to a page that is still hidden. All of these must hold:
 *   - the desk turned the toggle on (`digestSendOnPublish`);
 *   - it has not been announced yet (`digestSentAt === null`);
 *   - its `publishedOn` is on or before `magazineIssueVisibleThroughDate`,
 *     so the public issue page already shows it;
 *   - its last ship's `publishAt` has passed, so the shipped pieces are live;
 *   - that ship published at least one piece that is still `published`.
 *
 * A ship dated in the future is never announced. By product decision there is
 * no scheduled job in this module, so nothing comes back at 09:00 on the issue
 * date to ring the bell, and the issue simply goes out without one.
 *
 * ONE announcement per issue, ever. The conditional
 * `UPDATE ... WHERE digest_sent_at IS NULL` is the claim: two concurrent ships
 * race on it and exactly one wins, and a re-ship finds the stamp already set.
 * Failures are swallowed: the issue has already shipped and its pieces are
 * already published by the time this runs, and a bell that did not ring is
 * never worth failing a ship over.
 */
@Injectable()
export class MagazineIssueAnnouncerService {
  private readonly logger = new Logger(MagazineIssueAnnouncerService.name);

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(MagazineIssue)
    private readonly issues: Repository<MagazineIssue>,
    @InjectRepository(MagazinePiece)
    private readonly pieces: Repository<MagazinePiece>,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Announces `issue` to every active member when it is due (see the class
   * comment for the conditions). Returns whether this call sent the
   * announcement. Never throws.
   */
  async announceIssueIfDue(
    issue: MagazineIssue,
    now: Date = new Date(),
  ): Promise<boolean> {
    try {
      if (!(await this.isAnnouncementDue(issue, now))) {
        return false;
      }

      const claim = await this.issues.update(
        { id: issue.id, digestSentAt: IsNull() },
        { digestSentAt: now },
      );
      if (claim.affected !== 1) {
        return false;
      }
    } catch (error) {
      this.logger.warn(
        `Issue ${issue.number} announcement check failed: ${String(error)}`,
      );
      return false;
    }

    try {
      const recipientCount = await this.fanOut(issue);
      issue.digestSentAt = now;
      this.logger.log(
        `Announced issue ${issue.number} to ${recipientCount} member(s)`,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Issue ${issue.number} announcement fan-out failed: ${String(error)}`,
      );
      await this.releaseClaim(issue);
      return false;
    }
  }

  private async isAnnouncementDue(
    issue: MagazineIssue,
    now: Date,
  ): Promise<boolean> {
    if (!issue.digestSendOnPublish || issue.digestSentAt !== null) {
      return false;
    }
    if (
      issue.publishedOn === null ||
      issue.publishedOn > magazineIssueVisibleThroughDate(now)
    ) {
      return false;
    }
    const lastShip = issue.lastShip;
    if (lastShip === null || Date.parse(lastShip.publishAt) > now.getTime()) {
      return false;
    }
    if (lastShip.publishedPieceIds.length === 0) {
      return false;
    }
    const livePieceCount = await this.pieces.count({
      where: { id: In(lastShip.publishedPieceIds), stage: 'published' },
    });
    return livePieceCount > 0;
  }

  /** Rings every active member's bell; returns how many were targeted. */
  private async fanOut(issue: MagazineIssue): Promise<number> {
    // Everyone who can read the magazine. `isSystem` accounts (the
    // QueerPulse house account) are excluded: nobody reads their bell.
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
    // INSERT per chunk.
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
    return recipientIds.length;
  }

  /**
   * Clears the claim after a failed fan-out, so a crash mid-announce leaves
   * the issue re-announceable on the next ship.
   */
  private async releaseClaim(issue: MagazineIssue): Promise<void> {
    try {
      await this.issues.update({ id: issue.id }, { digestSentAt: null });
    } catch (error) {
      this.logger.warn(
        `Issue ${issue.number} announcement claim could not be released: ${String(error)}`,
      );
    }
  }
}
