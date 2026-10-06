import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MEMBER_BLOCKED, MemberBlockedEvent } from '../social/social.events';
import {
  HousingViewing,
  HousingViewingStatus,
} from './entities/housing-viewing.entity';

/** The statuses a block calls off. Declined, cancelled and completed viewings
 * are history and stay as they are. */
const OPEN_VIEWING_STATUSES = [
  HousingViewingStatus.Requested,
  HousingViewingStatus.Accepted,
];

/**
 * ENG-467 / ENG-468. A block between two members cancels every requested or
 * accepted viewing between them, in either direction, so neither keeps a slot
 * free for the other and an accepted viewing stops unlocking the lister's
 * address. No bell goes out: telling the blocked member that their viewing was
 * cancelled the moment a block lands would disclose the block.
 *
 * Best-effort, as every `MEMBER_BLOCKED` consumer is (`SocialService` emits it
 * post-commit through `emitBestEffort`). The read-time checks in
 * `HousingViewingsService` (`assertNotBlocked`, the block test in
 * `hasUnlockedViewing`) are the authoritative gate; this listener tidies the
 * rows so both members' viewing lists match it.
 */
@Injectable()
export class HousingViewingsBlockListener {
  private readonly logger = new Logger(HousingViewingsBlockListener.name);

  constructor(
    @InjectRepository(HousingViewing)
    private readonly viewings: Repository<HousingViewing>,
  ) {}

  @OnEvent(MEMBER_BLOCKED, { async: true })
  async handleMemberBlocked(event: MemberBlockedEvent): Promise<void> {
    const { blockerId, blockedId } = event;
    if (!blockerId || !blockedId || blockerId === blockedId) return;
    // One UPDATE per direction, each with a single where object. The app sets
    // `invalidWhereValuesBehavior`, under which TypeORM reads an array criteria
    // as an object keyed "0" and "1" and throws, so the pair is split here.
    await this.cancelOpenBetween(blockerId, blockedId);
    await this.cancelOpenBetween(blockedId, blockerId);
  }

  /** Cancels the open viewings `requesterId` holds on `listerId`'s homes.
   * Each direction catches its own failure, so the second still runs when the
   * first fails. */
  private async cancelOpenBetween(
    requesterId: string,
    listerId: string,
  ): Promise<void> {
    try {
      await this.viewings.update(
        { requesterId, listerId, status: In(OPEN_VIEWING_STATUSES) },
        { status: HousingViewingStatus.Cancelled },
      );
    } catch (error) {
      this.logger.warn(
        `Cancelling housing viewings after a block failed: ${String(error)}`,
      );
    }
  }
}
