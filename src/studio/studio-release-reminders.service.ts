import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { StudioReleaseReminder } from './entities/studio-release-reminder.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { listenablePersonaSql } from './studio-visibility';

/** One row per member and release; a repeated "Notify me" changes nothing.
 *  The statement checks the release is still scheduled and takes a share
 *  lock on the release row (`FOR SHARE`), so it waits for a drop that is
 *  changing the status and re-reads the committed state, and a reminder
 *  cannot land after the drop claimed the reminders. The single result row
 *  answers whether the release was scheduled under that lock. When it was,
 *  the member's reminder row exists once the statement ran: this statement
 *  inserted it, or the insert hit the unique conflict with a row already
 *  committed (a fast second press, whose own snapshot may predate that row),
 *  and both count as set. */
export const INSERT_REMINDER_SQL = `WITH "scheduled_release" AS MATERIALIZED (
  SELECT "id" FROM "studio_releases" WHERE "id" = $1::uuid AND "status" = 'scheduled' FOR SHARE
), "inserted" AS (
  INSERT INTO "studio_release_reminders" ("release_id", "user_id")
  SELECT "id", $2::uuid FROM "scheduled_release"
  ON CONFLICT DO NOTHING
  RETURNING 1
)
SELECT EXISTS (SELECT 1 FROM "scheduled_release") AS "is_set"`;

/**
 * Studio v3 "Notify me". A reminder can be set on a scheduled release the
 * caller can see (a listenable persona whose creator is not blocked either
 * way); anything else answers the same 404 the release read gives. The
 * drop consumes the rows (`RELEASE_ALERT_CLAIM_SQL`). Nothing here records
 * anything beyond the member's own choice, which they can clear.
 */
@Injectable()
export class StudioReleaseRemindersService {
  constructor(
    @InjectRepository(StudioRelease)
    private readonly releases: Repository<StudioRelease>,
    @InjectRepository(StudioReleaseReminder)
    private readonly reminders: Repository<StudioReleaseReminder>,
    private readonly blockFilter: BlockFilterService,
  ) {}

  async setReminder(viewerId: string, releaseId: string): Promise<void> {
    if (!(await this.isUpcomingReleaseVisible(viewerId, releaseId))) {
      throw new NotFoundException('Release not found');
    }
    const rows = await this.reminders.query<{ is_set: boolean }[]>(
      INSERT_REMINDER_SQL,
      [releaseId, viewerId],
    );
    if (rows[0]?.is_set !== true) {
      throw new NotFoundException('Release not found');
    }
  }

  /** Idempotent, whatever the release has become. */
  async clearReminder(viewerId: string, releaseId: string): Promise<void> {
    await this.reminders.delete({ releaseId, userId: viewerId });
  }

  private isUpcomingReleaseVisible(
    viewerId: string,
    releaseId: string,
  ): Promise<boolean> {
    const queryBuilder = this.releases
      .createQueryBuilder('release')
      .innerJoin('release.subprofile', 'persona')
      .where('release.status = :scheduledStatus', {
        scheduledStatus: StudioReleaseStatus.Scheduled,
      })
      .andWhere(listenablePersonaSql('persona'))
      .andWhere('release.id = :releaseId', { releaseId });
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"persona"."user_id"',
    );
    return queryBuilder.getExists();
  }
}
