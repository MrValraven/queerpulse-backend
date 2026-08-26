import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { SafeSpaceBadgeService } from './safe-space-badge.service';
import { SafeSpaceNominationsService } from './safe-space-nominations.service';
import {
  SafeSpaceNotificationAction,
  SafeSpaceNotifierService,
} from './safe-space-notifier.service';
import { SAFE_SPACE_ACKNOWLEDGEMENT_HOURS } from './safe-space-policy';

/**
 * Once a day, tell the people on shift what the safe-space process owes.
 *
 * Two overdue things, both of them promises the published copy makes and
 * neither of which anything used to surface: nominations still unacknowledged
 * past the 48-hour window, and badges that have been speaking for themselves
 * for more than a year without the annual re-review.
 *
 * IN-APP ONLY. QueerPulse sends no email, so this writes notification rows to
 * active moderators and admins and does nothing else. It never writes to a
 * nomination, never decides anything, and never touches a badge: an overdue
 * queue is a thing for a person to pick up, and a sweep that "handled" it by
 * auto-acknowledging would turn the 48-hour promise into a lie told on time.
 *
 * DAILY, NOT HOURLY, for the reason the number is a promise rather than an
 * alarm: a queue that is behind stays behind for hours, and paging six people
 * about the same three rows every hour is how a duty channel gets muted.
 *
 * Errors are logged and swallowed, matching every other `@Cron` sweeper here:
 * an escaping rejection from a `@nestjs/schedule` handler becomes an
 * unhandledRejection.
 */
@Injectable()
export class SafeSpaceReviewSweeperService {
  private readonly logger = new Logger(SafeSpaceReviewSweeperService.name);

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly nominations: SafeSpaceNominationsService,
    private readonly badges: SafeSpaceBadgeService,
    private readonly notifier: SafeSpaceNotifierService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async sweepOverdueReviews(): Promise<void> {
    try {
      const now = new Date();
      const [breaching, reReviewDueCount] = await Promise.all([
        this.nominations.findBreaching(now),
        this.badges.countReReviewDue(now),
      ]);
      if (!breaching.length && reReviewDueCount === 0) return;

      const staff = await this.users.find({
        where: {
          role: In([UserRole.Moderator, UserRole.Admin]),
          status: UserStatus.Active,
        },
        select: { id: true },
      });
      if (!staff.length) {
        this.logger.warn(
          'Safe-space queue is overdue and there are no active moderators to tell',
        );
        return;
      }

      const parts: string[] = [];
      if (breaching.length) {
        parts.push(
          `${breaching.length} safe-space ${
            breaching.length === 1 ? 'nomination is' : 'nominations are'
          } past the ${SAFE_SPACE_ACKNOWLEDGEMENT_HOURS}-hour acknowledgement window`,
        );
      }
      if (reReviewDueCount) {
        parts.push(
          `${reReviewDueCount} ${
            reReviewDueCount === 1 ? 'badge is' : 'badges are'
          } due for the annual re-review`,
        );
      }
      await this.notifier.tell(
        staff.map((staffUser) => staffUser.id),
        SafeSpaceNotificationAction.QueueOverdue,
        `${parts.join(', and ')}.`,
      );
      this.logger.log(
        `Safe-space queue: ${breaching.length} unacknowledged past window, ` +
          `${reReviewDueCount} due for re-review; told ${staff.length} moderator(s)`,
      );
    } catch (error) {
      this.logger.error(
        'Safe-space overdue sweep failed',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
