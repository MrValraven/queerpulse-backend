import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ACCOUNT_REMOVED, AccountRemovedEvent } from './ban-evasion.events';
import { BanEvasionService } from './ban-evasion.service';

/**
 * Turns "a ban landed" into a stored evasion signal.
 *
 * This module deliberately owns no part of the moderation or community-bans
 * services. They emit `ACCOUNT_REMOVED` after their own transaction commits and
 * this listener does its write separately, which keeps two properties that both
 * matter:
 *
 *  - a failure here can never roll back a ban that has already taken effect;
 *  - the ban paths keep one responsibility each, and this one stays a single
 *    file a reviewer can read end to end.
 *
 * A failed write is logged and dropped. The consequence is one missing flag on
 * a future application, which is the same state the platform was in before this
 * module existed, and far cheaper than a ban that failed to apply.
 */
@Injectable()
export class BanEvasionListener {
  private readonly logger = new Logger(BanEvasionListener.name);

  constructor(private readonly banEvasion: BanEvasionService) {}

  @OnEvent(ACCOUNT_REMOVED, { async: true })
  async onAccountRemoved(event: AccountRemovedEvent): Promise<void> {
    try {
      await this.banEvasion.recordRemovedAccount({
        userId: event.userId,
        removalKind: event.removalKind,
        communityId: event.communityId,
        removedAt: event.removedAt,
      });
    } catch (error) {
      this.logger.error(
        `Could not record a ban-evasion signal for a removed account (${event.removalKind}).`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
