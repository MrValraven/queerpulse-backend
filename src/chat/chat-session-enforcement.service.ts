import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { PresenceService } from './presence.service';
import {
  USER_SESSION_REVOKED,
  UserSessionRevokedEvent,
} from './session.events';

/** How often live sockets are re-checked against their member's CURRENT status. */
export const SESSION_SWEEP_INTERVAL_MS = 60_000;

/**
 * Periodic re-authorisation of live sockets against the members table.
 *
 * `ChatGateway` reads `status` from the JWT claim ONCE, at the handshake
 * (`authenticate`), and a socket then lives for the remaining life of that
 * access token — up to 15 minutes. HTTP has no equivalent hole: `JwtStrategy`
 * re-reads the row on every request, so a suspension or ban goes dark
 * immediately there. Websockets did not, so a member suspended for harassment
 * kept posting into DMs and groups, and kept receiving everyone else's
 * messages, for exactly the quarter of an hour that matters most.
 *
 * `USER_SESSION_REVOKED` (which the gateway already consumes by disconnecting
 * the member's whole `user:<id>` room) is emitted only from the auth/account
 * logout + token-reuse paths — a moderator suspension writes `status` and emits
 * nothing. Rather than reach into the moderation module, this sweep closes the
 * gap from the chat side: it re-reads the status of every member holding a live
 * socket and revokes anyone who is no longer `Active`. Suspension, ban,
 * deactivation and a deleted row are all covered by the same check, whichever
 * module performed the write.
 *
 * ONE query per tick regardless of how many members are online (a single
 * `IN (...)` batch keyed on the presence snapshot), and no query at all when
 * nobody is connected. The worst-case exposure drops from the token lifetime to
 * {@link SESSION_SWEEP_INTERVAL_MS}. The complementary half of this defence is
 * the `Active` assertion on the write path itself
 * (`MessagesService.sendMessage`), which makes a suspended member's send fail
 * immediately rather than at the next tick.
 *
 * SINGLE-REPLICA, like the rest of the gateway's socket state: `PresenceService`
 * is an in-memory map, so each instance sweeps only its own sockets. That is
 * exactly right per-instance (every replica runs this sweep over its own
 * presence map); it is the event fan-out to OTHER replicas that still needs
 * `@socket.io/redis-adapter` — see `ChatGateway.handleSessionRevoked`.
 */
@Injectable()
export class ChatSessionEnforcementService {
  private readonly logger = new Logger(ChatSessionEnforcementService.name);

  constructor(
    private readonly presence: PresenceService,
    private readonly users: UsersService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Interval('chat-session-revalidation', SESSION_SWEEP_INTERVAL_MS)
  async revalidateLiveSessions(): Promise<void> {
    const onlineUserIds = this.presence.onlineUserIds();
    if (!onlineUserIds.length) {
      return;
    }
    try {
      const users = await this.users.findByIdsWithProfile(onlineUserIds);
      const activeIds = new Set(
        users
          .filter((user) => user.status === UserStatus.Active)
          .map((user) => user.id),
      );
      for (const userId of onlineUserIds) {
        // Not in `activeIds` covers BOTH "row says suspended/banned/
        // deactivated" and "row no longer exists" — fail closed either way.
        if (activeIds.has(userId)) {
          continue;
        }
        this.logger.warn(
          `Revoking live sockets for ${userId}: no longer an active member`,
        );
        this.eventEmitter.emit(USER_SESSION_REVOKED, {
          userId,
        } satisfies UserSessionRevokedEvent);
      }
    } catch (error) {
      // A sweep failure must never crash the scheduler; the next tick retries.
      this.logger.error(
        `Live-session revalidation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
