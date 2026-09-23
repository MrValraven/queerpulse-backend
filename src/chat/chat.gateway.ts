import {
  BeforeApplicationShutdown,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  UseFilters,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { parseCookie } from 'cookie';
import * as Sentry from '@sentry/node';
import { DefaultEventsMap, Namespace, Socket } from 'socket.io';
import { In, IsNull, MoreThan, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { socketTicketService } from '../auth/socket-ticket.service';
import { DEFAULT_LOCKDOWN_MESSAGE } from '../common/lockdown.constants';
import { VALIDATION_PIPE_OPTIONS } from '../common/validation-pipe.options';
import {
  resolveAllowedOrigins,
  resolveFrontendOrigins,
} from '../config/frontend-origins';
import { ConnectionsService } from '../connections/connections.service';
import { Identity, IdentityKind } from '../identities/entities/identity.entity';
import { IdentitiesService } from '../identities/identities.service';
import {
  CONVERSATION_CREATED,
  CONVERSATION_MEMBERSHIP_REVOKED,
  ConversationCreatedEvent,
  ConversationMembershipRevokedEvent,
  MESSAGE_CREATED,
  MESSAGE_DELETED,
  MESSAGE_DELIVERED,
  MESSAGE_PINNED,
  MESSAGE_READ,
  MESSAGE_REACTION,
  MESSAGE_UPDATED,
  MessageCreatedEvent,
  MessageDeletedEvent,
  MessageDeliveredEvent,
  MessagePinnedEvent,
  MessageReadEvent,
  MessageReactionEvent,
  MessageUpdatedEvent,
} from '../messaging/messaging.events';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import {
  Conversation,
  ConversationKind,
} from '../messaging/entities/conversation.entity';
import { MessagingService } from '../messaging/messaging.service';
import { Message } from '../messaging/entities/message.entity';
import { MessageReaction } from '../messaging/entities/message-reaction.entity';
import {
  businessSeatUserIdsForViewer,
  collapseBusinessReactions,
  describeDirectThreadSeats,
  isDepartedStaffSeat,
  isEverySeatPersonal,
  loadReachableMailboxSeats,
  mailboxThreadPredicate,
  partitionMailboxThreadSeats,
} from '../messaging/mailbox-seats';
import type { MessageResponse } from '../messaging/message-response';
import {
  MessageLike,
  MessagingCoreService,
} from '../messaging/messaging-core.service';
import { BlockFilterService } from '../social/block-filter.service';
import {
  IDENTITY_BLOCKED,
  IdentityBlockedEvent,
  MEMBER_BLOCKED,
  MemberBlockedEvent,
} from '../social/social.events';
import {
  NOTIFICATION_CREATED,
  NotificationCreatedEvent,
} from '../notifications/notification.events';
import { toNotificationResponse } from '../notifications/notification-response';
import {
  PLATFORM_LOCKDOWN_ENABLED,
  PlatformLockdownEnabledEvent,
} from '../platform-settings/platform-settings.events';
import { MetricsService } from '../metrics/metrics.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { PreferencesService } from '../preferences/preferences.service';
import type { MessagingPrivacyDTO } from '../preferences/preferences-response';
import {
  MESSAGING_PRIVACY_SHARE_PRESENCE_CHANGED,
  MessagingPrivacySharePresenceChangedEvent,
} from '../preferences/preferences.events';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  ConversationJoinAck,
  ConversationLeaveAck,
  DeliveredPayload,
  JoinPayload,
  LeavePayload,
  ReadPayload,
  ReauthAck,
  ReauthPayload,
  SendMessagePayload,
  TypingPayload,
} from './dto/chat-payloads';
import {
  blockedPairUserIdsToEvict,
  countReactionsPerKey,
  latestTimestamp,
} from './mailbox-live-audience';
import { MailboxTypingAggregator } from './mailbox-typing-aggregator';
import { PresenceService } from './presence.service';
import {
  USER_SESSION_REVOKED,
  UserSessionRevokedEvent,
} from './session.events';
import { TokenBucketLimiter } from './ws-rate-limiter';
import { WsAllExceptionsFilter } from './ws-exception.filter';
import { ChatWsException, buildChatWsErrorFrame } from './ws-error';

/**
 * How often {@link ChatGateway.sweepIdleRateLimitBuckets} runs. ENG-211:
 * replaces the old "clear a user's buckets on their last disconnect"
 * behaviour, which was itself the bypass a flooding client needed. A minute
 * is frequent enough to keep the bucket maps from growing unbounded across a
 * busy day without adding meaningful CPU cost: the sweep is one in-memory
 * pass over however many DISTINCT users have sent a rate-limited event
 * recently.
 */
export const IDLE_BUCKET_SWEEP_INTERVAL_MS = 60_000;

/**
 * ENG-262: the longest `beforeApplicationShutdown` waits for in-flight
 * `message:send` calls to settle before force-disconnecting every socket. A
 * deploy's own hard ceiling (`main.ts`'s shutdown sequence) has to exceed
 * this by a comfortable margin or the process could exit before this wait is
 * even done, defeating the point of waiting at all.
 */
export const DRAIN_IN_FLIGHT_SEND_TIMEOUT_MS = 5_000;

/** How often {@link ChatGateway.waitForInFlightSendsToSettle} re-checks the
 *  in-flight count while draining. */
export const DRAIN_POLL_INTERVAL_MS = 50;

/**
 * ENG-260: `setTimeout`'s delay is a 32-bit signed integer internally; a
 * delay above this (~24.8 days) overflows and Node clamps it to a 1ms timer
 * instead of throwing (see Node's own `setTimeout` docs). `JWT_ACCESS_TTL`
 * above this (which `env.validation.ts` accepts, since it only checks that
 * the value parses as a positive duration) used to make
 * `scheduleTokenExpiry` arm exactly that ~1ms timer, so every socket got
 * force-dropped with `TOKEN_EXPIRED` moments after connecting.
 * `scheduleTokenExpiry` now chains timers of at most this length instead of
 * trusting one `setTimeout` call to survive all the way to `exp`.
 */
export const MAX_SET_TIMEOUT_DELAY_MS = 2_147_483_647;

/**
 * Handshake refusal that carries an admin-authored message, unlike every
 * other one.
 *
 * The handshake can refuse for several reasons (`UNAUTHORIZED`,
 * `SESSION_REVOKED`, `RATE_LIMITED`, `SERVER_ERROR`; see `authenticate` and
 * `handleConnection`'s catch block), and every one of those carries a fixed,
 * internal message string this server chose, on purpose: an unauthenticated
 * caller learns nothing about why from the text alone. A lockdown is the
 * exception, because it is not the client's credentials that are wrong, and
 * a client that cannot distinguish a lockdown from an ordinary refusal will
 * treat it as an expired token, refresh, and reconnect, in a loop, for the
 * whole lockdown, each attempt costing a JWT verify, a settings read and a
 * user lookup at exactly the moment you want less load. Carrying
 * `PLATFORM_LOCKED` (and the admin's own message, which the member is meant
 * to see) lets it back off instead.
 */
export class PlatformLockedWsException extends ChatWsException {
  constructor(lockdownMessage: string) {
    super('PLATFORM_LOCKED', lockdownMessage);
  }
}

/** Verified access-token claims we depend on for the WS handshake. */
interface AccessTokenClaims {
  sub: string;
  status: UserStatus;
  /** Standard JWT expiry, seconds since epoch. */
  exp: number;
  /**
   * The SESSION this token was minted for: the `refresh_tokens.family_id` of
   * the sign-in it descends from, assigned once and carried through every
   * rotation. `AuthService` signs it into every access token it mints, and
   * `JwtStrategy` reads the same claim on the HTTP path. See
   * `assertSessionLive` for why it is OPTIONAL and must stay that way.
   */
  sid?: string;
}

/**
 * Per-connection state we stash on `Socket.data` during the handshake. Typing
 * it (rather than leaving socket.io's default `any`) keeps every `client.data`
 * read/write checked instead of unsafe.
 */
interface ChatSocketData {
  userId?: string;
  exp?: number;
  expiryTimer?: NodeJS.Timeout;
  /**
   * The refresh-token FAMILY id (`AccessTokenClaims.sid`) this socket's
   * handshake token was minted for, when the token carries one. ENG-209:
   * `handleSessionRevoked` reads this to POSITIVELY identify the one socket
   * that belongs to a device actually named for revocation, and to tell
   * that one apart from every other socket in the member's `user:<id>`
   * room. Absent for a legacy token minted before the `sid` claim existed.
   * `assertSessionLive` admits that same legacy case at the handshake (the
   * signature alone proves authenticity); `handleSessionRevoked` treats it
   * oppositely and fails CLOSED there, because a legacy socket cannot be
   * proven to belong to a device other than the one being revoked.
   */
  sessionId?: string;
  /**
   * Set by `scheduleTokenExpiry` immediately before it disconnects a socket
   * for reaching its own token `exp`. This is a PLANNED drop the client is
   * expected to reconnect from within moments, distinct from a genuine loss
   * of connection.
   * `handleDisconnect` reads this to grant `PresenceService` a grace window
   * (ENG-219) instead of broadcasting the member offline and having
   * `PushMessageListener` push a DM they are still looking at.
   */
  isExpiring?: boolean;
}

type ChatSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  ChatSocketData
>;

/**
 * Task 13e: who a thread's live frames may reach. `personal` is a group, an
 * official thread, or a direct thread whose every seat is a profile
 * identity, and keeps the one conversation-room emit it always had.
 * `closed` is a thread that could not be established as personal and could
 * not be partitioned either (an unresolved or missing conversation, an
 * unresolved seat identity, or a mailbox thread `partitionMailboxThreadSeats`
 * could not split): nothing that could carry a staff member's identity is
 * relayed from it. Task 14: a mailbox thread whose customer blocked the
 * business is `closed` too, since it reaches nobody. `mailbox` is a
 * business mailbox thread, whose frames are rendered per viewer.
 */
type LiveThreadAudience =
  | { shape: 'personal' }
  | { shape: 'closed' }
  | {
      shape: 'mailbox';
      mailboxIdentityId: string;
      customerUserId: string;
      /** Live staff seats with no block against the customer, see
       *  `loadReachableMailboxSeats`. */
      reachableStaffUserIds: ReadonlySet<string>;
      /** The seats `businessSeatUserIdsForViewer` gives the customer,
       *  departed ones included: the seats the customer's REST view reads
       *  its read and delivered watermarks from, and the reactors it counts
       *  as the business. */
      businessSeats: ReadonlyArray<ConversationParticipant>;
    };

type MailboxLiveThreadAudience = Extract<
  LiveThreadAudience,
  { shape: 'mailbox' }
>;

/**
 * Enforce the frontend allowlist on the handshake itself.
 *
 * The `cors` block below does NOT protect this gateway: CORS is not applied to
 * raw WebSocket upgrades, and with polling disabled engine.io never runs the
 * cors layer at all, so that `origin` callback is effectively decorative. Until
 * this existed, the only thing preventing cross-site WebSocket hijacking was
 * `SameSite=Lax` on `access_token` keeping the browser from attaching the cookie
 * cross-site — real protection, but incidental, and it would have evaporated the
 * day someone set `sameSite: 'none'`. `allowRequest` runs on every handshake,
 * upgrade included.
 *
 * A missing `Origin` is allowed: non-browser clients (native apps, tests) do not
 * send one, and they are not the CSWSH threat model — that attack is a browser
 * on an attacker's page, which always sends its origin.
 *
 * ENG-261: reads `resolveAllowedOrigins()`, the SAME function `main.ts`'s
 * HTTP CORS calls, rather than the narrower `resolveFrontendOrigins()`,
 * which never unioned in the local Vite dev-server origin outside
 * production. Before this, a developer who pointed `FRONTEND_URL` at
 * something other than `localhost:5173` got HTTP CORS from both origins but
 * a socket handshake refused from `localhost:5173`, contradicting this
 * function's own "can never disagree" premise.
 */
function allowHandshakeOrigin(
  req: { headers: Record<string, string | string[] | undefined> },
  cb: (err: string | null, allow: boolean) => void,
): void {
  const raw = req.headers.origin;
  const origin = Array.isArray(raw) ? raw[0] : raw;
  if (!origin) {
    cb(null, true);
    return;
  }
  cb(null, resolveAllowedOrigins().includes(origin));
}

@WebSocketGateway({
  namespace: '/chat',
  allowRequest: allowHandshakeOrigin,
  cors: {
    // Resolve the allowlist at connection time rather than at
    // decorator-evaluation time — `process.env.FRONTEND_URL` is only guaranteed
    // to be populated once ConfigModule has loaded `.env`, which happens AFTER
    // this module is imported. Reading it inside the callback defers to
    // handshake time. Handing back the array (not a single string) makes the
    // underlying `cors` layer do a real allowlist match and reflect only the
    // matching origin. Shared with main.ts's HTTP CORS via
    // `resolveFrontendOrigins` so the two can't drift.
    //
    // Retained for the polling transport and for correct preflight replies if
    // `transports` is ever widened; `allowRequest` above is what actually
    // enforces the allowlist today.
    origin: (
      _origin: string | undefined,
      cb: (err: Error | null, allow?: boolean | string | string[]) => void,
    ) => cb(null, resolveFrontendOrigins()),
    credentials: true,
  },
  transports: ['websocket'],
})
@UseFilters(new WsAllExceptionsFilter())
// ONE validation contract, shared by both transports.
//
// `message:send` and `POST /conversations/:id/messages` land in the identical
// `MessagingService.sendMessage`, so they must be validated identically. This
// pipe used to list `whitelist` and `transform` by hand and omitted
// `forbidNonWhitelisted`, which meant an unknown body key was a 400 over HTTP
// and a silent strip over the socket: the same write accepted under weaker
// rules on the transport a client is most likely to get wrong (a hand-rolled
// `socket.emit` has no OpenAPI-ish contract to check itself against, so a typo
// like `replyTo` instead of `replyToId` was dropped on the floor and the
// message was persisted without its reply reference). Spreading
// `VALIDATION_PIPE_OPTIONS` (the same object `main.ts` binds globally) makes
// the two impossible to drift apart again.
//
// `transformOptions: { exposeUnsetFields: false }` comes along with the spread
// and is safe here: every `@SubscribeMessage` handler below reads named fields
// off the payload (`data.conversationId`, `data.replyToId`, ...) and passes
// them on as positional arguments or as a freshly-built literal. Nothing in
// this gateway spreads a WS payload over an entity, `Object.assign`s one, or
// asks whether a key was ABSENT versus present-and-undefined, which is the one
// case that option changes (see its doc comment in
// `common/validation-pipe.options.ts`).
//
// The `exceptionFactory` stays gateway-specific: HTTP wants the default
// `BadRequestException`, while a WS handler must throw `WsException` so
// `WsAllExceptionsFilter` can deliver it down the socket as an `exception`
// frame instead of crashing the handler. It is listed AFTER the spread so it
// keeps winning if the shared options ever grow one of their own.
@UsePipes(
  new ValidationPipe({
    ...VALIDATION_PIPE_OPTIONS,
    exceptionFactory: (errors) => new WsException(errors),
  }),
)
export class ChatGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy,
    BeforeApplicationShutdown
{
  @WebSocketServer() namespace!: Namespace;
  private readonly logger = new Logger(ChatGateway.name);
  // ENG-262: set by `beforeApplicationShutdown` before anything else runs, so
  // every write handler that checks it sees the drain from the very first
  // event loop turn after a shutdown signal arrives. `handleSend` is the only
  // write handler wired to it today (see its own comment for why the scope
  // stops there).
  private isDraining = false;
  // Counts `handleSend` calls between "entered the handler" and "the handler
  // settled" (its `finally` always decrements, success or throw), so
  // `beforeApplicationShutdown` can wait out whatever writes were already
  // accepted before it flipped `isDraining` rather than cutting one off
  // mid-persist.
  private inFlightSendCount = 0;

  // WS abuse limits — the global HTTP ThrottlerGuard skips WS contexts, so the
  // gateway owns its own per-user token buckets (keyed on client.data.userId).
  //
  // The send bucket is deliberately ALIGNED with the HTTP ceiling on the same
  // write: `POST /conversations/:id/messages` is throttled at 60 per 60s, and
  // both transports land in the identical `MessagesService.sendMessage` (which
  // fans out to push and to the whole room). At `refillPerSecond: 5` the socket
  // sustained 300 messages a minute — five times the number the HTTP limit was
  // tuned for — so a spammer simply used the socket. `capacity: 10` keeps the
  // burst headroom a real typing session needs; `refillPerSecond: 1` puts the
  // sustained rate at the same 60/min.
  private readonly messageLimiter = new TokenBucketLimiter({
    capacity: 10,
    refillPerSecond: 1,
  });
  private readonly typingLimiter = new TokenBucketLimiter({
    capacity: 10,
    refillPerSecond: 10,
  });
  // Delivered acks are already client-throttled (one "received up to now" stamp
  // per burst per conversation), but bound them here too — a misbehaving client
  // must not turn the receipt into a write amplifier.
  //
  // Capacity raised 10 → 20 for ENG-160: `conversation:message` (the
  // per-recipient fan-out) now schedules a delivered ack from EVERY
  // conversation a message lands in, not only the one open thread —  a
  // member reconnecting to a dozen-plus active threads at once can
  // legitimately fire that many acks within one `DELIVERED_ACK_DEBOUNCE_MS`
  // window (realtime.ts), one per conversation, all against this single
  // per-user bucket. 10 rejected a realistic dozen-thread catch-up outright;
  // 20 clears it with headroom while the sustained `refillPerSecond` (this
  // is a burst allowance, not the steady-state rate) stays unchanged.
  private readonly deliveredLimiter = new TokenBucketLimiter({
    capacity: 20,
    refillPerSecond: 5,
  });
  // ENG-163: `conversation:join`, `read` and `presence:snapshot` used to carry
  // NO bucket at all, even though each one costs a DB round-trip
  // (`canJoinConversationLive`, `markRead`'s UPDATE + room broadcast,
  // `getAcceptedConnectionUserIds`) that the HTTP `ThrottlerGuard` never sees —
  // the one transport a hostile or misbehaving client could hammer for
  // unbounded writes/broadcasts on this single-replica, ten-connection pool.
  //
  // A thread-open is roughly as rare per user as a send, so `joinLimiter`
  // mirrors `messageLimiter`'s numbers exactly.
  private readonly joinLimiter = new TokenBucketLimiter({
    capacity: 10,
    refillPerSecond: 1,
  });
  // `conversation:leave` (ENG-217) does no DB work at all (`client.leave` is
  // a local socket.io room membership change), but a client flipping through
  // threads still fires one join+leave pair per thread visited, so it stays
  // bounded with the same numbers as `joinLimiter`.
  private readonly leaveLimiter = new TokenBucketLimiter({
    capacity: 10,
    refillPerSecond: 1,
  });
  // A read watermark is legitimately far more frequent than a join — every
  // thread the member scrolls through can advance it — so this bucket is
  // sized well above `joinLimiter` while still bounding a flood.
  private readonly readLimiter = new TokenBucketLimiter({
    capacity: 20,
    refillPerSecond: 5,
  });
  // `presence:snapshot` is legitimately bursty right after a reconnect (a
  // fresh handshake already primes one via `emitPresenceSnapshot` outside this
  // bucket), but a client re-requesting it in a loop buys nothing and costs a
  // `getAcceptedConnectionUserIds` query each time.
  private readonly presenceSnapshotLimiter = new TokenBucketLimiter({
    capacity: 5,
    refillPerSecond: 1,
  });
  // ENG-211: the handshake itself used to be unmetered, so a client could
  // disconnect and reconnect indefinitely, paying only a JWT verify, a
  // lockdown settings read, a refresh-token existence check and a presence
  // fan-out each time, none of which any of the per-event buckets above ever
  // see (they are keyed on `client.data.userId`, which does not exist until
  // AFTER the handshake succeeds). Keyed on the VERIFIED user id
  // (`AccessTokenClaims.sub`, always this token's own signed-and-checked
  // subject) and consumed inside `authenticate` right after the token
  // verifies (see that method for why it runs before the lockdown/session
  // DB checks). 15-minute access-token
  // rotation plus a normal run of network flaps reconnects a handful of times
  // an hour; ten bursts with a sustained six a minute is far above that and
  // still well short of nuisance-load territory.
  private readonly handshakeLimiter = new TokenBucketLimiter({
    capacity: 10,
    refillPerSecond: 0.1,
  });
  // ENG-219: `session:reauth` is expected roughly once per access-token TTL
  // (~15 minutes) per open socket, even rarer than a reconnect, since it
  // replaces the reconnect the token's own expiry used to force. Mirrors
  // `handshakeLimiter`'s numbers exactly for the same reason: generous
  // headroom for a client that retries a few times after a transient
  // failure, nowhere near enough for a flooding client to turn this into a
  // free JWT-verification amplifier (each attempt costs a `jwt.verifyAsync`
  // plus, on a claim that verifies, the same lockdown/session-liveness DB
  // round-trips the handshake pays).
  private readonly reauthLimiter = new TokenBucketLimiter({
    capacity: 10,
    refillPerSecond: 0.1,
  });
  private idleBucketSweepTimer?: NodeJS.Timeout;
  // Task 13e: the business is typing while any of its staff is, see
  // `MailboxTypingAggregator`.
  private readonly mailboxTyping = new MailboxTypingAggregator();
  // Task 13e: the tail of each conversation's relay queue, see
  // `enqueueRelay`. An entry is removed once its queue drains.
  private readonly relayQueueByConversation = new Map<string, Promise<void>>();

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly presence: PresenceService,
    private readonly messaging: MessagingService,
    private readonly connections: ConnectionsService,
    private readonly users: UsersService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly metrics: MetricsService,
    // Read-side only, and for a single `exists` on one indexed column: the
    // handshake asks whether the session behind the presented access token is
    // still live (`assertSessionLive`). `AuthService` owns every write to this
    // table. Injecting the repository rather than `AuthService` keeps the edge
    // out of `ChatModule` a TypeORM feature registration instead of a module
    // import. `AuthModule` pulls membership, vouch, connections and
    // media-crops in behind it, all for one `exists` query.
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    // Read-side only, and for one `conversationId`-indexed lookup: ENG-160's
    // per-recipient fan-out (`fanOutConversationMessage`) needs the
    // conversation's participant user ids to reach members who have not
    // joined its socket room. `MessagingService`'s facade exposes no such
    // method (its owning services are a different workstream's territory this
    // wave), so this mirrors `PushMessageListener`'s identical direct
    // repository injection for the same entity, rather than growing the
    // facade for a one-query need.
    @InjectRepository(ConversationParticipant)
    private readonly conversationParticipants: Repository<ConversationParticipant>,
    // PRD-354: `fanOutConversationMessage` skips a GROUP participant blocked
    // either way with the sender, one batched query per send.
    private readonly blockFilter: BlockFilterService,
    // PRD-364: reciprocal read-receipt/typing/presence sharing — gates
    // `handleTyping`'s relay, `handleMessageRead`'s relay, and every presence
    // broadcast/snapshot below.
    private readonly preferences: PreferencesService,
    // Task 13: `resolveTypingSenderIdentity` resolves the sender's mailbox
    // identity (kind + display name + full staff roster) off their own seat
    // in the conversation, so a business/persona/company typing frame names
    // the identity and excludes every colleague's room, never just the one
    // human who typed.
    private readonly identities: IdentitiesService,
    // Task 13e: renders a business mailbox thread's message frames once per
    // viewer through `toMessageResponses`, the renderer the REST read uses,
    // so each live payload is exactly what that viewer's REST read returns.
    private readonly messagingCore: MessagingCoreService,
  ) {}

  /**
   * ENG-211: starts the periodic sweep that keeps every token-bucket map
   * bounded WITHOUT resetting a bucket that is still mid-drain (see
   * `sweepIdleRateLimitBuckets` and `TokenBucketLimiter.sweepIdle` for why
   * that distinction is the whole point). `.unref()`'d so a pending sweep
   * never keeps the process alive on shutdown.
   */
  onModuleInit(): void {
    const timer = setInterval(
      () => this.sweepIdleRateLimitBuckets(),
      IDLE_BUCKET_SWEEP_INTERVAL_MS,
    );
    timer.unref?.();
    this.idleBucketSweepTimer = timer;
  }

  onModuleDestroy(): void {
    if (this.idleBucketSweepTimer) {
      clearInterval(this.idleBucketSweepTimer);
    }
  }

  /**
   * ENG-262: the gateway's drain step, run by Nest's shutdown sequence
   * (`app.close()`, whether invoked directly or by a SIGTERM/SIGINT handler
   * in `main.ts`) after every provider's `onModuleDestroy` and before the
   * server actually stops accepting connections. Refuses new writes first,
   * waits out whatever writes were already accepted, and only then drops
   * every open socket, so a deploy no longer cuts an in-flight
   * `message:send` write off mid-persist with no warning to the socket that
   * held it.
   *
   * Scoped to `message:send` today (`isDraining`/`inFlightSendCount`, wired
   * into `handleSend`) rather than every write handler in this gateway; the
   * other write handlers (`read`, `conversation:join`, …) are not covered by
   * this pass.
   */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.isDraining = true;
    this.logger.log(
      `Draining chat gateway for shutdown (signal: ${signal ?? 'unknown'})`,
    );
    await this.waitForInFlightSendsToSettle();
    // Force-drop every open socket rather than leaving them for the
    // transport to notice this process is gone: the frontend's realtime
    // client (queerpulse/src/shared/api/realtime.ts) treats a
    // server-initiated `disconnect` (`reason === 'io server disconnect'`) as
    // reconnectable, scheduling its own exponential-backoff reconnect, so
    // `close: true` is safe here and reconnects every client against
    // whichever instance comes up next, instead of the ~ping-timeout delay
    // of an unannounced transport close.
    this.namespace?.disconnectSockets(true);
  }

  /**
   * Polls {@link inFlightSendCount} down to zero, bounded by
   * {@link DRAIN_IN_FLIGHT_SEND_TIMEOUT_MS} so a `message:send` handler stuck
   * on a slow query cannot hang the whole shutdown sequence indefinitely.
   */
  private async waitForInFlightSendsToSettle(): Promise<void> {
    const deadline = Date.now() + DRAIN_IN_FLIGHT_SEND_TIMEOUT_MS;
    while (this.inFlightSendCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, DRAIN_POLL_INTERVAL_MS),
      );
    }
    if (this.inFlightSendCount > 0) {
      this.logger.warn(
        `Chat gateway shutdown proceeding with ${this.inFlightSendCount} in-flight message:send call(s) still unsettled after ${DRAIN_IN_FLIGHT_SEND_TIMEOUT_MS}ms`,
      );
    }
  }

  private sweepIdleRateLimitBuckets(): void {
    const now = Date.now();
    this.messageLimiter.sweepIdle(now);
    this.typingLimiter.sweepIdle(now);
    this.deliveredLimiter.sweepIdle(now);
    this.joinLimiter.sweepIdle(now);
    this.leaveLimiter.sweepIdle(now);
    this.readLimiter.sweepIdle(now);
    this.presenceSnapshotLimiter.sweepIdle(now);
    this.handshakeLimiter.sweepIdle(now);
    this.reauthLimiter.sweepIdle(now);
    this.mailboxTyping.sweep(now);
  }

  async handleConnection(client: ChatSocket): Promise<void> {
    try {
      const { userId, exp, sessionId } = await this.authenticate(client);
      // `authenticate` awaits a JWT verify and up to two DB queries, and the
      // client may have already disconnected somewhere in that window (a
      // closed tab, a flaky network). Bail out here, BEFORE any side effect
      // runs: `handleDisconnect` only cleans up a socket whose `userId` is
      // set, so a dead socket that reached this point would otherwise mark
      // itself online forever (`presence.add`) and leave the connection
      // counter (`metrics.incrementWebsocketConnections`) permanently
      // inflated, since nothing will ever call the balancing decrement for
      // it.
      if (!client.connected) {
        return;
      }
      client.data.userId = userId;
      client.data.exp = exp;
      client.data.sessionId = sessionId;
      // Count the live socket now that it is authenticated. Set BEFORE any step
      // that can throw: a later failure disconnects the socket, and
      // handleDisconnect (which sees `userId` set) decrements to rebalance.
      this.metrics.incrementWebsocketConnections();
      await client.join(`user:${userId}`);
      // A socket must not outlive its 15-min access token; drop it at expiry
      // so the client reconnects with a freshly-refreshed cookie. A FALSE
      // return means `exp` was already in the past by the time this ran (an
      // extremely tight race between `authenticate`'s own token-expiry check
      // and this scheduling step) and the socket was dropped immediately, so
      // stop here: the next line must never mark that already-dead socket
      // present.
      if (!this.scheduleTokenExpiry(client, exp)) {
        return;
      }
      if (this.presence.add(userId, client.id)) {
        await this.broadcastPresence(userId, true);
      }
      // Prime the client with who among its connections is already online.
      await this.emitPresenceSnapshot(client, userId);
    } catch (err) {
      this.logger.debug(
        `WS handshake auth rejected: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      if (err instanceof ChatWsException) {
        // Every DELIBERATE refusal (bad/missing/expired credential, inactive
        // membership, signed-out session, lockdown, handshake rate limit)
        // already carries its own code and, for a lockdown, the admin's
        // actual message (see `authenticate`).
        client.emit('exception', err.getError());
      } else {
        // ENG-221: anything else is an INFRASTRUCTURE failure mid-handshake
        // (a DB error in `assertSessionLive`/`assertNotLockedOut`, a presence
        // snapshot or broadcast failure). Before this branch existed every
        // one of these was flattened into the same generic `Unauthorized` a
        // bad credential gets, so the client spent a refresh-token rotation
        // on a blip that a plain retry would have fixed, and if that
        // rotation also failed the socket stayed disconnected with
        // reconnection disabled.
        this.logger.error(
          err instanceof Error ? (err.stack ?? err.message) : String(err),
        );
        if (process.env.SENTRY_DSN) {
          Sentry.captureException(err);
        }
        client.emit(
          'exception',
          buildChatWsErrorFrame('SERVER_ERROR', 'Internal server error'),
        );
      }
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: ChatSocket): Promise<void> {
    const timer = client.data.expiryTimer;
    if (timer) {
      clearTimeout(timer);
    }
    const userId = client.data.userId;
    if (!userId) {
      return;
    }
    // Balances the increment in handleConnection (only reached once `userId` is
    // set, i.e. only for sockets that were counted).
    this.metrics.decrementWebsocketConnections();
    // ENG-219: a drop caused by `scheduleTokenExpiry` is a PLANNED reconnect,
    // so grace it: a member reconnecting within the window never gets
    // reported offline (and never has `PushMessageListener` push them a DM
    // they are still looking at) for a gap that exists purely because the
    // gateway enforces its own token TTL. A genuine disconnect (tab closed,
    // network dropped) carries no such flag and gets no grace, exactly as
    // before.
    const wentOffline = this.presence.remove(userId, client.id, {
      isGraced: client.data.isExpiring === true,
      onGraceExpired: () => {
        this.broadcastPresence(userId, false).catch((error: unknown) => {
          // A rejected promise with no `.catch` and no SENTRY_DSN set would
          // otherwise be an unhandled rejection, which Node's default
          // behaviour is to crash the process over (this callback runs off a
          // bare `setTimeout` in `PresenceService`, so there is no
          // surrounding `try`/`catch` or gateway exception filter to save it).
          this.logger.error(
            `Failed to broadcast offline presence after grace expiry for ${userId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      },
    });
    if (wentOffline) {
      await this.broadcastPresence(userId, false);
    }
    // ENG-211: buckets are NO LONGER cleared here. Freeing a user's buckets
    // the instant their last socket dropped meant a flooding client could
    // exhaust its bucket, disconnect, reconnect, and start over on a fresh
    // one: the rate limit only ever held for as long as a single socket
    // stayed open. `sweepIdleRateLimitBuckets` reclaims memory for buckets
    // that have fully refilled instead, which bounds the map without
    // reopening that hole.
  }

  @SubscribeMessage('conversation:join')
  async handleJoin(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() data: JoinPayload,
  ): Promise<ConversationJoinAck> {
    const userId = this.requireUserId(client);
    // ENG-207: RETURNS a refusal ack for either of the two EXPECTED outcomes
    // below, so a client that reads the ack (as well as the happy path) can
    // retry or surface the refusal instead of silently leaving the thread
    // outside its room until the socket happens to reconnect. A validation
    // failure never reaches here at all, since the gateway's
    // `ValidationPipe` throws before this handler runs.
    if (!this.joinLimiter.tryConsume(userId)) {
      return { ok: false, code: 'RATE_LIMITED' };
    }
    // Stricter than plain participation (P0 hardening): also refuses a
    // participant who left/was removed from a group (no live room for them —
    // history stays reachable over HTTP) and a DM whose counterpart is
    // blocked either way (so a block also cuts off live message/typing
    // reception, not just new sends). See `canJoinConversationLive`'s doc.
    if (
      !(await this.messaging.canJoinConversationLive(
        data.conversationId,
        userId,
      ))
    ) {
      return { ok: false, code: 'FORBIDDEN' };
    }
    await client.join(data.conversationId);
    return { ok: true, joined: data.conversationId };
  }

  @SubscribeMessage('conversation:leave')
  handleLeave(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() data: LeavePayload,
  ): ConversationLeaveAck {
    const userId = this.requireUserId(client);
    // No DB work at all (`client.leave` only mutates local socket.io room
    // membership), so the ONLY possible refusal is the rate limit. The uuid
    // validation on `conversationId` already stops a client from leaving a
    // room it had no business joining in the first place (e.g. another
    // member's `user:<id>` room), so there is no separate authorisation check
    // to make here the way `handleJoin` has to.
    if (!this.leaveLimiter.tryConsume(userId)) {
      return { ok: false, code: 'RATE_LIMITED' };
    }
    void client.leave(data.conversationId);
    return { ok: true, left: data.conversationId };
  }

  @SubscribeMessage('message:send')
  async handleSend(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() data: SendMessagePayload,
  ): Promise<void> {
    // ENG-262: refused up front, before it counts as in-flight, once
    // `beforeApplicationShutdown` has started draining. None of the
    // existing `ChatWsErrorCode`s fit a transient "the server is restarting"
    // refusal (`RATE_LIMITED`/`SERVER_ERROR` carry the wrong retry semantics
    // for an authenticated write, `PLATFORM_LOCKED` is TERMINAL on the
    // frontend, see queerpulse/src/shared/api/realtime.ts's `goTerminal`
    // branch), so this falls through the gateway's existing generic path: a
    // plain `WsException` that `WsAllExceptionsFilter` classifies as
    // `BAD_REQUEST` and only logs at debug level.
    if (this.isDraining) {
      throw new WsException(
        'Server is restarting, please retry your message shortly',
      );
    }
    this.inFlightSendCount += 1;
    try {
      const userId = this.requireUserId(client);
      if (!this.messageLimiter.tryConsume(userId)) {
        throw new ChatWsException(
          'RATE_LIMITED',
          'You are sending messages too quickly',
        );
      }
      // Single write path: persists + emits MESSAGE_CREATED → broadcast below.
      // `clientMessageId` makes this idempotent against the HTTP POST path.
      await this.messaging.sendMessage(
        data.conversationId,
        userId,
        data.body,
        data.replyToId,
        data.clientMessageId,
        undefined, // forwarded — the WS path never forwards
        data.kind,
        data.attachment,
        data.stickerId,
        // Task 13: identity parity with the HTTP send path. Absent, this
        // resolves server-side to the caller's own profile identity;
        // present, it passes through the exact same `assertMaySendAs` guard
        // `MessagingCoreService` already runs for HTTP, so no new
        // authorization code is needed here.
        data.asIdentityId,
      );
    } finally {
      this.inFlightSendCount -= 1;
    }
  }

  @SubscribeMessage('typing')
  async handleTyping(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() data: TypingPayload,
  ): Promise<void> {
    // socket.io-client flushes frames it buffered while disconnected (this
    // one included) the instant the transport reconnects, and Nest binds
    // this handler without awaiting `handleConnection`'s `authenticate`
    // (a JWT verify plus up to two DB queries), so a buffered frame can
    // legitimately arrive before `client.data.userId` is set. `typing` is
    // advisory, so that race is dropped silently here, before ever reaching
    // `requireUserId`, which would throw `UNAUTHORIZED` at a client that did
    // nothing wrong.
    if (!client.data.userId) {
      return;
    }
    const userId = this.requireUserId(client);
    // Only members who have joined the conversation room may broadcast typing.
    // Silently drop rather than throw when the room isn't joined yet: `typing`
    // is advisory (see the rate-limit branch below), and `conversation:join` is
    // an async handler racing this fire-and-forget frame — a client that opens a
    // thread and types immediately (or reconnects) legitimately lands here for a
    // sub-millisecond window before `client.join` completes. `WsAllExceptionsFilter`
    // now correctly classifies a bare refusal here as BAD_REQUEST either way
    // (ENG-212), so erroring would no longer burn the
    // Sentry quota the way it originally did, but it would still hand the client
    // an exception frame for a race that is nobody's fault, on every occurrence.
    // The security invariant still holds regardless of which way this is
    // handled (a socket not in the room does not broadcast into it), and the
    // composer re-emits `typing:true` every ~2s, so the indicator still
    // appears once the join lands.
    if (!client.rooms.has(data.conversationId)) {
      return;
    }
    if (!this.typingLimiter.tryConsume(userId)) {
      // Silently drop — typing is advisory; no need to error the client.
      return;
    }
    // PRD-364: reciprocal — a member who has turned off typing sharing never
    // lets their own typing reach anyone else. Checked AFTER the rate limit
    // (a cheap in-memory check) so an abusive client that has already been
    // throttled doesn't also cost a preferences read.
    const senderPrivacy = await this.preferences.getMessagingPrivacy(userId);
    if (!senderPrivacy.shareTyping) {
      return;
    }
    // CW-12: captured up front, ahead of the lookups below. A business seat
    // now awaits three lookups (`excludedUserRooms`, `resolveTypingSenderIdentity`,
    // `loadLiveThreadAudience`) before `mailboxTyping.record`'s own call
    // further down, and every awaited millisecond a later `Date.now()` would
    // include there narrows the gap `MailboxTypingAggregator`'s TTL measures
    // a lone typist's refresh against, risking a dropped refresh the
    // indicator reads as a blink. Stamping it here keeps that gap to the DB
    // work this one frame itself requires.
    const typingRecordedAt = Date.now();
    // CW-09: one shared query serves both lookups below. Each used to issue
    // its own `conversationParticipants.find({ where: { conversationId } })`
    // on every typing frame. The select covers what either needs: `userId`
    // for `excludedUserRooms`, plus `identityId` and `leftAt` for
    // `resolveTypingSenderIdentity`.
    const typingSeats = await this.conversationParticipants.find({
      where: { conversationId: data.conversationId },
      select: { userId: true, identityId: true, leftAt: true },
    });
    // `client.to(room)` excludes only the SENDING SOCKET, not the sending user.
    // A member signed in on two devices (phone + laptop) has two sockets in this
    // room, so without `.except` their own "typing" frame echoes to their other
    // device and renders as "the other person is typing". Exclude the sender's
    // whole `user:<id>` room so none of their own devices ever see it — typing is
    // only ever meaningful about OTHER participants. PRD-364 also excludes every
    // OTHER participant who has turned off their own typing sharing: reciprocal,
    // so opting out also means never seeing anyone else's typing.
    const excludedUserRooms = await this.excludedUserRooms(
      data.conversationId,
      userId,
      (privacy) => privacy.shareTyping,
      typingSeats,
    );
    // Mailboxes (Task 13): the sender's OWN seat in this thread may speak
    // for a business/persona/company identity, see
    // `resolveTypingSenderIdentity`'s own doc. A mailbox seat broadcasts the
    // IDENTITY, carrying no human id anywhere in the frame, and excludes
    // the identity's whole staff roster, so no colleague sees the business
    // typing at itself.
    const senderIdentity = await this.resolveTypingSenderIdentity(
      data.conversationId,
      userId,
      typingSeats,
    );
    if (senderIdentity) {
      // Task 14a: a staff member who has left the business neither speaks
      // for it nor hears it. A departed sender's socket may still sit in the
      // room, so its frame is dropped here, before it can touch the business
      // typing state below, and every departed colleague's room is excluded
      // from the frame alongside the current roster.
      if (senderIdentity.isSenderDeparted) {
        return;
      }
      // A persona that moderation removed speaks no more: every write for it
      // is refused with IDENTITY_REMOVED, so its staff type to nobody.
      if (senderIdentity.isIdentityRemoved) {
        return;
      }
      // Task 14: the sender speaks for the business only while their own
      // seat reaches the thread under every mailbox rule
      // (`loadReachableMailboxSeats`, which composes
      // `isSeatExcludedFromMailbox`). A thread whose customer blocked the
      // business reads `closed`, and a staff member blocked with the
      // customer is outside the reachable staff, so a socket of either kind
      // still in the room types to nobody, whether or not the eviction has
      // landed.
      const typingAudience = await this.loadLiveThreadAudience(
        data.conversationId,
      );
      if (
        typingAudience.shape !== 'mailbox' ||
        !typingAudience.reachableStaffUserIds.has(userId)
      ) {
        return;
      }
      // Task 13e: one typing state per business, see
      // `MailboxTypingAggregator`. `null` means the frame would change
      // nothing the customer sees: a colleague is still typing, or the
      // business already said it is typing within the refresh interval.
      const isBusinessTyping = this.mailboxTyping.record(
        data.conversationId,
        senderIdentity.identityId,
        userId,
        data.isTyping,
        typingRecordedAt,
      );
      if (isBusinessTyping === null) {
        return;
      }
      client
        .to(data.conversationId)
        .except([
          ...senderIdentity.staffUserRooms,
          ...senderIdentity.departedStaffUserRooms,
          ...excludedUserRooms,
        ])
        .emit('typing', {
          conversationId: data.conversationId,
          identityId: senderIdentity.identityId,
          displayName: senderIdentity.displayName,
          isTyping: isBusinessTyping,
        });
      return;
    }
    // Task 13e: a customer typing on a business mailbox thread reaches the
    // reachable staff alone, so a blocked or departed staff member whose
    // socket is still in the room sees nothing. A closed thread relays
    // nothing.
    const audience = await this.loadLiveThreadAudience(data.conversationId);
    if (audience.shape === 'closed') {
      return;
    }
    if (audience.shape === 'mailbox') {
      const excludedRooms = new Set(excludedUserRooms);
      const frame = {
        conversationId: data.conversationId,
        userId,
        isTyping: data.isTyping,
      };
      await this.emitToJoinedSockets(
        data.conversationId,
        'typing',
        new Map(
          [...audience.reachableStaffUserIds]
            .filter(
              (staffUserId) =>
                staffUserId !== userId &&
                !excludedRooms.has(`user:${staffUserId}`),
            )
            .map((staffUserId) => [staffUserId, frame]),
        ),
      );
      return;
    }
    client
      .to(data.conversationId)
      .except([`user:${userId}`, ...excludedUserRooms])
      .emit('typing', {
        conversationId: data.conversationId,
        userId,
        isTyping: data.isTyping,
      });
  }

  @SubscribeMessage('read')
  async handleRead(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() data: ReadPayload,
  ): Promise<void> {
    const userId = this.requireUserId(client);
    if (!this.readLimiter.tryConsume(userId)) {
      throw new ChatWsException(
        'RATE_LIMITED',
        'You are marking messages read too quickly',
      );
    }
    await this.messaging.markRead(data.conversationId, userId, {
      upToMessageId: data.upToMessageId,
    });
  }

  @SubscribeMessage('delivered')
  async handleDelivered(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() data: DeliveredPayload,
  ): Promise<void> {
    // Same buffered-frame race `handleTyping` guards against: a `delivered`
    // ack queued while disconnected can flush on reconnect before
    // `handleConnection`'s (unawaited, from Nest's point of view) handshake
    // has set `client.data.userId`. Advisory and monotonic, so it is dropped
    // silently here too, before it can throw `UNAUTHORIZED` at a legitimate
    // client.
    if (!client.data.userId) {
      return;
    }
    const userId = this.requireUserId(client);
    // Advisory like typing: over the limit we silently drop rather than error —
    // the watermark is monotonic, so a skipped ack is corrected by the next one.
    if (!this.deliveredLimiter.tryConsume(userId)) {
      return;
    }
    // Persist the delivered watermark + emit MESSAGE_DELIVERED (relayed below).
    // `markDelivered` re-checks participation, so an un-joined caller is refused.
    await this.messaging.markDelivered(data.conversationId, userId);
  }

  @SubscribeMessage('presence:snapshot')
  async handlePresenceSnapshot(
    @ConnectedSocket() client: ChatSocket,
  ): Promise<void> {
    const userId = this.requireUserId(client);
    if (!this.presenceSnapshotLimiter.tryConsume(userId)) {
      throw new ChatWsException(
        'RATE_LIMITED',
        'You are requesting presence too quickly',
      );
    }
    await this.emitPresenceSnapshot(client, userId);
  }

  /**
   * ENG-219: re-authenticates the OPEN socket against either a
   * freshly-minted access token OR a redeemed single-use socket ticket, so
   * `scheduleTokenExpiry`'s scheduled drop can be rescheduled to the new
   * `exp` instead of the client having to drop and reconnect (a full history
   * reconcile plus two inbox invalidates) at every access-token rotation.
   *
   * Exactly one of `data.token`/`data.ticket` is expected (see
   * `ReauthPayload`'s own doc). A payload carrying neither is a malformed
   * request rather than a credential rejection, answered `BAD_REQUEST`
   * WITHOUT dropping the socket or spending the `reauthLimiter` bucket,
   * ahead of every other check below.
   *
   * SECURITY: whichever proof is presented, it is turned into the SAME
   * `AccessTokenClaims` shape and run through the SAME checks a fresh
   * handshake would:
   *   1. `data.token` → `verifyAccessToken`, the identical
   *      `JwtService.verifyAsync` call `authenticate` uses (same secret,
   *      `algorithms: ['HS256']` pinned), which rejects a malformed token, a
   *      bad/absent signature, and an already-expired one, all by
   *      construction. Usable by a non-browser client that holds its own
   *      access token; the browser SPA never sends this field, since
   *      `access_token` is `httpOnly` and never reaches JavaScript.
   *      `data.ticket` → `socketTicketService.redeem`, keyed on THIS
   *      socket's own already-authenticated `userId` (never on anything the
   *      payload claims), so a ticket minted for a different account cannot
   *      extend this socket. `redeem` also enforces single use (see its own
   *      doc) and the ticket's short TTL; either failure collapses to the
   *      same refusal a bad token gets. The ticket's `status`/`exp` were
   *      baked in at MINT time (`AuthController.mintSocketTicket`, a
   *      DB-fresh read at that moment) rather than re-read here, and stay
   *      exactly as fresh as a real access token's own claims are: never
   *      fresher and never weaker.
   *   2. `payload.sub === userId`: the verified subject must be the SAME
   *      user this socket authenticated as at handshake time. Without this
   *      check a socket could present a perfectly valid token minted for a
   *      DIFFERENT account and adopt that account's expiry/claims while
   *      still occupying THIS user's rooms and presence, a full identity
   *      swap smuggled through a "renew" frame. Checked before any DB work.
   *      (For the ticket path this is redundant with `redeem`'s own
   *      same-user check, and kept anyway for parity between the two
   *      branches.)
   *   3. `assertClaimsAdmitted`: the SAME status-active, platform-lockdown,
   *      and refresh-token-family-still-live checks `authenticate` runs, so
   *      a member who was suspended, whose device was signed out, or who is
   *      caught by a lockdown enacted since the handshake (or since the
   *      ticket was minted), is refused here exactly as a fresh reconnect
   *      would refuse them. This is the check that keeps re-auth from
   *      becoming a way to outlive a revocation, on EITHER path.
   *
   * ANY failure (a bad/expired/malformed/unknown-or-already-used credential
   * (1), a different user's credential (2), or a claim `authenticate` would
   * also refuse (3)) takes the EXACT SAME drop `scheduleTokenExpiry` already
   * uses for a routine expiry (`dropSocketForExpiredOrInvalidCredential`):
   * mark `isExpiring`, emit `TOKEN_EXPIRED`, disconnect. Reusing that one
   * drop path rather than inventing a second way to end a socket is
   * deliberate: a `session:reauth` frame is presented over an
   * ALREADY-AUTHENTICATED connection, so a malicious or buggy client that
   * can reach this handler at all has already cleared the handshake once;
   * the only new capability this frame grants is "extend", never "escalate",
   * and any rejection collapses to the one drop path already proven to
   * leave no session live. `RATE_LIMITED` is the one exception:
   * `reauthLimiter` guards call VOLUME alone, so it is refused without
   * dropping the socket. The original handshake credential's own expiry
   * timer (never cleared until a reauth actually SUCCEEDS) remains the
   * fallback either way.
   */
  @SubscribeMessage('session:reauth')
  async handleReauth(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() data: ReauthPayload,
  ): Promise<ReauthAck> {
    const userId = this.requireUserId(client);
    if (!data.token && !data.ticket) {
      return { ok: false, code: 'BAD_REQUEST' };
    }
    if (!this.reauthLimiter.tryConsume(userId)) {
      return { ok: false, code: 'RATE_LIMITED' };
    }
    let payload: AccessTokenClaims;
    try {
      payload = data.ticket
        ? this.claimsFromSocketTicket(data.ticket, userId)
        : await this.verifyAccessToken(data.token!);
      if (payload.sub !== userId) {
        throw new ChatWsException('UNAUTHORIZED', 'Unauthorized');
      }
      await this.assertClaimsAdmitted(payload);
    } catch (err) {
      this.logger.debug(
        `WS reauth rejected for ${userId}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      this.dropSocketForExpiredOrInvalidCredential(client);
      return {
        ok: false,
        code: err instanceof ChatWsException ? err.code : 'SERVER_ERROR',
      };
    }
    // Success: the ORIGINAL expiry timer (armed for the handshake token's own
    // `exp`) must be cleared before arming a new one, or the old timer's
    // closure, which still captures the OLD `exp`, fires on schedule and
    // drops a socket that just proved it holds a valid, newer credential.
    const previousExpiryTimer = client.data.expiryTimer;
    if (previousExpiryTimer) {
      clearTimeout(previousExpiryTimer);
    }
    client.data.exp = payload.exp;
    client.data.sessionId = payload.sid;
    if (!this.scheduleTokenExpiry(client, payload.exp)) {
      // The new `exp` was already in the past by the time this ran (an
      // extremely tight race, mirroring the same one `handleConnection`
      // guards against). `scheduleTokenExpiry` has already dropped the
      // socket via the same shared path, so there is nothing left to
      // acknowledge as a success.
      return { ok: false, code: 'TOKEN_EXPIRED' };
    }
    return { ok: true, exp: payload.exp };
  }

  @OnEvent(MESSAGE_CREATED)
  handleMessageCreated(payload: MessageCreatedEvent): Promise<void> {
    return this.enqueueRelay(payload.conversationId, () =>
      this.relayMessageCreated(payload),
    );
  }

  private async relayMessageCreated(
    payload: MessageCreatedEvent,
  ): Promise<void> {
    // Task 13e: `payload.response` is rendered for the SENDER. On a business
    // mailbox thread one payload cannot be right for both sides (a staff
    // sender's own view names them to the customer), so the thread's
    // audience is established first, and only a thread confirmed personal
    // takes the room emit below. A lookup failure delivers nothing: the
    // message is committed, and every client reconciles it on its next
    // fetch.
    try {
      const audience = await this.loadLiveThreadAudience(
        payload.conversationId,
      );
      if (audience.shape === 'mailbox') {
        await this.relayMailboxMessageCreated(payload, audience);
        return;
      }
      if (audience.shape === 'closed') {
        await this.emitToOwnJoinedSockets(
          payload.conversationId,
          payload.message.senderId,
          'message:new',
          { conversationId: payload.conversationId, message: payload.response },
        );
        return;
      }
    } catch (err) {
      this.logger.error(
        `Failed to resolve the live audience for message:new: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return;
    }
    // Broadcast the frontend-contract `response` (not the internal `MessageView`)
    // so live clients patch it straight into the thread cache and reconcile the
    // sender's optimistic bubble by `clientMessageId` — no refetch.
    this.namespace?.to(payload.conversationId).emit('message:new', {
      conversationId: payload.conversationId,
      message: payload.response,
    });
    // ENG-160: the room emit above reaches only sockets that have JOINED this
    // conversation (via `conversation:join`) — a member browsing another page,
    // or with a DIFFERENT thread open, is connected but not in this room, so
    // without the fan-out below they got no badge bump, no inbox row and no
    // in-app signal until a remount/reload. Task 13e: awaited inside this
    // conversation's relay queue (`enqueueRelay`), so a later frame for the
    // same conversation never overtakes it. It catches its own failures, so
    // the message write, already committed, is unaffected.
    await this.fanOutConversationMessage(payload);
  }

  /**
   * Reach every OTHER, still-active participant's `user:<id>` room with a
   * lightweight "a message landed in this conversation" signal, regardless of
   * whether their socket has joined the conversation room — the gap
   * `message:new` above leaves open (ENG-160). Mirrors the `user:<id>`
   * fan-out convention `handleConversationCreated`/`handleNotificationCreated`
   * already use for "reach a member who isn't in this specific room".
   *
   * The client (`realtime.ts`) patches its conversation-list cache and unread
   * badge from `conversation:message` without a refetch — see
   * `patchConversationPreview` in `messageCache.ts`. A participant who DOES
   * have the thread open receives both this frame and the room's `message:new`
   * for the same message; the client-side patch is idempotent (a re-affirming
   * no-op), which is simpler and cheaper than tracking room membership here to
   * suppress the duplicate.
   *
   * Deliberately does NOT reuse the `message:new` event itself: that frame
   * also drives `upsertMessage` (writing into the per-thread message cache)
   * and the delivered-receipt ack, both of which are specifically about a
   * thread the recipient has OPEN — overloading it here would silently widen
   * what "delivered" means. This event carries only what the inbox needs.
   *
   * PRD-354: a block does not dissolve a GROUP (a blocked pair can still
   * share one), so without a filter here a blocked-either-way member kept
   * getting a live "new message" signal for everything the blocked sender
   * posted, forever. A DM/official thread is exempt: a block already
   * prevents sending there in the first place (`requireActiveParticipant`),
   * mirroring that method's own exemption shape.
   */
  private async fanOutConversationMessage(
    payload: MessageCreatedEvent,
  ): Promise<void> {
    try {
      const participants = await this.conversationParticipants.find({
        where: { conversationId: payload.conversationId },
        // ENG-239: only the two columns this fan-out actually reads. The
        // default full-row `find` pulled every participant column
        // (including each member's own possibly-5000-char `draft`) for
        // every participant of every single message sent.
        select: { userId: true, leftAt: true },
      });
      // One extra lightweight lookup, shared by every participant below
      // rather than re-queried per recipient.
      const conversation = await this.conversationParticipants.manager.findOne(
        Conversation,
        { where: { id: payload.conversationId }, select: { kind: true } },
      );
      // A sender erased mid-flight (ENG-243 makes senderId nullable) has no
      // block relations left to honour, so the filter is skipped for them.
      const senderId = payload.message.senderId;
      const blockedSenderUserIds =
        conversation?.kind === ConversationKind.Group && senderId
          ? await this.blockFilter.blockedUserIds(
              senderId,
              participants.map((participant) => participant.userId),
            )
          : new Set<string>();
      for (const participant of participants) {
        // Never signal the sender about their own send, never a member who
        // left/was removed (mirrors `PushMessageListener`'s identical filter
        // for the same event), and never a GROUP member blocked either way
        // with the sender (PRD-354).
        if (
          participant.userId === payload.message.senderId ||
          participant.leftAt != null ||
          blockedSenderUserIds.has(participant.userId)
        ) {
          continue;
        }
        this.namespace
          ?.to(`user:${participant.userId}`)
          .emit('conversation:message', {
            conversationId: payload.conversationId,
            message: payload.response,
          });
      }
    } catch (err) {
      this.logger.error(
        `Failed to fan out conversation:message: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  @OnEvent(MESSAGE_UPDATED)
  handleMessageUpdated(payload: MessageUpdatedEvent): Promise<void> {
    return this.enqueueRelay(payload.conversationId, () =>
      this.relayMessageUpdated(payload),
    );
  }

  private async relayMessageUpdated(
    payload: MessageUpdatedEvent,
  ): Promise<void> {
    // Task 13e: `payload.message` is rendered for the EDITOR, so a mailbox
    // thread gets one payload per viewer, exactly as `handleMessageCreated`
    // does. Only a thread confirmed personal takes the room emit.
    try {
      const audience = await this.loadLiveThreadAudience(
        payload.conversationId,
      );
      if (audience.shape !== 'personal') {
        await this.relayMailboxMessageUpdated(payload, audience);
        return;
      }
    } catch (err) {
      this.logger.error(
        `Failed to relay message:updated: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return;
    }
    this.namespace?.to(payload.conversationId).emit('message:updated', payload);
  }

  /**
   * A new conversation (a group) was created: notify EACH member's
   * `user:<id>` room so their inbox refetches live. The members weren't in the
   * conversation room yet (they join it when they open the thread), so a
   * room-scoped `message:new` would miss them — this is the user-room fan-out
   * that gets the new group in front of them. Carries only the id; the client
   * invalidates `["conversations"]` and re-fetches the DTO.
   */
  @OnEvent(CONVERSATION_CREATED)
  handleConversationCreated(payload: ConversationCreatedEvent): void {
    for (const memberUserId of payload.memberUserIds) {
      this.namespace
        ?.to(`user:${memberUserId}`)
        .emit('conversation:new', { conversationId: payload.conversationId });
    }
  }

  @OnEvent(MESSAGE_READ)
  handleMessageRead(payload: MessageReadEvent): Promise<void> {
    return this.enqueueRelay(payload.conversationId, () =>
      this.relayMessageRead(payload),
    );
  }

  private async relayMessageRead(payload: MessageReadEvent): Promise<void> {
    // Async `@OnEvent` doing DB work: the emitter awaits nothing, so an
    // unhandled rejection here would surface as a process-level warning with
    // no context rather than a logged failure. Wrapped exactly like
    // `handleMemberBlocked`. A dropped read relay costs a stale "Seen" on
    // someone's screen until the next fetch, never a failed request: the
    // watermark itself is already committed by `markRead`.
    try {
      // PRD-364: `ConversationsService.markRead` already withholds this event
      // entirely when the READER (`payload.userId`) has turned off read-receipt
      // sharing (see its own doc). What remains here is the RECIPIENT side of
      // the same reciprocal rule: a participant who has turned off their own
      // sharing must not receive anyone else's read state either, so exclude
      // every such participant's `user:<id>` room from the relay.
      const excludedUserRooms = await this.excludedUserRooms(
        payload.conversationId,
        payload.userId,
        (privacy) => privacy.shareReadReceipts,
      );
      // Task 13e: a staff member's read would name them to the customer, and
      // reads as the customer's own read to every colleague. A mailbox
      // thread relays per viewer, see `relayMailboxReceipt`.
      const audience = await this.loadLiveThreadAudience(
        payload.conversationId,
      );
      if (audience.shape === 'closed') {
        return;
      }
      if (audience.shape === 'mailbox') {
        await this.relayMailboxReceipt(
          'read',
          payload,
          audience,
          new Set(excludedUserRooms),
          () => this.latestBusinessReadAt(audience, payload.lastReadAt),
        );
        return;
      }
      this.namespace
        ?.to(payload.conversationId)
        .except(excludedUserRooms)
        .emit('read', payload);
    } catch (err) {
      this.logger.error(
        `Failed to relay a read receipt: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  @OnEvent(MESSAGE_DELIVERED)
  handleMessageDelivered(payload: MessageDeliveredEvent): Promise<void> {
    return this.enqueueRelay(payload.conversationId, () =>
      this.relayMessageDelivered(payload),
    );
  }

  private async relayMessageDelivered(
    payload: MessageDeliveredEvent,
  ): Promise<void> {
    // Task 13e: the same per-viewer relay as `read` on a mailbox thread,
    // see `relayMailboxReceipt`. Wrapped like `handleMessageRead`: the
    // watermark is already committed, so a failure costs a stale tick.
    try {
      const audience = await this.loadLiveThreadAudience(
        payload.conversationId,
      );
      if (audience.shape === 'closed') {
        return;
      }
      if (audience.shape === 'mailbox') {
        await this.relayMailboxReceipt(
          'message:delivered',
          payload,
          audience,
          new Set<string>(),
          () =>
            Promise.resolve(
              latestTimestamp([
                payload.deliveredAt,
                ...audience.businessSeats.map((seat) => seat.deliveredAt),
              ]) ?? payload.deliveredAt,
            ),
        );
        return;
      }
    } catch (err) {
      this.logger.error(
        `Failed to relay a delivered receipt: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return;
    }
    // Relayed to the whole conversation room; the SENDER's client uses the
    // `userId` (the recipient who acked) + `deliveredAt` to advance its
    // one-check → two-check tick. `deliveredAt` is a Date here; socket.io
    // serialises it to an ISO string on the wire (as with `read`'s lastReadAt).
    this.namespace
      ?.to(payload.conversationId)
      .emit('message:delivered', payload);
  }

  @OnEvent(MESSAGE_REACTION)
  handleMessageReaction(payload: MessageReactionEvent): Promise<void> {
    return this.enqueueRelay(payload.conversationId, () =>
      this.relayMessageReaction(payload),
    );
  }

  private async relayMessageReaction(
    payload: MessageReactionEvent,
  ): Promise<void> {
    // Task 13e: staff see each colleague's reaction, and the customer sees
    // the business react once, see `relayMailboxReaction`.
    try {
      const audience = await this.loadLiveThreadAudience(
        payload.conversationId,
      );
      if (audience.shape === 'closed') {
        return;
      }
      if (audience.shape === 'mailbox') {
        // Task 13h: a reaction on a message at or before a co-manager's
        // mailbox staff floor is part of history they do not have, so it
        // never reaches them.
        await this.relayMailboxReaction(
          payload,
          audience,
          await this.messagingCore.loadMailboxStaffFlooredUserIds(
            payload.conversationId,
            payload.messageId,
          ),
        );
        return;
      }
    } catch (err) {
      this.logger.error(
        `Failed to relay a reaction: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return;
    }
    this.namespace?.to(payload.conversationId).emit('reaction', payload);
  }

  @OnEvent(MESSAGE_DELETED)
  handleMessageDeleted(payload: MessageDeletedEvent): Promise<void> {
    // Task 13e: through the same relay queue and audience as every other
    // frame, see `relayToThreadAudience`.
    return this.enqueueRelay(payload.conversationId, () =>
      this.relayToThreadAudience(
        payload.conversationId,
        'message:deleted',
        payload,
        { messageId: payload.messageId, shouldIncludeDeletedMessage: true },
      ),
    );
  }

  @OnEvent(MESSAGE_PINNED)
  handleMessagePinned(payload: MessagePinnedEvent): Promise<void> {
    // Pins are shared: relay to the whole conversation room so BOTH participants
    // refresh the pinned-messages banner (and patch the message's pin state) —
    // no blanket thread invalidation. Task 13e: on a mailbox thread "the
    // whole room" is the thread's audience, see `relayToThreadAudience`.
    return this.enqueueRelay(payload.conversationId, () =>
      this.relayToThreadAudience(
        payload.conversationId,
        'message:pinned',
        payload,
        { messageId: payload.messageId, shouldIncludeDeletedMessage: false },
      ),
    );
  }

  /**
   * Task 13e: every conversation-scoped relay goes through here, so each
   * conversation's frames leave in the order their events arrived. The
   * handlers above do DB work before they emit, and without one queue a
   * quick frame (a delete) could overtake a slower one (the `message:new`
   * for the same message) and a client would re-add a message already
   * deleted. `EventEmitter2` calls each listener synchronously in emit
   * order, and every handler enqueues before its first `await`, so the
   * queue order is the event order. Different conversations never wait on
   * each other. Each relay catches its own failures; the `catch` here is a
   * backstop, so one failed relay never stalls the frames behind it.
   *
   * CW-13 (accepted residual): this chain carries no `Promise.race` timeout
   * and no explicit length cap of its own. A cap stays implicit: the chain
   * only grows as long as there are relays in flight for the one
   * conversation, and every DB call a relay awaits already carries the
   * pool's own 10s/30s timeouts, giving a stuck relay a bound on how long it
   * can hold the queue. This stays a recorded, accepted residual: either
   * addition (a race timeout, a hard length cap) changes what a client sees
   * on a relay that is merely slow, and that is a deliberate design decision
   * for whoever next reviews this queue on purpose, kept separate from this
   * narrow cleanup-wave pass.
   *
   * CW-14 (accepted residual): `handleDelivered` also relays through this
   * per-conversation queue (Task 13e unified every conversation-scoped
   * relay through it), so a group's delivered-ack DB lookup can now sit
   * ahead of the next `message:new` for the same conversation, adding that
   * lookup's latency to the new-message frame. This stays as it is: keeping
   * every relay of one conversation in this single ordered queue is exactly
   * what prevents a delivered ack from racing ahead of the `message:new` it
   * may reference.
   */
  private enqueueRelay(
    conversationId: string,
    relay: () => Promise<void>,
  ): Promise<void> {
    const previousRelay =
      this.relayQueueByConversation.get(conversationId) ?? Promise.resolve();
    const queuedRelay = previousRelay.then(relay).catch((error: unknown) => {
      this.logger.error(
        `A live relay failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    });
    this.relayQueueByConversation.set(conversationId, queuedRelay);
    void queuedRelay.then(() => {
      if (this.relayQueueByConversation.get(conversationId) === queuedRelay) {
        this.relayQueueByConversation.delete(conversationId);
      }
    });
    return queuedRelay;
  }

  /**
   * Task 13e: a frame that is the same for every viewer, sent to whoever
   * may receive the thread's frames. A personal thread keeps its one room
   * emit. A mailbox thread sends it to the customer and the reachable staff
   * alone, so a blocked or departed staff member whose socket is still in
   * the room receives nothing. A closed thread relays nothing.
   *
   * Task 13h review M5: a frame about one message (a pin, an unpin, a
   * delete) names it in `aboutMessage`, and on a mailbox thread it skips
   * every staff member whose history floor covers that message, as the
   * edit and reaction relays do. A deleted message is already soft-deleted
   * when its frame goes out, so the delete relay reads it whatever its
   * `deleted_at`.
   */
  private async relayToThreadAudience(
    conversationId: string,
    event: string,
    frame: unknown,
    aboutMessage?: { messageId: string; shouldIncludeDeletedMessage: boolean },
  ): Promise<void> {
    try {
      const audience = await this.loadLiveThreadAudience(conversationId);
      if (audience.shape === 'closed') {
        return;
      }
      if (audience.shape === 'mailbox') {
        const flooredUserIds = aboutMessage
          ? await this.messagingCore.loadMailboxStaffFlooredUserIds(
              conversationId,
              aboutMessage.messageId,
              {
                shouldIncludeDeletedMessage:
                  aboutMessage.shouldIncludeDeletedMessage,
              },
            )
          : new Set<string>();
        await this.emitToJoinedSockets(
          conversationId,
          event,
          new Map(
            [audience.customerUserId, ...audience.reachableStaffUserIds]
              .filter((userId) => !flooredUserIds.has(userId))
              .map((userId) => [userId, frame]),
          ),
        );
        return;
      }
    } catch (err) {
      this.logger.error(
        `Failed to relay ${event}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return;
    }
    this.namespace?.to(conversationId).emit(event, frame);
  }

  /**
   * Evict a member's sockets from a conversation room they may no longer
   * receive from (removed from a group, left one).
   *
   * Room membership was authorised exactly ONCE, by `handleJoin`; every
   * broadcast after that (`message:new`, `typing`, `read`, `message:delivered`,
   * `reaction`, `message:deleted`, `message:pinned`) is a blind `to(room)`
   * emit. Without this eviction a removed member kept a live subscription to
   * every one of those frames until their socket reconnected — silently undoing
   * both the HTTP read path's `leftAt` ceiling and `canJoinConversationLive`'s
   * refusal to let them back in.
   *
   * `socketsLeave` (not `disconnectSockets`): the member's OTHER conversations,
   * notifications and presence are untouched — only this room is cut.
   *
   * SINGLE-REPLICA ONLY, same caveat as {@link handleSessionRevoked}.
   */
  @OnEvent(CONVERSATION_MEMBERSHIP_REVOKED)
  handleConversationMembershipRevoked(
    payload: ConversationMembershipRevokedEvent,
  ): void {
    for (const userId of payload.userIds) {
      this.namespace?.in(`user:${userId}`).socketsLeave(payload.conversationId);
    }
  }

  /**
   * Task 14: a member blocked a whole business, persona or company, which
   * severs every thread between them for both sides. The member's sockets
   * and every staff socket of that identity, departed seats included, leave
   * the room of each such thread through
   * {@link handleConversationMembershipRevoked}, one call per thread, and
   * nobody else's sockets move. `canJoinConversationLive` already refuses a
   * fresh join from either side, and lifting the block needs no event, since
   * a rejoin passes through that same gate.
   *
   * Async because the thread ids have to be resolved first; failures are
   * logged here, since the block has already been written.
   */
  @OnEvent(IDENTITY_BLOCKED)
  async handleIdentityBlocked(payload: IdentityBlockedEvent): Promise<void> {
    try {
      const evictions = await this.identityBlockEvictions(
        payload.blockerUserId,
        payload.identityId,
      );
      for (const eviction of evictions) {
        this.handleConversationMembershipRevoked(eviction);
      }
    } catch (error) {
      this.logger.error(
        `Failed to evict a blocked business's threads from their rooms: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * A block severs the pair's live DM room in BOTH directions.
   *
   * `canJoinConversationLive` already refuses a fresh join from either side
   * once a block exists, and `sendMessage`/`createConversation` refuse the
   * write — but sockets already inside the room were never pushed out, so the
   * blocked member kept receiving the blocker's messages, typing indicators and
   * read receipts. Both entry points that place a block
   * (`SocialService.blockMember`, `ConnectionsService.respond('block')`) emit
   * {@link MEMBER_BLOCKED}, so which button was pressed no longer decides
   * whether the block takes effect live.
   *
   * Async because the DM room ids have to be resolved first; the emitter
   * awaits nothing, so failures are logged here rather than surfacing to the
   * blocker's request (which has already committed).
   */
  @OnEvent(MEMBER_BLOCKED)
  async handleMemberBlocked(payload: MemberBlockedEvent): Promise<void> {
    try {
      const conversationIds = await this.messaging.directConversationIdsBetween(
        payload.blockerId,
        payload.blockedId,
      );
      for (const conversationId of conversationIds) {
        this.namespace
          ?.in(`user:${payload.blockerId}`)
          .socketsLeave(conversationId);
        this.namespace
          ?.in(`user:${payload.blockedId}`)
          .socketsLeave(conversationId);
      }
    } catch (err) {
      this.logger.error(
        `Failed to evict blocked pair from their DM room: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
    // Task 13e: `directConversationIdsBetween` leaves business mailbox
    // threads out, since a block there removes only the blocked staff
    // member's own access. Those threads are handled here, in their own
    // `try` so neither eviction can stop the other: only the staff member's
    // sockets leave the room, and the customer and every colleague stay.
    // `canJoinConversationLive` already refuses that staff member a new
    // join.
    try {
      const evictions = await this.mailboxEvictionsForBlock(
        payload.blockerId,
        payload.blockedId,
      );
      for (const { conversationId, userId } of evictions) {
        this.namespace?.in(`user:${userId}`).socketsLeave(conversationId);
      }
    } catch (err) {
      this.logger.error(
        `Failed to evict a blocked staff member from a mailbox thread: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * Push a newly-created notification to its recipient's live sockets.
   *
   * Fans out to the `user:${userId}` room (joined at handshake, so this reaches
   * every tab that member has open) rather than a conversation room — a
   * notification is addressed to one person, not to a thread.
   *
   * The socket event is `notification:new`; the internal event-emitter topic it
   * listens to is `notification.created`. Different namespaces, same as
   * MESSAGE_CREATED → `message:new` above.
   */
  @OnEvent(NOTIFICATION_CREATED)
  handleNotificationCreated(payload: NotificationCreatedEvent): void {
    // Emit the hand-mapped response DTO, never the raw entity — its `payload`
    // is opaque jsonb whose allowlist projection (`toNotificationResponse` →
    // `toClientPayload`) strips content-bearing fields like `excerpt` before
    // they cross the wire (finding M6, backstopping H3). The client refetches
    // the feed on this frame for its full render, so the actor is resolved
    // there; passing `undefined` keeps this handler query-free (it does no DB
    // work), matching the raw-entity relay it replaces (which carried no
    // resolved actor either).
    this.namespace
      ?.to(`user:${payload.userId}`)
      .emit(
        'notification:new',
        toNotificationResponse(payload.notification, undefined),
      );
  }

  /**
   * Force-drop a member's live sockets (logout / "sign out this device" /
   * "log out other devices" / suspension / token reuse / the 60s liveness
   * sweep). Auth emits {@link USER_SESSION_REVOKED}.
   *
   * The `SESSION_REVOKED` `exception` frame is TERMINAL on the frontend: it
   * turns reconnection off, because the whole point of the code is "this
   * credential is done, do not try again with it". That means the frame may
   * ONLY go to a socket this handler can POSITIVELY identify as the revoked
   * one. `payload.sessionId` is the refresh-token FAMILY id being revoked,
   * when the emitter can name it:
   * - PRESENT (`AccountService.revokeSession`, "sign out this device"): a
   *   socket whose `data.sessionId` matches EXACTLY is the revoked device,
   *   confirmed, so it gets the frame and is dropped. Every socket whose
   *   `data.sessionId` is a DIFFERENT known family is left alone entirely.
   *   A socket whose token predates the `sid` claim cannot be told apart
   *   from the revoked device by this check, so it is disconnected too, but
   *   WITHOUT the frame: it may well be a different, uninvolved device, and
   *   a plain `disconnect(true)` merely sends it through its normal
   *   reconnect, whose handshake (`assertSessionLive`) re-authenticates it
   *   independently and only then tells it `SESSION_REVOKED` if that check
   *   also finds it revoked. `fetchSockets` (not a blind room emit) is
   *   required because each socket's `data.sessionId` has to be inspected;
   *   there is no per-socket-attribute filter on a broadcast operator.
   * - ABSENT (a single-device logout via `AuthService.revokeRefreshToken`,
   *   "log out other devices" via `AccountService.revokeOtherSessions`, a
   *   revoke-all, a suspension, or the 60s sweep in
   *   `ChatSessionEnforcementService`): this handler cannot tell WHICH of the
   *   member's sockets, if any, are the ones actually revoked (a
   *   single-device logout affects one device out of possibly several; "log
   *   out other devices" affects every device EXCEPT the caller's own), so
   *   it never asserts `SESSION_REVOKED` here. The whole room gets a plain
   *   `disconnect(true)` with no frame instead, and each socket's own
   *   reconnect handshake sorts out the truth: a genuinely revoked device is
   *   told `SESSION_REVOKED` there (by `assertSessionLive`/the status
   *   check), and a device that is still signed in simply reconnects and
   *   keeps working. Before this existed, EVERY socket on this path was told
   *   the terminal frame regardless of whether it was actually the one being
   *   signed out, which killed realtime on every device left standing: the
   *   still-signed-in phone when the laptop logged out, or the clicking
   *   device itself on "log out other devices".
   *
   * SINGLE-REPLICA ONLY. This reaches sockets held by THIS instance. There is no
   * Redis adapter configured (see ThrottlerModule's note in app.module.ts), so
   * with 2+ replicas a revoked member keeps a live socket on every instance that
   * did not handle the logout. Adding replicas requires @socket.io/redis-adapter
   * wired via `app.useWebSocketAdapter` before this is safe.
   */
  @OnEvent(USER_SESSION_REVOKED)
  async handleSessionRevoked(payload: UserSessionRevokedEvent): Promise<void> {
    const room = `user:${payload.userId}`;
    if (!payload.sessionId) {
      this.namespace?.in(room).disconnectSockets(true);
      return;
    }
    const frame = buildChatWsErrorFrame(
      'SESSION_REVOKED',
      'This device was signed out',
    );
    const sockets = await this.namespace?.in(room).fetchSockets();
    for (const socket of sockets ?? []) {
      const socketSessionId = (socket.data as ChatSocketData).sessionId;
      if (socketSessionId === payload.sessionId) {
        socket.emit('exception', frame);
        socket.disconnect(true);
      } else if (socketSessionId === undefined) {
        socket.disconnect(true);
      }
    }
  }

  /**
   * Drop every live socket the moment an admin turns the lockdown on.
   *
   * `assertNotLockedOut` only runs at the handshake, so without this a socket
   * opened before the flip keeps sending and receiving for the remaining life
   * of its 15-minute access token: HTTP would go dark within one request while
   * chat stayed live for a quarter of an hour.
   *
   * A BLANKET disconnect that emits NO `exception` frame first, in contrast
   * to `handleSessionRevoked` above: staff are meant to reconnect anyway (the
   * frontend already reconnects on its own after any unexplained
   * server-initiated drop), and a non-staff member who tries is told
   * `PLATFORM_LOCKED` at the handshake itself
   * (`assertNotLockedOut`/`PlatformLockedWsException`), which is the frame
   * that actually carries the admin's message. A blanket disconnect that also
   * fanned out a frame to a role we have not looked up yet would buy nothing
   * here that the handshake refusal doesn't already say better, at the cost
   * of a broadcast that could not be role-filtered anyway (see below).
   *
   * Filtering by role here would buy nothing and would cost a database lookup
   * per connected socket at the worst possible moment, so this stays blanket
   * and lets the handshake do the per-role sorting on reconnect.
   *
   * SINGLE-REPLICA ONLY, for the same reason as `handleSessionRevoked` above:
   * this reaches sockets held by THIS instance, and there is no Redis adapter
   * configured (see ThrottlerModule's note in app.module.ts). With 2+ replicas,
   * sockets on instances that did not handle the PATCH survive until their
   * token expires. Adding replicas requires @socket.io/redis-adapter wired via
   * `app.useWebSocketAdapter` before this is safe.
   */
  @OnEvent(PLATFORM_LOCKDOWN_ENABLED)
  handleLockdownEnabled(payload: PlatformLockdownEnabledEvent): void {
    this.logger.warn(
      `Lockdown enabled by ${payload.actorId} — disconnecting all live sockets`,
    );
    this.namespace?.disconnectSockets(true);
  }

  // --- internals ---

  private requireUserId(client: ChatSocket): string {
    const userId = client.data.userId;
    if (!userId) {
      throw new ChatWsException('UNAUTHORIZED', 'Unauthorized');
    }
    return userId;
  }

  /**
   * Verifies a raw JWT string exactly the way the handshake always has: same
   * secret, same pinned algorithm, same "any failure is UNAUTHORIZED"
   * collapse. Does nothing else, no rate limiting, no lockdown/session
   * checks, so both call sites below can layer their OWN policy (the
   * handshake bucket for `authenticate`, `reauthLimiter` for
   * `handleReauth`) around an identical credential check. ENG-219 pulled
   * this out of `authenticate` so `session:reauth` verifies a token exactly
   * as strictly as a fresh handshake would, by construction, rather than by
   * two call sites happening to agree.
   */
  private async verifyAccessToken(raw: string): Promise<AccessTokenClaims> {
    // Read BEFORE the try, deliberately: a missing/misconfigured secret is
    // OUR infrastructure problem, so it must surface as `SERVER_ERROR`
    // (propagating uncaught to `handleConnection`'s catch block, ENG-221).
    // Kept outside the credential-failure branch below so it stays that way.
    const secret = this.config.getOrThrow<string>('auth.jwtAccessSecret');
    try {
      // verifyAsync rejects for every kind of bad token: an expired or
      // tampered signature (a `jsonwebtoken` error), but also a malformed
      // token whose base64 segments do not even decode to JSON, which the
      // underlying `jws` library lets escape as a raw `SyntaxError` rather
      // than one of `jsonwebtoken`'s own error classes. A failed verify is a
      // credential failure BY DEFINITION regardless of which error shape it
      // throws, so every rejection here becomes `UNAUTHORIZED` without
      // needing to recognise the error's type first (this used to sniff for
      // specific jsonwebtoken error names, see git history, and silently
      // let the `SyntaxError` case fall through to `SERVER_ERROR`, an
      // unauthenticated, Sentry-reported crash report for what was always
      // just a bad token).
      return await this.jwt.verifyAsync<AccessTokenClaims>(raw, {
        secret,
        algorithms: ['HS256'],
      });
    } catch {
      throw new ChatWsException('UNAUTHORIZED', 'Unauthorized');
    }
  }

  /**
   * The ticket half of `handleReauth`'s two credential branches. Redeems
   * `ticket` against THIS socket's own already-authenticated `userId`, never
   * anything the payload itself claims (mirrors `authenticate` reading
   * `payload.sub` only from a VERIFIED token, never from client input), and,
   * on success, reshapes the ticket's baked-in record into the same
   * `AccessTokenClaims` a verified JWT would have produced, so every caller
   * downstream (the `payload.sub === userId` check, `assertClaimsAdmitted`)
   * treats the two branches identically.
   *
   * A `null` redemption covers unknown, already used, expired, and minted
   * for a different user (see `SocketTicketService.redeem`'s own doc for why
   * those cases collapse to one outcome), and becomes the exact same
   * `UNAUTHORIZED` a bad token gets, so the caller's `catch` block cannot
   * tell the two branches' failures apart either.
   */
  private claimsFromSocketTicket(
    ticket: string,
    userId: string,
  ): AccessTokenClaims {
    const record = socketTicketService.redeem(ticket, userId);
    if (!record) {
      throw new ChatWsException('UNAUTHORIZED', 'Unauthorized');
    }
    return {
      sub: record.userId,
      status: record.status,
      exp: record.exp,
      sid: record.sessionId,
    };
  }

  /**
   * The claims-level checks a verified token still has to clear: active
   * membership, platform lockdown, and the refresh-token family behind it
   * still being live. Shared between `authenticate` (the handshake) and
   * `handleReauth` (`session:reauth`, ENG-219) so re-authenticating a live
   * socket can never admit a credential a fresh handshake would refuse.
   */
  private async assertClaimsAdmitted(
    payload: AccessTokenClaims,
  ): Promise<void> {
    // Enforce active membership on the WS path (parity with ActiveMemberGuard).
    // The credential itself already verified, so the refusal code is
    // `SESSION_REVOKED`: the SESSION behind it is what is gone, the same
    // distinction `assertSessionLive` draws below for a signed-out
    // refresh-token family.
    if (payload.status !== UserStatus.Active) {
      throw new ChatWsException('SESSION_REVOKED', 'Unauthorized');
    }
    // Platform lockdown, repeated here because PlatformLockdownGuard governs
    // HTTP only, so without this, websockets stay wide open during a
    // lockdown. The role has to come from the database: the access token
    // carries `sub`, `status` and `exp`, but no role claim.
    await this.assertNotLockedOut(payload.sub);
    // Ordered AFTER the lockdown check on purpose: `platformSettings.get()` is
    // served from an in-process cache, so an unlocked platform pays nothing for
    // it, and a LOCKED one refuses here without ever spending the query below,
    // which is exactly when the gateway is being retried by every signed-in
    // member at once. A revoked device refused during a lockdown is told
    // `PLATFORM_LOCKED` rather than `Unauthorized`, which is the friendlier of
    // the two answers and the one that makes the client back off hardest.
    await this.assertSessionLive(payload.sid);
  }

  private async authenticate(
    client: ChatSocket,
  ): Promise<{ userId: string; exp: number; sessionId?: string }> {
    const fromAuth = client.handshake.auth?.token as string | undefined;
    const fromCookie = parseCookie(client.handshake.headers.cookie ?? '')[
      'access_token'
    ];
    const raw = fromAuth ?? fromCookie;
    if (!raw) {
      throw new ChatWsException('UNAUTHORIZED', 'Unauthorized');
    }
    const payload = await this.verifyAccessToken(raw);
    // ENG-211: metered right after the token verifies. A VERIFIED user id is
    // required so a client cannot burn a stranger's bucket by claiming their
    // `sub` in an unsigned/garbage token, and this runs BEFORE the
    // lockdown/session checks below, which are the DB round-trips this
    // exists to bound. See
    // `handshakeLimiter`'s own doc for the numbers.
    if (!this.handshakeLimiter.tryConsume(payload.sub)) {
      throw new ChatWsException(
        'RATE_LIMITED',
        'You are reconnecting too quickly',
      );
    }
    await this.assertClaimsAdmitted(payload);
    return { userId: payload.sub, exp: payload.exp, sessionId: payload.sid };
  }

  /**
   * Throws unless the refresh-token FAMILY this access token was minted for is
   * still alive.
   *
   * "Sign out this device" on the security page revokes a family and emits
   * {@link USER_SESSION_REVOKED} carrying that family's id, which
   * {@link handleSessionRevoked} above turns into a one-shot drop of the ONE
   * socket whose handshake token matches it. That drop is the whole story
   * only for a socket that is open at that instant. The signed-out
   * device still holds a valid access token for the rest of its 15-minute TTL,
   * so it simply reconnected and was let straight back in, because the
   * handshake asked only whether the token verified. The member was told the
   * device was signed out while it went on receiving direct messages and
   * presence. This is the check that makes the security page's promise true on
   * the socket path, the same way `JwtStrategy.validate` makes it true on the
   * HTTP path.
   *
   * SEMANTICS MIRROR `JwtStrategy.isSessionLive` EXACTLY, and they have to: a
   * device refused on one transport and admitted on the other is the bug this
   * closes, wearing a different hat.
   *
   * - An ABSENT `sid` is ADMITTED. A token with no `sid` can only be one this
   *   server minted before the deploy that added the claim, and the signature
   *   proves it came from us. Such a token expires within one access TTL, so
   *   the gap closes itself. Rejecting it instead would drop every signed-in
   *   member's socket the moment the deploy landed, which is a worse outcome
   *   than a fifteen-minute tail on revocations reaching devices that already
   *   hold a valid token.
   * - A `sid` present but not a string is REFUSED. It would otherwise skip the
   *   lookup silently, and a check that can be switched off by sending the
   *   wrong type is not a check. The claims interface says `string`; a decoded
   *   JWT is runtime data, so the parameter is `unknown` and earns its type
   *   here.
   * - A family that is revoked OR expired is REFUSED. Both conditions are
   *   needed, matching what `AccountService.listSessions` shows the member as a
   *   live session: `revoked_at IS NULL` alone would keep a family that had run
   *   out its 30-day life usable for the further 30 days the purge job waits.
   *
   * CHEAP, which matters because this runs on every connection: one `exists`
   * against `IDX_refresh_tokens_family_id`, so Postgres stops at the first
   * matching row and returns a boolean rather than hydrating an entity. Nothing
   * is cached, and nothing should be: a cache here would reintroduce the very
   * window the check exists to close.
   */
  private async assertSessionLive(sessionId: unknown): Promise<void> {
    if (sessionId === undefined) {
      return;
    }
    if (typeof sessionId !== 'string') {
      throw new ChatWsException('UNAUTHORIZED', 'Unauthorized');
    }
    // An empty string names no session, and `JwtStrategy.isSessionLive` reads
    // it the same way (its falsy guard covers both). No minted token carries
    // one, since a family id is always a uuid.
    if (sessionId === '') {
      return;
    }
    const isSessionLive = await this.refreshTokens.exists({
      where: {
        familyId: sessionId,
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
    });
    if (!isSessionLive) {
      throw new ChatWsException('SESSION_REVOKED', 'Unauthorized');
    }
  }

  /**
   * Throws unless the platform is unlocked, or this user is staff allowed
   * through it.
   *
   * SHARED with `PlatformLockdownGuard`: the predicate (admins always pass;
   * moderators pass only when `lockdownAllowsModerators`; everyone else is
   * refused), the default copy (`DEFAULT_LOCKDOWN_MESSAGE`), and the
   * `PLATFORM_LOCKED` code. Change the rule in one and you must change the
   * other.
   *
   * NOT shared, and deliberately so:
   * - **Scope.** The guard reads `req.user.role`, already populated by
   *   `JwtStrategy`. There is no request here, so the role has to be fetched
   *   from the database — the access token carries `sub`, `status` and `exp`,
   *   but no role claim. A deleted user therefore fails closed here.
   * - **Timing.** The guard runs per request, so HTTP goes dark immediately.
   *   This runs once, at the handshake. Sockets already open when lockdown is
   *   enabled are dropped by the {@link PLATFORM_LOCKDOWN_ENABLED} listener
   *   instead, not by this method.
   * - **Error shape.** The guard throws an HTTP 503; this throws a
   *   {@link PlatformLockedWsException}, which `handleConnection` emits to the
   *   client as a socket `exception` frame. There is no status code on a
   *   WebSocket to carry the 503.
   * - **Exemptions.** `@LockdownExempt()` has no meaning here; there is no
   *   handler metadata on a handshake.
   */
  private async assertNotLockedOut(userId: string): Promise<void> {
    const settings = await this.platformSettings.get();
    if (!settings.lockdownEnabled) {
      return;
    }
    const user = await this.users.findById(userId);
    const role = user?.role;
    if (role === UserRole.Admin) {
      return;
    }
    if (role === UserRole.Moderator && settings.lockdownAllowsModerators) {
      return;
    }
    // `||`, not `??`: an admin who clears the message textarea sends `''`.
    throw new PlatformLockedWsException(
      settings.lockdownMessage || DEFAULT_LOCKDOWN_MESSAGE,
    );
  }

  /**
   * The single "kill this socket for a bad or expired credential" action.
   * Shared by `scheduleTokenExpiry`'s own armed timer (a routine drop at the
   * handshake token's `exp`) and `handleReauth`'s failure branch (ENG-219: an
   * IMMEDIATE drop for a `session:reauth` frame that fails verification):
   * one drop path for both, rather than a second one for reauth that could
   * drift from this one's behaviour.
   *
   * Marking `isExpiring` BEFORE disconnecting is what lets `handleDisconnect`
   * tell this PLANNED drop apart from a genuine one and grant
   * `PresenceService` a grace window instead of reporting the member offline
   * for the moment it takes to reconnect on a freshly-refreshed token. That
   * grace is exactly as safe for a REJECTED reauth as for a routine expiry:
   * it only delays a PRESENCE broadcast, never the auth decision itself
   * (which already ran, and already failed, before this is ever called), so
   * the socket is gone either way, and a legitimate client either reconnects
   * with a genuinely fresh credential (indistinguishable from the routine
   * case) or does not, in which case the grace window still lapses and
   * reports it offline.
   */
  private dropSocketForExpiredOrInvalidCredential(client: ChatSocket): void {
    client.data.isExpiring = true;
    client.emit(
      'exception',
      buildChatWsErrorFrame('TOKEN_EXPIRED', 'Token expired'),
    );
    client.disconnect(true);
  }

  /**
   * Returns TRUE when the token expiry timer was scheduled for later, and
   * FALSE when `exp` was already in the past and the socket was dropped
   * immediately instead. The caller (`handleConnection`) uses that to stop
   * before marking an already-dropped socket present in `PresenceService`;
   * see the call site's own comment for why that race is possible at all.
   * `handleReauth` (ENG-219) reuses this SAME method to arm a fresh timer
   * for a NEW `exp` on an already-open socket, after clearing whatever timer
   * this had previously armed: see that handler's own comment for why the
   * clear has to happen first.
   */
  private scheduleTokenExpiry(client: ChatSocket, exp: number): boolean {
    // ENG-260: arms a timer for at most `MAX_SET_TIMEOUT_DELAY_MS` and, if
    // that fires before the real `exp`, re-arms against the REMAINING time
    // rather than trusting a single `setTimeout` call to survive all the way
    // there. Recomputing the remainder from `exp` and `Date.now()` on every
    // re-arm (instead of subtracting `MAX_SET_TIMEOUT_DELAY_MS` from the
    // previous delay) also keeps this correct under event-loop lag: a
    // callback that fires late still measures against the wall clock, not
    // against how long the PREVIOUS leg was scheduled for. Every re-arm
    // overwrites `client.data.expiryTimer` with the CURRENT pending timer, so
    // `handleDisconnect`'s `clearTimeout` always clears the right one no
    // matter how many legs this has chained through.
    const armTimer = (delayMs: number) => {
      const timer = setTimeout(() => {
        const remainingMs = exp * 1000 - Date.now();
        if (remainingMs <= 0) {
          this.dropSocketForExpiredOrInvalidCredential(client);
          return;
        }
        armTimer(Math.min(remainingMs, MAX_SET_TIMEOUT_DELAY_MS));
      }, delayMs);
      // Don't let a pending expiry timer keep the event loop alive on shutdown.
      timer.unref?.();
      client.data.expiryTimer = timer;
    };
    const msUntilExpiry = exp * 1000 - Date.now();
    if (msUntilExpiry <= 0) {
      this.dropSocketForExpiredOrInvalidCredential(client);
      return false;
    }
    armTimer(Math.min(msUntilExpiry, MAX_SET_TIMEOUT_DELAY_MS));
    return true;
  }

  /**
   * PRD-364 shared helper: every OTHER (never the caller themselves)
   * participant of `conversationId` whose messaging-privacy row FAILS
   * `shares`, as `user:<id>` room names — the exact shape socket.io's
   * `.except()` wants. Used by `handleTyping` and `handleMessageRead` to
   * exclude a participant who has turned off their own sharing from a live
   * relay of someone else's typing/read signal, since PRD-364 makes each of
   * those reciprocal (opting out also means never SEEING the same signal from
   * anyone else). One extra query per relay, same cost class as
   * `fanOutConversationMessage`'s identical per-send participant read.
   *
   * CW-09: `handleTyping` also calls `resolveTypingSenderIdentity` for the
   * same `conversationId` on the same frame, which used to issue its own,
   * separate seat query. `preloadedSeats` lets a caller that already holds
   * the conversation's seats (as `handleTyping` now does) pass them in and
   * skip this method's own query; every other caller omits it and this
   * method queries as before.
   */
  private async excludedUserRooms(
    conversationId: string,
    callerUserId: string,
    shares: (privacy: MessagingPrivacyDTO) => boolean,
    preloadedSeats?: ConversationParticipant[],
  ): Promise<string[]> {
    const participants =
      preloadedSeats ??
      (await this.conversationParticipants.find({
        where: { conversationId },
        // ENG-239, same regression as `fanOutConversationMessage`'s own `select`
        // above: the default full-row `find` pulled every participant column,
        // including each member's possibly-5000-char `draft` free text, and this
        // helper runs on EVERY typing frame and every read relay. Only the id is
        // ever read here.
        select: { userId: true },
      }));
    const otherUserIds = participants
      .map((participant) => participant.userId)
      .filter((participantUserId) => participantUserId !== callerUserId);
    if (!otherUserIds.length) {
      return [];
    }
    const privacyByUser =
      await this.preferences.getMessagingPrivacyForUsers(otherUserIds);
    return otherUserIds
      .filter((otherUserId) => {
        const privacy = privacyByUser.get(otherUserId);
        // An id absent from the map (no row, sharing everything) reads as
        // sharing — never defensively withhold from a missing entry.
        return privacy ? !shares(privacy) : false;
      })
      .map((otherUserId) => `user:${otherUserId}`);
  }

  /**
   * Mailboxes (Task 13): the identity the SENDER speaks as in THIS
   * conversation, resolved from their OWN seat
   * (`conversation_participants.identity_id`), the one place that answers
   * "which identity is this" per `IdentitiesService`'s own doc. Reuses that
   * one service here instead of a second, hand-rolled lookup.
   *
   * Returns null for an ordinary profile-identity seat, so `handleTyping`'s
   * pre-mailbox behaviour (frame carries `userId`, exclusion is the sender's
   * own `user:<id>` room) stays exactly as it was for a personal thread.
   * Also returns null when the caller holds no seat here at all: this is a
   * defensive fallback for that edge case, since `handleTyping`'s own
   * room-membership check already guards the common one.
   *
   * `staffUserRooms` is EVERY staff member of the identity, owner included,
   * via `IdentitiesService.staffUserIds`. `handleTyping` excludes the whole
   * roster, so no colleague sees the business typing at itself.
   *
   * Task 14a: `isSenderDeparted` and `departedStaffUserRooms` apply the
   * departed-staff rule (`isDepartedStaffSeat`) to the sender's own seat and
   * to every other seat of the same identity. A departed staff member is no
   * longer on the roster, so without their own room in the exclusion a
   * socket of theirs still in the room would hear the business typing.
   *
   * CW-09: `preloadedSeats`, when given, replaces this method's own seat
   * query. See `excludedUserRooms`'s identical parameter, added for the
   * same reason: `handleTyping` needs both helpers' results for the same
   * conversation on the same frame, and used to pay for two separate,
   * identically-shaped queries to get them.
   *
   * `isIdentityRemoved` is true for a persona that moderation removed
   * (`IdentitiesService.isRemovedPersona`, the check `assertMayActAs`
   * refuses writes on), so its staff show nobody that it is typing.
   */
  private async resolveTypingSenderIdentity(
    conversationId: string,
    userId: string,
    preloadedSeats?: ConversationParticipant[],
  ): Promise<{
    identityId: string;
    displayName: string | null;
    staffUserRooms: string[];
    isSenderDeparted: boolean;
    isIdentityRemoved: boolean;
    departedStaffUserRooms: string[];
  } | null> {
    const seats =
      preloadedSeats ??
      (await this.conversationParticipants.find({
        where: { conversationId },
        select: { userId: true, identityId: true, leftAt: true },
      }));
    const senderSeat = seats.find((seat) => seat.userId === userId);
    if (!senderSeat) {
      return null;
    }
    const identity = await this.identities.getById(senderSeat.identityId);
    if (!identity || identity.kind === IdentityKind.Profile) {
      return null;
    }
    // Every seat of the sender's identity is a staff seat of this mailbox,
    // so that identity's kind is the one each of those seats needs to be
    // described from its own side.
    const mailboxIdentityKindById = new Map([
      [senderSeat.identityId, identity.kind],
    ]);
    const isSeatDeparted = (staffSeat: (typeof seats)[number]): boolean =>
      isDepartedStaffSeat(
        staffSeat,
        describeDirectThreadSeats(
          staffSeat.identityId,
          seats.filter((seat) => seat !== staffSeat),
          mailboxIdentityKindById,
        ),
      );
    if (isSeatDeparted(senderSeat)) {
      return {
        identityId: senderSeat.identityId,
        displayName: null,
        staffUserRooms: [],
        isSenderDeparted: true,
        isIdentityRemoved: false,
        departedStaffUserRooms: [],
      };
    }
    if (await this.identities.isRemovedPersona(identity)) {
      return {
        identityId: senderSeat.identityId,
        displayName: null,
        staffUserRooms: [],
        isSenderDeparted: false,
        isIdentityRemoved: true,
        departedStaffUserRooms: [],
      };
    }
    const [descriptions, staffUserIds] = await Promise.all([
      this.identities.describeIdentities([senderSeat.identityId]),
      this.identities.staffUserIds(senderSeat.identityId),
    ]);
    return {
      identityId: senderSeat.identityId,
      displayName: descriptions.get(senderSeat.identityId)?.displayName ?? null,
      staffUserRooms: staffUserIds.map((staffUserId) => `user:${staffUserId}`),
      isSenderDeparted: false,
      isIdentityRemoved: false,
      departedStaffUserRooms: seats
        .filter(
          (seat) =>
            seat.identityId === senderSeat.identityId && isSeatDeparted(seat),
        )
        .map((seat) => `user:${seat.userId}`),
    };
  }

  /**
   * Task 13e: who `conversationId`'s live frames may reach, see
   * {@link LiveThreadAudience}. A thread is personal only once it is a group
   * or an official thread, or every seat is confirmed a profile identity. A
   * business mailbox thread's audience is the customer plus every live staff
   * seat with no block against the customer
   * (`loadReachableMailboxSeats`), because a frame addressed to a staff
   * member's `user:<id>` room reaches them whatever `canJoinConversationLive`
   * would say.
   */
  private async loadLiveThreadAudience(
    conversationId: string,
  ): Promise<LiveThreadAudience> {
    const conversation = await this.conversationParticipants.manager.findOne(
      Conversation,
      {
        where: { id: conversationId },
        select: { id: true, kind: true, isOfficial: true },
      },
    );
    if (!conversation) {
      return { shape: 'closed' };
    }
    if (
      conversation.kind === ConversationKind.Group ||
      conversation.isOfficial
    ) {
      return { shape: 'personal' };
    }
    const seats = await this.conversationParticipants.find({
      where: { conversationId },
      select: {
        userId: true,
        identityId: true,
        leftAt: true,
        lastReadAt: true,
        deliveredAt: true,
      },
    });
    const seatIdentities = await this.identities.getByIds(
      seats.map((seat) => seat.identityId),
    );
    const identityKindById = new Map(
      seatIdentities.map((identity) => [identity.id, identity.kind]),
    );
    if (isEverySeatPersonal(seats, identityKindById)) {
      return { shape: 'personal' };
    }
    const partition = partitionMailboxThreadSeats(seats, identityKindById, {
      shouldIncludeDepartedSeats: false,
    });
    if (!partition) {
      return { shape: 'closed' };
    }
    const reachableSeats = await loadReachableMailboxSeats(
      partition,
      identityKindById,
      this.blockFilter,
    );
    // Task 14: the customer blocked the business, so the thread reaches
    // nobody on either side.
    if (!reachableSeats.customerSeat) {
      return { shape: 'closed' };
    }
    const reachableStaffSeats = reachableSeats.staffSeats;
    // The business as the customer's own REST reads see it, from the
    // customer's seat, so the live counts and watermarks agree with them.
    const customerSeat = partition.customerSeat;
    const businessUserIds = businessSeatUserIdsForViewer(
      describeDirectThreadSeats(
        customerSeat.identityId,
        seats.filter((seat) => seat.userId !== customerSeat.userId),
        identityKindById,
      ),
    );
    return {
      shape: 'mailbox',
      mailboxIdentityId: partition.mailboxIdentityId,
      customerUserId: customerSeat.userId,
      reachableStaffUserIds: new Set(
        reachableStaffSeats.map((seat) => seat.userId),
      ),
      businessSeats: seats.filter((seat) => businessUserIds.has(seat.userId)),
    };
  }

  /**
   * Task 13e: `message:new` and `conversation:message` on a business mailbox
   * thread, one payload per viewer. The customer and each reachable staff
   * member get the message exactly as their own REST read renders it
   * (`renderMessageForViewers`); the sender gets `payload.response`, which
   * was rendered for them. `message:new` keeps its meaning of "the thread you
   * have open", so it reaches only a viewer's sockets that joined the
   * conversation room; `conversation:message` reaches every socket of every
   * viewer except the sender, as the ordinary fan-out does.
   */
  private async relayMailboxMessageCreated(
    payload: MessageCreatedEvent,
    audience: MailboxLiveThreadAudience,
  ): Promise<void> {
    const senderId = payload.message.senderId;
    const responseByUserId = await this.renderMessageForViewers(
      payload.message,
      [audience.customerUserId, ...audience.reachableStaffUserIds],
      senderId,
      payload.response,
    );
    const frameByUserId = new Map(
      [...responseByUserId].map(([userId, message]) => [
        userId,
        { conversationId: payload.conversationId, message },
      ]),
    );
    await this.emitToJoinedSockets(
      payload.conversationId,
      'message:new',
      frameByUserId,
    );
    for (const [userId, frame] of frameByUserId) {
      if (userId === senderId) {
        continue;
      }
      this.namespace?.to(`user:${userId}`).emit('conversation:message', frame);
    }
  }

  /**
   * Task 13e: `message:updated` on a thread that is not personal. The edited
   * row is re-read so each viewer's payload goes through the same renderer
   * as `message:new`. The editor is the message's author (`editMessage`
   * allows no one else) and gets `payload.message`, rendered for them. A
   * closed thread relays the edit to the editor alone.
   */
  private async relayMailboxMessageUpdated(
    payload: MessageUpdatedEvent,
    audience: Exclude<LiveThreadAudience, { shape: 'personal' }>,
  ): Promise<void> {
    const editedMessage = await this.conversationParticipants.manager.findOne(
      Message,
      { where: { id: payload.message.id } },
    );
    if (!editedMessage) {
      return;
    }
    const editorId = editedMessage.senderId;
    if (audience.shape === 'closed') {
      await this.emitToOwnJoinedSockets(
        payload.conversationId,
        editorId,
        'message:updated',
        payload,
      );
      return;
    }
    // Task 13h: a co-manager whose mailbox staff floor covers the edited
    // message does not have it, so the edit skips them. The floor of a moved
    // business thread sits at its first enquiry, and an edit of an earlier
    // private message inside the edit window stays with the owner and the
    // customer.
    const messageFlooredUserIds =
      await this.messagingCore.loadMailboxStaffFlooredUserIds(
        payload.conversationId,
        editedMessage.id,
      );
    const responseByUserId = await this.renderMessageForViewers(
      editedMessage,
      [audience.customerUserId, ...audience.reachableStaffUserIds].filter(
        (userId) => !messageFlooredUserIds.has(userId),
      ),
      editorId,
      payload.message,
    );
    await this.emitToJoinedSockets(
      payload.conversationId,
      'message:updated',
      new Map(
        [...responseByUserId].map(([userId, message]) => [
          userId,
          { conversationId: payload.conversationId, message },
        ]),
      ),
    );
  }

  /**
   * Task 13e: `read` and `message:delivered` on a business mailbox thread,
   * matching what each viewer's REST read reports:
   *  - the customer's own receipt reaches the customer's other devices and
   *    every reachable staff member, unchanged;
   *  - a staff member's receipt reaches that staff member's other devices
   *    unchanged, and the customer as the business's receipt: the mailbox
   *    identity, with no human id, and `businessWatermark`, the latest
   *    watermark across the business's seats that the customer's inbox
   *    reports too;
   *  - colleagues receive nothing for it, because their REST view reads the
   *    customer's watermark alone, so a colleague's read never reads as the
   *    customer's.
   * `excludedUserRooms` keeps PRD-364's reciprocal read-receipt gate.
   */
  private async relayMailboxReceipt(
    event: 'read' | 'message:delivered',
    payload: MessageReadEvent | MessageDeliveredEvent,
    audience: MailboxLiveThreadAudience,
    excludedUserRooms: ReadonlySet<string>,
    resolveBusinessWatermark: () => Promise<Date>,
  ): Promise<void> {
    const isReceiving = (userId: string) =>
      !excludedUserRooms.has(`user:${userId}`);
    const frameByUserId = new Map<string, object>();
    if (payload.userId === audience.customerUserId) {
      frameByUserId.set(payload.userId, payload);
      for (const staffUserId of audience.reachableStaffUserIds) {
        if (isReceiving(staffUserId)) {
          frameByUserId.set(staffUserId, payload);
        }
      }
    } else if (audience.reachableStaffUserIds.has(payload.userId)) {
      frameByUserId.set(payload.userId, payload);
      if (isReceiving(audience.customerUserId)) {
        const businessWatermark = await resolveBusinessWatermark();
        frameByUserId.set(audience.customerUserId, {
          conversationId: payload.conversationId,
          identityId: audience.mailboxIdentityId,
          ...(event === 'read'
            ? { lastReadAt: businessWatermark }
            : { deliveredAt: businessWatermark }),
        });
      }
    }
    await this.emitToJoinedSockets(
      payload.conversationId,
      event,
      frameByUserId,
    );
  }

  /**
   * Task 13e: the business's read watermark as the customer's REST view
   * reports it (`otherLastReadAt`): the latest across the mailbox identity's
   * seats whose person shares read receipts (PRD-364), and at least as late
   * as the read being relayed.
   */
  private async latestBusinessReadAt(
    audience: MailboxLiveThreadAudience,
    relayedLastReadAt: Date,
  ): Promise<Date> {
    const privacyByUser = await this.preferences.getMessagingPrivacyForUsers([
      ...new Set(audience.businessSeats.map((seat) => seat.userId)),
    ]);
    const sharingSeats = audience.businessSeats.filter(
      (seat) => privacyByUser.get(seat.userId)?.shareReadReceipts ?? true,
    );
    return (
      latestTimestamp([
        relayedLastReadAt,
        ...sharingSeats.map((seat) => seat.lastReadAt),
      ]) ?? relayedLastReadAt
    );
  }

  /**
   * Task 13e: `reaction` on a business mailbox thread. Staff see
   * individuals, so each reachable staff member gets the frame unchanged.
   * The customer sees the business react: every staff reaction under one
   * key counts once (`collapseReactionCountsForCustomer`), and a staff
   * member's reaction arrives carrying the mailbox identity with no human
   * id. The customer's own reaction keeps their own `userId`, which is how
   * their client recognises its own echo.
   */
  private async relayMailboxReaction(
    payload: MessageReactionEvent,
    audience: MailboxLiveThreadAudience,
    messageFlooredUserIds: ReadonlySet<string>,
  ): Promise<void> {
    const reactionRows = await this.conversationParticipants.manager.find(
      MessageReaction,
      {
        where: { messageId: payload.messageId },
        select: { userId: true, key: true },
      },
    );
    const frameByUserId = new Map<string, object>();
    frameByUserId.set(audience.customerUserId, {
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      ...(payload.userId === audience.customerUserId
        ? { userId: payload.userId }
        : { identityId: audience.mailboxIdentityId }),
      reactions: countReactionsPerKey(
        payload.reactions,
        collapseBusinessReactions(
          reactionRows,
          new Set(audience.businessSeats.map((seat) => seat.userId)),
        ),
      ),
    });
    for (const staffUserId of audience.reachableStaffUserIds) {
      frameByUserId.set(staffUserId, payload);
    }
    for (const flooredUserId of messageFlooredUserIds) {
      frameByUserId.delete(flooredUserId);
    }
    await this.emitToJoinedSockets(
      payload.conversationId,
      'reaction',
      frameByUserId,
    );
  }

  /**
   * Task 14: every DIRECT, non-official thread between the customer
   * `blockerUserId` and the mailbox `identityId`, with the users whose
   * sockets leave its room: the customer, from a seat that speaks for their
   * own `profile` identity (the customer seat
   * `identityBlockedCustomerSeatPredicate` reads), and every seat of that
   * identity.
   */
  private async identityBlockEvictions(
    blockerUserId: string,
    identityId: string,
  ): Promise<ConversationMembershipRevokedEvent[]> {
    const blockedThreads = await this.conversationParticipants
      .createQueryBuilder('identity_block_customer_seat')
      .select('identity_block_customer_seat.conversation_id', 'conversationId')
      .innerJoin(
        Conversation,
        'identity_block_conversation',
        'identity_block_conversation.id = identity_block_customer_seat.conversation_id',
      )
      .innerJoin(
        Identity,
        'identity_block_customer_identity',
        'identity_block_customer_identity.id = identity_block_customer_seat.identity_id',
      )
      .innerJoin(
        ConversationParticipant,
        'identity_block_mailbox_seat',
        'identity_block_mailbox_seat.conversation_id = identity_block_customer_seat.conversation_id AND identity_block_mailbox_seat.identity_id = :blockedIdentityId',
        { blockedIdentityId: identityId },
      )
      .where('identity_block_customer_seat.user_id = :blockerUserId', {
        blockerUserId,
      })
      .andWhere('identity_block_customer_identity.kind = :profileKind', {
        profileKind: IdentityKind.Profile,
      })
      .andWhere('identity_block_conversation.kind != :groupKind', {
        groupKind: ConversationKind.Group,
      })
      .andWhere('identity_block_conversation.is_official = false')
      .getRawMany<{ conversationId: string }>();
    const conversationIds = [
      ...new Set(blockedThreads.map((row) => row.conversationId)),
    ];
    if (conversationIds.length === 0) {
      return [];
    }
    const seats = await this.conversationParticipants.find({
      where: { conversationId: In(conversationIds) },
      select: { conversationId: true, userId: true, identityId: true },
    });
    return conversationIds.map((conversationId) => ({
      conversationId,
      userIds: [
        ...new Set([
          blockerUserId,
          ...seats
            .filter(
              (seat) =>
                seat.conversationId === conversationId &&
                seat.identityId === identityId,
            )
            .map((seat) => seat.userId),
        ]),
      ],
    }));
  }

  /**
   * Task 13e: every business mailbox thread the newly blocked pair share,
   * with the one of them who loses their live place in it
   * (`blockedPairUserIdsToEvict`). Ordinary DMs are left to
   * `directConversationIdsBetween`, which already evicts both.
   */
  private async mailboxEvictionsForBlock(
    blockerId: string,
    blockedId: string,
  ): Promise<Array<{ conversationId: string; userId: string }>> {
    // The shared DIRECT, non-official mailbox threads, found in SQL: the
    // twin of `ConversationsService.directConversationIdsBetween`, which
    // keeps the ordinary DMs.
    const sharedMailboxThreads = await this.conversationParticipants
      .createQueryBuilder('pair_seat')
      .select('pair_seat.conversation_id', 'conversationId')
      .innerJoin(
        Conversation,
        'pair_conversation',
        'pair_conversation.id = pair_seat.conversation_id',
      )
      .innerJoin(
        ConversationParticipant,
        'other_pair_seat',
        'other_pair_seat.conversation_id = pair_seat.conversation_id AND other_pair_seat.user_id = :blockedId',
        { blockedId },
      )
      .where('pair_seat.user_id = :blockerId', { blockerId })
      .andWhere('pair_conversation.kind != :group', {
        group: ConversationKind.Group,
      })
      .andWhere('pair_conversation.is_official = false')
      .andWhere(mailboxThreadPredicate('pair_seat.conversation_id'))
      .getRawMany<{ conversationId: string }>();
    const directConversationIds = [
      ...new Set(sharedMailboxThreads.map((row) => row.conversationId)),
    ];
    if (directConversationIds.length === 0) {
      return [];
    }
    const seats = await this.conversationParticipants.find({
      where: { conversationId: In(directConversationIds) },
      select: {
        conversationId: true,
        userId: true,
        identityId: true,
        leftAt: true,
      },
    });
    const seatIdentities = await this.identities.getByIds([
      ...new Set(seats.map((seat) => seat.identityId)),
    ]);
    const identityKindById = new Map(
      seatIdentities.map((identity) => [identity.id, identity.kind]),
    );
    const evictions: Array<{ conversationId: string; userId: string }> = [];
    for (const conversationId of directConversationIds) {
      const threadSeats = seats.filter(
        (seat) => seat.conversationId === conversationId,
      );
      if (isEverySeatPersonal(threadSeats, identityKindById)) {
        continue;
      }
      for (const userId of blockedPairUserIdsToEvict(
        threadSeats,
        identityKindById,
        [blockerId, blockedId],
      )) {
        evictions.push({ conversationId, userId });
      }
    }
    return evictions;
  }

  /**
   * Task 13e: `message` rendered for each viewer through
   * `MessagingCoreService.toMessageResponses`, the renderer every REST read
   * of a message uses. The actor (sender or editor) gets `actorResponse`,
   * already rendered for them. Final review I2: every other viewer is
   * rendered once per class of viewers that method would render alike
   * (`renderMessageForViewerClasses`), so the cost stays flat in the staff
   * count. A viewer whose render fails is left out, so nobody ever receives
   * a payload rendered for someone else.
   */
  private async renderMessageForViewers(
    message: MessageLike,
    viewerUserIds: ReadonlyArray<string>,
    actorUserId: string | null,
    actorResponse: MessageResponse,
  ): Promise<Map<string, MessageResponse>> {
    const uniqueViewerUserIds = [...new Set(viewerUserIds)];
    const responseByViewerId =
      await this.messagingCore.renderMessageForViewerClasses(
        message,
        uniqueViewerUserIds.filter(
          (viewerUserId) => viewerUserId !== actorUserId,
        ),
        ConversationKind.Direct,
        (error) =>
          this.logger.error(
            `Failed to render a live message for one viewer: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          ),
      );
    return new Map(
      uniqueViewerUserIds.flatMap(
        (viewerUserId): [string, MessageResponse][] => {
          if (viewerUserId === actorUserId) {
            return [[viewerUserId, actorResponse]];
          }
          const response = responseByViewerId.get(viewerUserId);
          return response ? [[viewerUserId, response]] : [];
        },
      ),
    );
  }

  /**
   * Task 13e: emits `frameByUserId`'s frame to each of that user's sockets
   * that joined `conversationId`'s room, so a per-viewer frame keeps the
   * room emit's meaning of "the thread you have open". A socket in the room
   * whose user has no entry receives nothing, which is what keeps a staff
   * member outside the audience from receiving a frame even before
   * `handleMemberBlocked` evicts them. `fetchSockets` reads this instance's
   * sockets, the single-replica assumption `handleSessionRevoked` states.
   */
  private async emitToJoinedSockets(
    conversationId: string,
    event: string,
    frameByUserId: ReadonlyMap<string, unknown>,
  ): Promise<void> {
    if (frameByUserId.size === 0 || !this.namespace) {
      return;
    }
    const sockets = await this.namespace.in(conversationId).fetchSockets();
    for (const socket of sockets) {
      const socketUserId = (socket.data as ChatSocketData).userId;
      const frame =
        socketUserId === undefined
          ? undefined
          : frameByUserId.get(socketUserId);
      if (frame !== undefined) {
        socket.emit(event, frame);
      }
    }
  }

  /** Task 13e: {@link emitToJoinedSockets} for the actor's own frame alone,
   *  the one frame a closed thread still relays. */
  private async emitToOwnJoinedSockets(
    conversationId: string,
    actorUserId: string | null,
    event: string,
    frame: unknown,
  ): Promise<void> {
    if (!actorUserId) {
      return;
    }
    await this.emitToJoinedSockets(
      conversationId,
      event,
      new Map([[actorUserId, frame]]),
    );
  }

  /**
   * ENG-246: uncapped — `getAcceptedConnectionUserIds`'s `DEFAULT_LIST_LIMIT`
   * cap is fine for a rendered connections list, but presence is an internal
   * fan-out target set: a member past the cap silently never learned when
   * their 201st+ connection came online, and never appeared online to them
   * either. Mirrors `ConversationsService.listConversations`'s identical swap.
   */
  private async emitPresenceSnapshot(
    client: ChatSocket,
    userId: string,
  ): Promise<void> {
    // PRD-364, reciprocal: a member who has turned off their OWN presence
    // sharing receives no presence signal about anyone else either — an empty
    // snapshot now, and no live `presence` frames later (see
    // `broadcastPresence`, which never fires FOR a member who reads this way,
    // and this same check, re-run on their own next snapshot request/handshake,
    // covers what they receive ABOUT others).
    const ownPrivacy = await this.preferences.getMessagingPrivacy(userId);
    if (!ownPrivacy.sharePresence) {
      client.emit('presence:snapshot', { online: [] });
      return;
    }
    const online = await this.visibleOnlineConnectionIds(userId);
    client.emit('presence:snapshot', { online });
  }

  /** The subset of `userId`'s accepted connections who are online AND have
   *  not turned off their own presence sharing (PRD-364) — never announce a
   *  connection who opted out as online to anyone else. */
  private async visibleOnlineConnectionIds(userId: string): Promise<string[]> {
    const connectionIds =
      await this.connections.allAcceptedConnectionUserIds(userId);
    if (!connectionIds.length) {
      return [];
    }
    const online = connectionIds.filter((id) => this.presence.isOnline(id));
    if (!online.length) {
      return [];
    }
    const privacyByUser =
      await this.preferences.getMessagingPrivacyForUsers(online);
    return online.filter((id) => privacyByUser.get(id)?.sharePresence ?? true);
  }

  /**
   * Announce `userId`'s on/offline transition to every accepted connection —
   * gated on `userId`'s OWN current presence sharing (PRD-364): a member who
   * has opted out is never announced online in the first place, so there is
   * nothing to retract on disconnect either. The one exception is the
   * OFF-transition fired by a live preference change
   * (`handleSharePresenceChanged` below), which calls
   * {@link forceBroadcastPresence} directly to retract an announcement made
   * before the member opted out.
   */
  private async broadcastPresence(
    userId: string,
    online: boolean,
  ): Promise<void> {
    const ownPrivacy = await this.preferences.getMessagingPrivacy(userId);
    if (!ownPrivacy.sharePresence) {
      return;
    }
    // Re-checked once more inside, immediately before the emit and after the
    // connection lookup this cheap gate precedes: see
    // `forceBroadcastPresence`'s `recheckSharePresence` for the toggle race
    // that read closes.
    await this.forceBroadcastPresence(userId, online, {
      recheckSharePresence: true,
    });
  }

  /** The unconditional broadcast `broadcastPresence` gates on
   *  `sharePresence` — see that method's doc for why a caller ever needs the
   *  raw version. ENG-246: uncapped connections (see `emitPresenceSnapshot`'s
   *  doc).
   *
   *  PRD-364 is reciprocal on BOTH sides, so RECIPIENTS are filtered here too.
   *  Gating only on the subject left a member who had opted out receiving live
   *  `presence` frames about everyone else (the client merges them straight
   *  into its online set), even though their own snapshot came back empty, so
   *  `emitPresenceSnapshot`'s doc promised something the live path did not
   *  keep. Subject and recipients come out of ONE batched privacy read.
   *
   *  `recheckSharePresence` closes the announcing-side toggle race: a member
   *  who turns presence off while this call is still resolving its connection
   *  list would otherwise be re-announced online by the in-flight broadcast,
   *  with nothing left to retract it, because `handleSharePresenceChanged`'s
   *  own retraction has already run by then. The re-check is free, since the
   *  subject rides along in the batched read the recipient filter needs
   *  anyway. */
  private async forceBroadcastPresence(
    userId: string,
    online: boolean,
    options?: { recheckSharePresence?: boolean },
  ): Promise<void> {
    const connectionIds =
      await this.connections.allAcceptedConnectionUserIds(userId);
    if (!connectionIds.length) {
      return;
    }
    const privacyByUser = await this.preferences.getMessagingPrivacyForUsers([
      userId,
      ...connectionIds,
    ]);
    // An id absent from the map (no row, sharing everything) reads as sharing,
    // matching `excludedUserRooms` and `visibleOnlineConnectionIds`.
    if (
      options?.recheckSharePresence &&
      !(privacyByUser.get(userId)?.sharePresence ?? true)
    ) {
      return;
    }
    const rooms = connectionIds
      .filter((otherId) => privacyByUser.get(otherId)?.sharePresence ?? true)
      .map((otherId) => `user:${otherId}`);
    if (!rooms.length) {
      return;
    }
    // ONE emit addressed to every room at once, rather than one emit per
    // connection: socket.io de-duplicates recipients across the room list, so
    // behaviour is identical while a member with hundreds of connections costs
    // a single adapter call per transition instead of hundreds.
    this.namespace?.to(rooms).emit('presence', {
      userId,
      online,
    });
  }

  /**
   * PRD-364: a `sharePresence` toggle must take effect live, not merely on
   * this member's NEXT connect/disconnect. Turning it OFF retracts an
   * "online" announcement already standing (bypassing `broadcastPresence`'s
   * own gate, which by now reads the NEW, already-off value and would
   * otherwise silently skip the retraction). Turning it ON re-announces
   * online (if a socket is actually live) and refreshes the member's OWN
   * snapshot, since they can now see others again too.
   */
  @OnEvent(MESSAGING_PRIVACY_SHARE_PRESENCE_CHANGED)
  async handleSharePresenceChanged(
    payload: MessagingPrivacySharePresenceChangedEvent,
  ): Promise<void> {
    // Async `@OnEvent` doing DB work, wrapped like `handleMemberBlocked`: the
    // preference write has already committed, so a failure here must never
    // surface to the member's request, but it must not vanish as a bare
    // unhandled rejection either. A dropped retraction leaves a stale "online"
    // standing until this member's next transition, which is worth a logged
    // error.
    try {
      const isOnline = this.presence.isOnline(payload.userId);
      if (payload.sharePresence) {
        if (isOnline) {
          await this.forceBroadcastPresence(payload.userId, true);
        }
        const online = await this.visibleOnlineConnectionIds(payload.userId);
        this.namespace
          ?.to(`user:${payload.userId}`)
          .emit('presence:snapshot', { online });
      } else if (isOnline) {
        await this.forceBroadcastPresence(payload.userId, false);
      }
    } catch (err) {
      this.logger.error(
        `Failed to apply a live sharePresence change: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }
}
