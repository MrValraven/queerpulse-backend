import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CONNECTION_ACCEPTED,
  ConnectionAcceptedEvent,
} from '../connections/connection.events';
import { ConnectionsService } from '../connections/connections.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { sanitizeMessageBody } from './dto/trim-message-body';
import { MessageView } from './message-response';
import { MessagingCoreService } from './messaging-core.service';

/** Why a cold enquiry cannot be delivered. `self` is a caller bug (enquiring on
 *  your own thing); `blocked` is a block in either direction, the one hard stop
 *  `deliverEnquiry` keeps. */
export type EnquiryBlockedReason = 'self' | 'blocked';

/** Answer to "may this member cold-contact that one, and what will the thread
 *  then allow?" See `MessageRequestsService.enquiryContactability`. */
export interface EnquiryContactability {
  canDeliver: boolean;
  blockedReason: EnquiryBlockedReason | null;
  /**
   * Always `false` while `canDeliver` is true (PRD-340): the enquiry recipient
   * may always post their first ordinary reply without a connection. That
   * reply is what opens the thread for both sides. Kept (rather than removed)
   * so callers built against this contract don't need a second lookup. A
   * caller that still wants to warn the ENQUIRER should read this as "always
   * fine to answer", never as "will refuse", and should prefer
   * `followUpAwaitsReply` below for the honest, PRD-340-aware copy.
   */
  replyRequiresConnection: boolean;
  /**
   * PRD-340: true when the two are NOT accepted connections, so the
   * RECIPIENT's reply opens the thread rather than it already being open.
   * This is what a pre-send notice to the ENQUIRER should actually say:
   * the recipient can answer straight away (no connection needed for
   * THEIR first reply), and the enquirer can send more once they do. Always
   * `false` when the pair is already connected (an ordinary open thread,
   * nothing to explain) and whenever `canDeliver` is `false` (nothing will
   * be delivered to explain).
   */
  followUpAwaitsReply: boolean;
}

/**
 * Message-requests concern of the split `MessagingService`: cold-contact flows
 * that seed or bypass a 1:1 conversation without the caller already being a
 * participant — the "message a stranger" connection-request flow
 * (`messageRequest`), cross-domain enquiry delivery (`deliverEnquiry`, used by
 * housing/listings), and materializing the DM once a connection request is
 * accepted. Everyday thread reads/sends live in `MessagesService`/
 * `ConversationsService`.
 */
@Injectable()
export class MessageRequestsService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly core: MessagingCoreService,
    private readonly connectionsService: ConnectionsService,
    private readonly blockFilter: BlockFilterService,
  ) {}

  async messageRequest(
    userId: string,
    toSlug: string,
    body: string,
  ): Promise<{
    conversationId: string | null;
    message: MessageView | null;
    connectionRequestId: string | null;
  }> {
    const recipient = await this.profiles.findOne({ where: { slug: toSlug } });
    if (!recipient) {
      throw new NotFoundException('Member not found');
    }
    if (recipient.userId === userId) {
      throw new BadRequestException('You cannot message yourself');
    }
    if (await this.blockFilter.isBlockedEitherWay(userId, recipient.userId)) {
      throw new ForbiddenException('You cannot message this member');
    }

    if (await this.connectionsService.areConnected(userId, recipient.userId)) {
      const { conversation } = await this.core.getOrCreateConversation(
        userId,
        recipient.userId,
      );
      const { view } = await this.core.postMessage(
        conversation.id,
        userId,
        body,
      );
      return {
        conversationId: conversation.id,
        message: view,
        connectionRequestId: null,
      };
    }

    // Not connected: the message becomes the seed of a connection request (§7).
    const conn = await this.connectionsService.requestConnection(
      userId,
      toSlug,
      body,
    );
    return {
      conversationId: null,
      message: null,
      connectionRequestId: conn.id,
    };
  }

  /**
   * Can `fromUserId` deliver a cold enquiry to `toUserId` right now, and what
   * happens next in that thread?
   *
   * The read-only twin of `deliverEnquiry` below, for surfaces that have to
   * decide whether to OFFER a "message them" affordance at all rather than
   * discover the answer by throwing at the member after they have typed a
   * paragraph. It asks messaging the question instead of re-deriving the rules
   * in another domain, so there is still exactly one place that decides who may
   * cold-contact whom.
   *
   * `replyRequiresConnection`/`followUpAwaitsReply` are the parts callers
   * most need and the part that is easiest to get wrong. PRD-340:
   * `deliverEnquiry` seeds an explicit `initiatorUserId` on the thread it
   * creates/reuses, and `MessagesService.sendMessage`'s connection-gate block
   * lets the RECIPIENT (the one this method is asked about replying to) post
   * their first ordinary reply without a connection. That reply is what
   * opens the thread for both sides from then on. So the recipient never
   * needs a connection to reply to a cold enquiry, and
   * `replyRequiresConnection` is always false while `canDeliver` is true.
   * `followUpAwaitsReply` names the fact truthfully for a pre-send notice: it
   * is true exactly when the pair is not yet connected, so the enquirer
   * learns their thread stays a one-message enquiry until the recipient
   * replies, not that the recipient needs to connect first.
   */
  async enquiryContactability(
    fromUserId: string,
    toUserId: string,
  ): Promise<EnquiryContactability> {
    if (fromUserId === toUserId) {
      return {
        canDeliver: false,
        blockedReason: 'self',
        replyRequiresConnection: false,
        followUpAwaitsReply: false,
      };
    }
    if (await this.blockFilter.isBlockedEitherWay(fromUserId, toUserId)) {
      return {
        canDeliver: false,
        blockedReason: 'blocked',
        replyRequiresConnection: false,
        followUpAwaitsReply: false,
      };
    }
    const areConnected = await this.connectionsService.areConnected(
      fromUserId,
      toUserId,
    );
    return {
      canDeliver: true,
      blockedReason: null,
      replyRequiresConnection: false,
      followUpAwaitsReply: !areConnected,
    };
  }

  /**
   * Delivers a one-off message from `fromUserId` to `toUserId`, addressed by
   * userId (not slug), creating the 1:1 conversation if needed. Unlike
   * `sendMessage`/`messageRequest`, this intentionally does NOT require the two
   * to be accepted connections. It backs cold cross-domain contact such as a
   * housing enquiry, where a pre-existing friendship must not be a
   * precondition. A block either way is still a hard stop.
   *
   * PRD-340: this is THE one deliberately connection-bypassing delivery path,
   * so it is the ONLY caller that ever passes `coldContactInitiatorUserId` to
   * `getOrCreateConversation`, claiming (or seeding) `initiatorUserId` so the
   * recipient can answer with one tap. A second enquiry into an existing
   * un-replied thread claims it too, for the same reason a first one would.
   */
  async deliverEnquiry(
    fromUserId: string,
    toUserId: string,
    body: string,
  ): Promise<{ conversationId: string }> {
    if (fromUserId === toUserId) {
      throw new BadRequestException('You cannot send an enquiry to yourself');
    }
    if (await this.blockFilter.isBlockedEitherWay(fromUserId, toUserId)) {
      throw new ForbiddenException('You cannot contact this member');
    }
    // PRD-365: an enquiry skips the daily and open-pending request caps (each
    // enquiry domain keeps its own quota) but still meets the report-driven
    // pause. Contact between accepted connections is never paused.
    //
    // PRD-366: "who can message me" is deliberately NOT consulted here. An
    // enquiry is about something the recipient published in order to be
    // contacted (their own listing, room, job, trade), so even a member set
    // to 'connections' keeps receiving enquiries about it.
    if (!(await this.connectionsService.areConnected(fromUserId, toUserId))) {
      await this.connectionsService.assertRequestsNotPaused(fromUserId);
    }
    const { conversation } = await this.core.getOrCreateConversation(
      fromUserId,
      toUserId,
      fromUserId,
    );
    await this.core.postMessage(conversation.id, fromUserId, body);
    return { conversationId: conversation.id };
  }

  @OnEvent(CONNECTION_ACCEPTED)
  async handleConnectionAccepted(
    payload: ConnectionAcceptedEvent,
  ): Promise<void> {
    const { conversation, created } = await this.core.getOrCreateConversation(
      payload.requesterId,
      payload.addresseeId,
    );
    // Seed the request message only on first materialization (idempotent if the
    // event ever re-fires). A note that sanitizes to nothing seeds no bubble.
    if (
      created &&
      payload.requestMessage &&
      sanitizeMessageBody(payload.requestMessage)
    ) {
      await this.core.postMessage(
        conversation.id,
        payload.requesterId,
        payload.requestMessage,
      );
    }
    // PRD-340: reply-implies-accept. `ConnectionsService.respondWithReply`
    // attaches the addressee's own reply to THIS SAME event, so it is posted
    // right after the intro message it may have just seeded above, in this
    // one sequential `await` chain, with no second write path that could race
    // it and land the reply before the request it is answering. Absent for
    // every plain `respond('accept', ...)`, so this is a no-op for the
    // ordinary Accept button.
    if (payload.replyBody) {
      await this.core.postMessage(
        conversation.id,
        payload.addresseeId,
        payload.replyBody,
      );
    }
  }
}
