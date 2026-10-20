import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { deleteInBatches } from '../common/batched-delete';
import { creatorDraftExpiryCutoff } from './creator-draft-store';
import { DEFAULT_CREATOR_DRAFT_RETENTION_DAYS } from './creator-drafts.constants';
import { CreatorDraft } from './entities/creator-draft.entity';

/**
 * Purges creator drafts nobody can reach any more: rows untouched for the
 * configured window (default 90 days), then listing edits whose listing is
 * gone (the foreign key nulls `made_for_listing_id` on delete).
 *
 * Errors are swallowed and logged with counts only: an escaping rejection from
 * a @nestjs/schedule handler becomes an unhandledRejection that can crash the
 * process, and the next tick retries. No payload, title or name is logged.
 */
@Injectable()
export class CreatorDraftRetentionService {
  private readonly logger = new Logger(CreatorDraftRetentionService.name);

  constructor(
    @InjectRepository(CreatorDraft)
    private readonly drafts: Repository<CreatorDraft>,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async purgeExpiredCreatorDrafts(): Promise<void> {
    try {
      const retentionDays = this.config.get<number>(
        'retention.creatorDraftDays',
        DEFAULT_CREATOR_DRAFT_RETENTION_DAYS,
      );
      const batchSize = this.config.get<number>('retention.batchSize', 1000);
      const maxBatches = this.config.get<number>(
        'retention.maxBatchesPerRun',
        50,
      );
      const cutoff = creatorDraftExpiryCutoff(new Date(), retentionDays);
      const expiredCount = await deleteInBatches(
        this.drafts,
        'updated_at < :cutoff',
        { cutoff },
        { batchSize, maxBatches },
      );
      const orphanedCount = await deleteInBatches(
        this.drafts,
        "kind = 'listing_edit' AND made_for_listing_id IS NULL",
        {},
        { batchSize, maxBatches },
      );
      if (expiredCount > 0 || orphanedCount > 0) {
        this.logger.log(
          `Purged ${expiredCount} expired and ${orphanedCount} orphaned creator draft(s)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Creator draft retention failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }
}
