import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Invite, InviteStatus } from './entities/invite.entity';

// Rows flipped per UPDATE statement, bounding the lock/WAL cost of any one
// batch. Invites expire after 7 days, so the eligible set per hourly tick is
// small in normal operation; this only matters on a first run after a backlog.
const SWEEP_BATCH_SIZE = 500;

// Safety valve so one tick can never loop unbounded if the table somehow keeps
// producing matches; the next tick continues where this one left off.
const SWEEP_MAX_BATCHES = 20;

/**
 * Flips overdue-but-unredeemed invites from `pending` to `expired`.
 *
 * Expiry is otherwise LAZY — an invite only gets its `status = expired` marking
 * when someone reads it (`resolveInvite`/`listMyInvites` compute the effective
 * status from `expires_at`) or tries to redeem it at signup. A pending invite
 * that is simply never touched again stays `pending` in the DB forever, so the
 * stored status drifts from reality. This sweep reconciles it on a schedule.
 *
 * Idempotent, batched, and cheap: it only ever touches rows that are still
 * `pending` AND already past `expires_at`, in bounded batches (see
 * `SWEEP_BATCH_SIZE`/`SWEEP_MAX_BATCHES`). An overlapping tick, or a future
 * scale-out, just re-selects whatever remains. Single-instance today (the app
 * runs one scheduler); the conditional `status = pending` guard keeps it correct
 * even if it ever runs concurrently. Errors are caught and logged — an escaping
 * rejection from a @nestjs/schedule handler becomes an unhandledRejection that
 * can crash the process; the next tick retries.
 */
@Injectable()
export class InviteExpirySweeperService {
  private readonly logger = new Logger(InviteExpirySweeperService.name);

  constructor(
    @InjectRepository(Invite) private readonly invites: Repository<Invite>,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sweepExpiredInvites(): Promise<void> {
    try {
      const now = new Date();
      const tableName = this.invites.metadata.tableName;
      let totalExpired = 0;
      for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch += 1) {
        // Bound each UPDATE with a primary-key subselect + LIMIT (the same shape
        // `deleteInBatches` uses) so we never lock the whole table at once.
        const result = await this.invites
          .createQueryBuilder()
          .update(Invite)
          .set({ status: InviteStatus.Expired })
          .where(
            `id IN (SELECT id FROM "${tableName}" ` +
              `WHERE status = :pending AND expires_at IS NOT NULL ` +
              `AND expires_at < :now LIMIT :limit)`,
            {
              pending: InviteStatus.Pending,
              now,
              limit: SWEEP_BATCH_SIZE,
            },
          )
          .execute();
        const affected = result.affected ?? 0;
        totalExpired += affected;
        if (affected < SWEEP_BATCH_SIZE) {
          break;
        }
      }
      if (totalExpired > 0) {
        this.logger.log(`Swept ${totalExpired} overdue invite(s) to expired`);
      }
    } catch (error) {
      this.logger.error(
        `Invite expiry sweep failed: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`,
      );
    }
  }
}
