import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  EVENT_DOOR_CHANGED,
  EventDoorChangedEvent,
  GATHERING_CHECKIN_FRAME,
  GatheringCheckInFrame,
} from '../events/event.events';
import { ChatGateway } from './chat.gateway';

/**
 * Relays a changed gathering door as the `gathering:checkin` frame, so every
 * device an organiser has open on that door refetches within a moment of a
 * check-in or undo made anywhere. Each organiser is addressed through their
 * own `user:<userId>` room alone: guests, other attendees and the gathering's
 * public audience never hear who went. The audience list comes from the
 * service that wrote the change, which builds it with the rule its routes
 * enforce (host plus co-hosts), so no second rule lives here.
 */
@Injectable()
export class GatheringDoorRelayListener {
  private readonly logger = new Logger(GatheringDoorRelayListener.name);

  constructor(private readonly chatGateway: ChatGateway) {}

  @OnEvent(EVENT_DOOR_CHANGED)
  handleDoorChanged(event: EventDoorChangedEvent): void {
    try {
      const frame: GatheringCheckInFrame = {
        eventSlug: event.eventSlug,
        memberSlug: event.memberSlug,
        change: event.change,
      };
      for (const organizerUserId of new Set(event.organizerUserIds)) {
        this.chatGateway.namespace
          ?.to(`user:${organizerUserId}`)
          .emit(GATHERING_CHECKIN_FRAME, frame);
      }
    } catch (error) {
      this.logger.error(
        `Failed to relay a door change: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
