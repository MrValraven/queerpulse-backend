import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RefreshToken } from './entities/refresh-token.entity';

// Rows are kept for a grace window after they stop being usable (so reuse
// detection and audit still work briefly), then purged.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30d

@Injectable()
export class AuthMaintenanceService {
  private readonly logger = new Logger(AuthMaintenanceService.name);

  constructor(
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
  ) {}

  /**
   * Daily purge of dead refresh-token rows: anything that expired, or was
   * revoked, more than 30 days ago. `revoked_at < cutoff` implicitly excludes
   * NULLs (live tokens), and expired-but-never-revoked rows are caught by the
   * `expires_at` clause. Column names are the snake_case DB names (no alias, so
   * they resolve unambiguously in the DELETE).
   *
   * Single-instance job — safe here because the app runs one scheduler; if we
   * scale out, move this behind a distributed lock or a dedicated worker.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async purgeExpiredRefreshTokens(): Promise<void> {
    // @nestjs/schedule does not wrap handlers, so an escaping rejection becomes
    // an unhandledRejection — which, absent a Sentry listener, takes the process
    // down. A transient DB blip must not restart the server; the next run picks
    // up whatever this one missed.
    try {
      const cutoff = new Date(Date.now() - RETENTION_MS);
      const result = await this.refreshTokens
        .createQueryBuilder()
        .delete()
        .from(RefreshToken)
        .where('expires_at < :cutoff', { cutoff })
        .orWhere('revoked_at < :cutoff', { cutoff })
        .execute();
      const removed = result.affected ?? 0;
      if (removed > 0) {
        this.logger.log(`Purged ${removed} expired/revoked refresh token(s)`);
      }
    } catch (err) {
      this.logger.error(
        `Refresh-token purge failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    }
  }
}
