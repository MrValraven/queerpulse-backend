import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { Resource } from './entities/resource.entity';

/** Today as `yyyy-mm-dd`, the shape a Postgres `date` column round-trips as.
 *  Mirrors `AdminResourcesService.todayIsoDate`. */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** How many guides a single sweep will stamp. A ceiling rather than a
 *  paginator: there are roughly thirty guides on the platform, and a run that
 *  wanted more than this is a data problem worth seeing in the log, not a
 *  reason to write a loop. */
const MAX_GUIDES_PER_SWEEP = 200;

/**
 * Once a day, put overdue guide reviews in front of the people who can do
 * them (PRD-270).
 *
 * ---------------------------------------------------------------------------
 * The defect this closes
 * ---------------------------------------------------------------------------
 * Guide review had an operator page and no reminder at all. `review_due_on`
 * was written by the review modal, indexed, and used to sort the console
 * stalest-first, and nothing ever read it on a clock: no schedule, no admin
 * queue key, no bell. The whole mechanism depended on a curator opening
 * /admin/resource-guides unprompted.
 *
 * Two states go unnoticed that way, and the second is the worse one:
 *
 *  - A guide past `review_due_on` keeps serving readers with an "overdue"
 *    footer, on pages where being out of date is the harm: harm reduction,
 *    trans healthcare, crisis lines, legal aid.
 *  - A guide with NO `last_reviewed_on` is not published at all.
 *    `ResourcesService` requires `last_reviewed_on IS NOT NULL` on every
 *    public read, so an unreviewed guide is invisible to members, silently,
 *    for as long as nobody looks. That is the state most of the library sits
 *    in, so it is counted here alongside the properly overdue ones rather
 *    than treated as a lesser case.
 *
 * ---------------------------------------------------------------------------
 * Told once, not every morning
 * ---------------------------------------------------------------------------
 * `resources.review_overdue_notified_on` is the idempotency state. A guide is
 * announced when it is due and either nobody has been told (`NULL`) or it has
 * come due again since they were (`review_due_on > review_overdue_notified_on`).
 * The sweep stamps today's date on every guide it announced, so tomorrow's run
 * finds nothing new to say, and `AdminResourcesService.review` clears the
 * stamp when a guide is actually reviewed, which is what re-arms it.
 *
 * ONE announcement per run, covering everything newly overdue, rather than one
 * per guide. Thirty-one guides going overdue on the same morning would
 * otherwise be thirty-one identical bell rows per curator, which is how a duty
 * bell gets ignored, and the queue's destination is the console that already
 * sorts them stalest-first. This is `SafeSpaceReviewSweeperService`'s position
 * on daily-not-hourly, applied to the count as well as the cadence.
 *
 * ---------------------------------------------------------------------------
 * Contract notes
 * ---------------------------------------------------------------------------
 * IN-APP ONLY. QueerPulse sends no email, so this writes bell rows through the
 * existing admin-queue announcement and does nothing else. It never publishes
 * a guide, never stamps a review, and never edits prose: an overdue guide is a
 * thing for a person to read end to end, and a sweep that "handled" it by
 * stamping a date would turn the review promise into a lie told on time.
 *
 * Errors are logged and swallowed, matching every other `@Cron` here: an
 * escaping rejection from a `@nestjs/schedule` handler becomes an
 * unhandledRejection.
 *
 * FIRES IN EVERY REPLICA. Two replicas would each announce once. The stamp is
 * written before the announcement, so the second replica's query finds nothing
 * and stays silent for all but a genuine race; a duplicated bell row on a
 * two-replica deploy is a cosmetic worst case, not a correctness one, which is
 * why this takes no advisory lock where `CinemaReconciliationService` does.
 */
@Injectable()
export class ResourceReviewSweeperService {
  private readonly logger = new Logger(ResourceReviewSweeperService.name);

  constructor(
    @InjectRepository(Resource)
    private readonly resources: Repository<Resource>,
    private readonly adminQueueNotifications: AdminQueueNotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async sweepOverdueGuideReviews(): Promise<void> {
    try {
      const today = todayIsoDate();
      const dueGuides = await this.findNewlyDue(today);
      if (!dueGuides.length) return;

      // Stamped BEFORE the announcement, deliberately. If the announcement
      // fails, these guides are marked told and stay quiet until they come due
      // again, which loses one reminder; if it were stamped after, an
      // announcement that succeeded and a stamp that failed would repeat the
      // same bell every morning until somebody muted it. A missed reminder is
      // recoverable from the console, which sorts these to the top anyway. A
      // daily false alarm trains staff to ignore the real one.
      await this.resources.update(
        { id: In(dueGuides.map((guide) => guide.id)) },
        { reviewOverdueNotifiedOn: today },
      );

      // No item id: the destination is the console holding all of them, and
      // the payload's `itemId` is a per-row correlation this announcement has
      // no single value for.
      await this.adminQueueNotifications.announce(AdminQueueKey.GuideReviews);

      const neverReviewedCount = dueGuides.filter(
        (guide) => guide.lastReviewedOn === null,
      ).length;
      this.logger.log(
        `Guide reviews: ${dueGuides.length} guide(s) came due ` +
          `(${neverReviewedCount} never reviewed, and therefore not public); ` +
          'announced to the guide-review queue',
      );
    } catch (error) {
      this.logger.error(
        'Guide review sweep failed',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Guides owed a review that nobody has been told about yet.
   *
   * Two populations, unioned in one query:
   *
   *  1. `review_due_on` has passed. Ordinary staleness.
   *  2. `last_reviewed_on` is NULL. Never reviewed, and therefore withheld
   *     from the public entirely — no due date is needed to know this one is
   *     owed, and most of these rows have none.
   *
   * Both are then filtered by the same told-already rule. A never-reviewed
   * guide has no due date to compare against, so `review_overdue_notified_on IS NULL`
   * is the whole test for it: announced once, then silent until a review
   * clears the stamp. That is the intended behaviour and not an oversight —
   * a library that has been unreviewed for a year does not become more
   * actionable by being announced 365 times.
   */
  private findNewlyDue(today: string): Promise<Resource[]> {
    return this.resources
      .createQueryBuilder('resource')
      .where(
        '(resource.reviewDueOn IS NOT NULL AND resource.reviewDueOn <= :today) ' +
          'OR resource.lastReviewedOn IS NULL',
        { today },
      )
      .andWhere(
        '(resource.reviewOverdueNotifiedOn IS NULL ' +
          'OR (resource.reviewDueOn IS NOT NULL ' +
          'AND resource.reviewDueOn > resource.reviewOverdueNotifiedOn))',
      )
      .orderBy('resource.reviewDueOn', 'ASC', 'NULLS FIRST')
      .take(MAX_GUIDES_PER_SWEEP)
      .getMany();
  }
}
