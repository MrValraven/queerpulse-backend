import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RefreshToken } from './entities/refresh-token.entity';

@Injectable()
export class AuthMaintenanceService {
  private readonly logger = new Logger(AuthMaintenanceService.name);

  constructor(
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    private readonly config: ConfigService,
  ) {}

  /**
   * Rows are kept for a grace window after they stop being usable (so reuse
   * detection and audit still work briefly), then purged.
   *
   * DERIVED from `JWT_REFRESH_TTL` rather than a 30-day constant of its own.
   * A hardcoded 30 days deleted rows a `JWT_REFRESH_TTL=90d` deployment still
   * considered valid, turning a legitimate refresh into a forced sign-out.
   * One refresh lifetime past expiry/revocation is long enough for reuse
   * detection to still catch a replayed token.
   */
  private retentionMs(): number {
    return this.config.getOrThrow<number>('auth.jwtRefreshTtlMs');
  }

  /**
   * Daily purge of dead refresh-token rows: anything that expired, or was
   * revoked, more than one refresh lifetime ago (see `retentionMs`).
   * `revoked_at < cutoff` implicitly excludes
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
      const cutoff = new Date(Date.now() - this.retentionMs());
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
