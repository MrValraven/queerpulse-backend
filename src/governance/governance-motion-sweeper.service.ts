import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { GovernanceProposalService } from './governance-proposal.service';

/**
 * Closes out member motions whose co-signature drive ran out of time (GOV-01).
 *
 * A member files a motion, it enters `gathering`, and it has until
 * `gathering_closes_at` to collect its threshold of co-signatures. Reaching the
 * threshold is an event with a handler (the tenth signature moves the motion to
 * `screening` and alerts staff). Failing to reach it is the absence of an
 * event, so nothing in the request path can ever notice it: without this sweep
 * a motion that nobody else signed would sit at `gathering` forever, still
 * advertising a co-signature button on a drive that closed weeks ago, and the
 * proposer would never learn it was over.
 *
 * The sweep is the only thing that writes `lapsed`. It reads nothing else and
 * decides nothing else: staff screening stays a human decision, and a motion
 * that DID reach its threshold before the window closed is already at
 * `screening` and out of this query's reach.
 */
@Injectable()
export class GovernanceMotionSweeperService {
  private readonly logger = new Logger(GovernanceMotionSweeperService.name);

  constructor(
    private readonly governanceProposalService: GovernanceProposalService,
  ) {}

  /**
   * Daily at midnight. The co-signature window is measured in days
   * (`GATHERING_WINDOW_DAYS`), so a motion sitting a few hours past its
   * deadline before the label catches up costs nothing, and a daily pass keeps
   * the query off the hot path entirely.
   *
   * The body is a bare try/catch wrapper on purpose: `@nestjs/schedule` does
   * NOT wrap cron handlers, so a rejection escaping this method becomes an
   * unhandledRejection and takes the process down with it. A motion left one
   * day longer at `gathering` is not worth the API going offline, so the error
   * is logged and the next run tries again. The real work lives in
   * `GovernanceProposalService.lapseExpiredMotions`, which stays separately
   * callable (a backfill, a test) without going through the scheduler.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async sweepExpiredMotions(): Promise<void> {
    try {
      const lapsedCount =
        await this.governanceProposalService.lapseExpiredMotions();
      // Quiet on a no-op run: most days no drive expires, and a daily "0
      // motions" line is log noise that buries the days something happened.
      if (lapsedCount > 0) {
        this.logger.log(
          `Lapsed ${lapsedCount} member motion(s) whose co-signature window closed short of the threshold`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Member motion lapse sweep failed: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`,
      );
    }
  }
}
