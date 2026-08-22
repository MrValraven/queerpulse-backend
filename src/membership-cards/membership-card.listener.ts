import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  COMMUNITY_MEMBER_JOINED,
  COMMUNITY_MEMBER_LEFT,
  CommunityMemberJoinedEvent,
  CommunityMemberLeftEvent,
} from '../communities/community.events';
import { CardProgramsService } from './card-programs.service';
import { MembershipCardsService } from './membership-cards.service';

/**
 * Keeps cards in step with the roster.
 *
 * Both handlers swallow their errors on purpose. A card is a secondary
 * artifact of membership, so a serial-allocation failure must never roll back
 * the join that triggered it. A failure to REVOKE is louder, since it leaves
 * a former member holding a working credential, so it logs at error level for
 * the maintainer to reconcile.
 */
@Injectable()
export class MembershipCardListener {
  private readonly logger = new Logger(MembershipCardListener.name);

  constructor(
    private readonly programs: CardProgramsService,
    private readonly cards: MembershipCardsService,
  ) {}

  @OnEvent(COMMUNITY_MEMBER_JOINED)
  async handleJoined(event: CommunityMemberJoinedEvent): Promise<void> {
    try {
      const program = await this.programs.programForCommunity(
        event.communityId,
      );
      if (!program || !program.isEnabled) return;
      await this.cards.issue(program.id, event.userId);
    } catch (error) {
      this.logger.warn(
        `Could not issue a card for user ${event.userId} in community ${event.communityId}: ${String(error)}`,
      );
    }
  }

  @OnEvent(COMMUNITY_MEMBER_LEFT)
  async handleLeft(event: CommunityMemberLeftEvent): Promise<void> {
    try {
      await this.cards.revokeForUser(event.communityId, event.userId);
    } catch (error) {
      this.logger.error(
        `Could not revoke the card for user ${event.userId} leaving community ${event.communityId}: ${String(error)}`,
      );
    }
  }
}
