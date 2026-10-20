import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  EVENT_CANCELLED,
  EVENT_DELETING,
  type EventCancelledEvent,
  type EventDeletingEvent,
} from '../events/event.events';
import {
  QUIZSHOW_OWNER_ERASING,
  type QuizshowOwnerErasingEvent,
} from './quizshow-owner-erasure.events';
import { quizshowWriteFailureCode } from './quizshow-persistence.service';
import { QuizshowRuntimeService } from './quizshow-runtime.service';

/**
 * A cancelled or deleted event ends its open Pulse Live sessions as abandoned.
 * A failure here is logged with its code and swallowed, so the cancel or the
 * delete never fails because of Pulse Live. An owner whose account is being
 * erased has the open sessions of their games ended the same way, before the
 * games cascade away with the account.
 */
@Injectable()
export class QuizshowEventLifecycleListener {
  private readonly logger = new Logger(QuizshowEventLifecycleListener.name);

  constructor(private readonly runtime: QuizshowRuntimeService) {}

  @OnEvent(EVENT_CANCELLED)
  async handleEventCancelled(payload: EventCancelledEvent): Promise<void> {
    await this.abandonSessions(payload.eventIds);
  }

  @OnEvent(EVENT_DELETING)
  async handleEventDeleting(payload: EventDeletingEvent): Promise<void> {
    await this.abandonSessions([payload.eventId]);
  }

  @OnEvent(QUIZSHOW_OWNER_ERASING)
  async handleOwnerErasing(payload: QuizshowOwnerErasingEvent): Promise<void> {
    try {
      await this.runtime.abandonSessionsOfOwner(payload.userId, Date.now());
    } catch (error: unknown) {
      this.logger.error(
        `Pulse Live games of an erased owner could not be ended: ${quizshowWriteFailureCode(error)}`,
      );
    }
  }

  private async abandonSessions(eventIds: string[]): Promise<void> {
    try {
      await this.runtime.abandonSessionsOfEvents(eventIds, Date.now());
    } catch (error: unknown) {
      this.logger.error(
        `Pulse Live sessions of ${eventIds.length} event(s) could not be abandoned: ${quizshowWriteFailureCode(error)}`,
      );
    }
  }
}
