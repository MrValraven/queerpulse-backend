import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreatorDraft } from './entities/creator-draft.entity';

/**
 * Deletes the caller's draft slot once a publish has succeeded. The publish
 * already committed, so a failed delete is logged and swallowed: a lingering
 * draft only stays visible to staff until the purge or the next save, which is
 * the lesser harm next to failing a publish.
 */
@Injectable()
export class CreatorDraftSlotsService {
  private readonly logger = new Logger(CreatorDraftSlotsService.name);

  constructor(
    @InjectRepository(CreatorDraft)
    private readonly drafts: Repository<CreatorDraft>,
  ) {}

  async discardAfterPublish(
    userId: string,
    kind: 'event' | 'community',
  ): Promise<void> {
    try {
      await this.drafts.delete({ userId, kind, slotKey: '' });
    } catch (error) {
      this.logCleanupFailure(kind, error);
    }
  }

  private logCleanupFailure(kind: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : 'unknown error';
    this.logger.warn(
      `Creator draft cleanup after a ${kind} publish failed: ${reason}`,
    );
  }
}
