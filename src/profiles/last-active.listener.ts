import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  SESSION_REFRESHED,
  SessionRefreshedEvent,
} from '../auth/session-activity.events';
import { LastActiveService } from './last-active.service';

/**
 * The only writer of the coarse "recently active" signal.
 *
 * WHY THE SESSION REFRESH AND NOTHING ELSE. A refresh is the cheapest honest
 * proof that a member is around: it happens because their client is open and
 * holding a session, it needs no new instrumentation, and it says nothing about
 * WHAT they were doing. Hanging this off page views, message sends or feed
 * reads would be behaviour tracking, which this platform does not do.
 *
 * The event carries a precise instant and this listener is where that precision
 * ends: `LastActiveService.recordActivity` coarsens it to the month before
 * anything is written, and skips the write entirely when the month has not
 * changed.
 */
@Injectable()
export class LastActiveListener {
  constructor(private readonly lastActive: LastActiveService) {}

  @OnEvent(SESSION_REFRESHED)
  async onSessionRefreshed(event: SessionRefreshedEvent): Promise<void> {
    await this.lastActive.recordActivity(event.userId, event.at);
  }
}
