import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { IdentitiesService } from '../identities/identities.service';
import {
  IDENTITY_STAFFING_CHANGED,
  IdentityStaffingChangedEvent,
  MAILBOX_STAFFING_FRAME,
  MailboxStaffingFrame,
} from '../identities/identity-staffing.events';
import {
  CONVERSATION_CLAIM_CHANGED,
  CONVERSATION_CLAIM_FRAME,
  ConversationClaimChangedEvent,
  claimEventUserIds,
  toConversationClaimFrame,
} from '../messaging/conversation-claim';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import {
  loadReachableMailboxSeats,
  partitionMailboxThreadSeats,
} from '../messaging/mailbox-seats';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { ChatGateway } from './chat.gateway';

/**
 * The home of STAFF-ONLY business mailbox socket frames: frames that name the
 * people who staff a business, so they may reach that business's own staff
 * and nobody else. Every handler here addresses each recipient through their
 * own `user:<userId>` room alone. The customer's sockets sit in the
 * conversation room (`namespace.to(conversationId)`), and the Task 13c audit
 * rule is that a customer never learns which humans staff a business.
 *
 * It emits through `ChatGateway.namespace`, the gateway's own
 * `@WebSocketServer()` namespace object, so a frame sent here reaches the
 * same process-local socket.io rooms the gateway's handlers emit to.
 * `ChatSingleInstanceGuard` asserts the single replica that makes those rooms
 * the whole audience. It lives beside the gateway because `chat.gateway.ts`
 * has its own owner; Task 25 adds a second handler to this file.
 */
@Injectable()
export class MailboxStaffRelayListener {
  private readonly logger = new Logger(MailboxStaffRelayListener.name);

  constructor(
    private readonly chatGateway: ChatGateway,
    @InjectRepository(ConversationParticipant)
    private readonly conversationParticipants: Repository<ConversationParticipant>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly identities: IdentitiesService,
    private readonly blockFilter: BlockFilterService,
  ) {}

  /**
   * Task 19: relays a claim change as the `conversation:claim` frame to the
   * thread's reachable staff seats: every live staff seat of the mailbox with
   * no block either way with the customer, and nobody at all when the
   * customer blocked the business. That is `partitionMailboxThreadSeats` with
   * departed seats dropped, then `loadReachableMailboxSeats`, the same
   * composition the push audience uses. The actor's own `user:` room is among
   * them while they hold a live seat, so their other devices update too.
   *
   * Costs a fixed number of queries whatever the thread's size: the seats,
   * their identities, the two block reads inside `loadReachableMailboxSeats`,
   * and one profile read for everyone the frame names. A failure is logged
   * and dropped: the claim write already committed, and a missed frame costs
   * a stale row until the next list fetch.
   */
  @OnEvent(CONVERSATION_CLAIM_CHANGED)
  async handleConversationClaimChanged(
    event: ConversationClaimChangedEvent,
  ): Promise<void> {
    try {
      const seats = await this.conversationParticipants.find({
        where: { conversationId: event.conversationId },
        select: { userId: true, identityId: true, leftAt: true },
      });
      const seatIdentities = await this.identities.getByIds([
        ...new Set(seats.map((seat) => seat.identityId)),
      ]);
      const identityKindById = new Map(
        seatIdentities.map((identity) => [identity.id, identity.kind]),
      );
      const partition = partitionMailboxThreadSeats(seats, identityKindById, {
        shouldIncludeDepartedSeats: false,
      });
      if (
        !partition ||
        partition.mailboxIdentityId !== event.mailboxIdentityId
      ) {
        return;
      }
      const reachableSeats = await loadReachableMailboxSeats(
        partition,
        identityKindById,
        this.blockFilter,
      );
      if (!reachableSeats.customerSeat) {
        return;
      }
      const staffUserIds = [
        ...new Set(reachableSeats.staffSeats.map((seat) => seat.userId)),
      ].filter((staffUserId) => staffUserId !== partition.customerSeat.userId);
      if (staffUserIds.length === 0) {
        return;
      }
      const namedUserIds = claimEventUserIds(event);
      const namedProfiles =
        namedUserIds.length > 0
          ? await this.profiles.find({
              where: { userId: In(namedUserIds) },
            })
          : [];
      const frame = toConversationClaimFrame(
        event,
        new Map(namedProfiles.map((profile) => [profile.userId, profile])),
      );
      for (const staffUserId of staffUserIds) {
        this.chatGateway.namespace
          ?.to(`user:${staffUserId}`)
          .emit(CONVERSATION_CLAIM_FRAME, frame);
      }
    } catch (error) {
      this.logger.error(
        `Failed to relay a claim change: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * Task 25: tells a member their staff standing on a mailbox changed, as the
   * `mailbox:staffing` frame, so their identity switcher gains or drops that
   * mailbox without waiting for an unrelated refresh. It goes to the affected
   * member's own `user:<userId>` room and to no other: colleagues, the
   * mailbox's conversation rooms and its customers never hear who joined or
   * left the staff. A failure is logged and dropped: the seat change already
   * committed, and the switcher still refreshes on its next fetch.
   */
  @OnEvent(IDENTITY_STAFFING_CHANGED)
  handleIdentityStaffingChanged(event: IdentityStaffingChangedEvent): void {
    try {
      const frame: MailboxStaffingFrame = {
        identityId: event.identityId,
        isStaff: event.isStaff,
      };
      this.chatGateway.namespace
        ?.to(`user:${event.userId}`)
        .emit(MAILBOX_STAFFING_FRAME, frame);
    } catch (error) {
      this.logger.error(
        `Failed to relay a staffing change: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
