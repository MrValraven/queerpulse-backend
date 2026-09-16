import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DataSource,
  EntityManager,
  FindOptionsWhere,
  In,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import {
  DEFAULT_WHO_CAN_MESSAGE,
  WHO_CAN_MESSAGE_VALUES,
  WhoCanMessage,
} from '../preferences/who-can-message';
import {
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import {
  restoreConnectionAfterUnblock,
  severConnectionForBlock,
} from './block-restore';
import {
  CONNECTION_REQUEST_DAILY_WINDOW_HOURS,
  connectionRequestDailyLimitException,
  connectionRequestPendingLimitException,
  connectionRequestsPausedException,
  MAX_NEW_CONNECTION_REQUESTS_PER_DAY,
  MAX_OPEN_PENDING_REQUESTS,
  recipientNotAcceptingRequestsException,
  REQUEST_PAUSE_DISTINCT_REPORTERS,
  REQUEST_PAUSE_REPORT_WINDOW_DAYS,
} from './request-limits';
import {
  CONNECTION_ACCEPTED,
  ConnectionAcceptedEvent,
  CONNECTION_REQUESTED,
  ConnectionRequestedEvent,
} from './connection.events';
import { BlockFilterService } from '../social/block-filter.service';
import { Block } from '../social/entities/block.entity';
import {
  MEMBER_BLOCKED,
  MEMBER_UNBLOCKED,
  MemberBlockedEvent,
  MemberUnblockedEvent,
} from '../social/social.events';
import { toVisibleAvatarUrl } from '../common/member-ref';
import {
  Notification,
  NotificationType,
} from '../notifications/entities/notification.entity';
import { MemberPreferences } from '../preferences/entities/member-preferences.entity';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { VouchService } from '../vouch/vouch.service';
import {
  ConnectionCounts,
  ConnectionListItem,
  ConnectionRelationship,
  ConnectionRelationshipSlugs,
  IncomingConnectionRef,
  VouchBadge,
  toConnectionListItem,
} from './connection-response';
import {
  Connection,
  ConnectionStatus,
  RestoredConnectionStatus,
  toRestoredConnectionStatus,
} from './entities/connection.entity';
import { ConnectionDecline } from './entities/connection-decline.entity';
import { ConnectionNote } from './entities/connection-note.entity';
import { Paginated, PAGE_SIZE, normalizePage } from '../common/pagination';
import { escapeLikeTerm } from '../common/like-escape';
import { toStoredPlainTextOrNull } from '../communities/community-plain-text';
import {
  CONNECTION_SEARCH_HAYSTACK,
  foldedTextExpression,
} from './connection-search';

export type ConnectionAction = 'accept' | 'decline' | 'block' | 'unblock';
export type ConnectionTab = 'all' | 'incoming' | 'outgoing' | 'vouched';
/** How a page of connections is ordered. `recent` is the default. */
export type ConnectionSort = 'recent' | 'alphabetical' | 'mutuals';

/** The filters and ordering `list` accepts beyond the tab itself. */
export interface ConnectionListOptions {
  page?: number;
  q?: string;
  sort?: ConnectionSort;
}

/**
 * How deep the "most mutuals" ordering ranks.
 *
 * Mutual counts are viewer-relative and cannot be expressed as a column, so
 * ranking by them means computing them for the whole matching set rather than
 * for one page. That is bounded here instead of left to grow with a member's
 * degree: the most-connected members in the set are ranked, and anything past
 * the cap keeps the recency order it already had. Well above the "fifty
 * people" this ordering exists to make navigable.
 */
const MUTUAL_SORT_MAX = 300;

/**
 * How long a refused requester must wait before asking the SAME member again,
 * indexed by how many times that member has already declined them (PRD-20).
 *
 * A first "no" is often "not right now", so it is a pause rather than a wall:
 * two weeks is long enough that asking again is a considered act instead of a
 * reflex, short enough that a genuine reconnection is still possible. A second
 * refusal arrives after the requester already waited out the first one, which
 * makes it a much clearer answer, so it costs three months. The back-off is
 * deliberate: each repeat is a stronger signal and should be priced like one.
 */
const DECLINE_COOLDOWN_DAYS = [14, 90] as const;

/**
 * How many refusals from the same member end the requests permanently.
 *
 * Three "no"s from one person is a durable answer, and the member who gave
 * them should not have to keep re-declining forever, nor reach for Block (a
 * heavier, mutual severance) just to be left alone. Past this the requester
 * cannot open a new request at all.
 *
 * This caps ONE DIRECTION. The member who declined may still send their own
 * request whenever they like, and accepting one clears the record, so the cap
 * closes a channel rather than severing the pair.
 */
const DECLINE_REQUEST_CAP = 3;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** The relationship for a member the viewer shares nothing with (yet). */
const NO_RELATIONSHIP: ConnectionRelationship = {
  mutuals: 0,
  vouchBadge: null,
};

@Injectable()
export class ConnectionsService {
  constructor(
    @InjectRepository(Connection)
    private readonly connections: Repository<Connection>,
    @InjectRepository(ConnectionNote)
    private readonly connectionNotes: Repository<ConnectionNote>,
    @InjectRepository(ConnectionDecline)
    private readonly connectionDeclines: Repository<ConnectionDecline>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    // PRD-344: read-only access to the addressee's own `ConnectionRequest`
    // bell notification, the only existing signal a pending request's sender
    // can learn a read state from (see `requestReadFlagsByConnectionId`).
    // Repository-only, same as this file's existing raw `reports` query below:
    // no NotificationsModule import, no service coupling.
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    // PRD-344: read-only access to `share_read_receipts`, the same reciprocal
    // gate `MessagingCoreService`/`ConversationsService` already read via
    // `PreferencesService`. Injected as a bare repository, deliberately NOT
    // `PreferencesService` itself, because `PreferencesService` transitively
    // imports `PublicEligibilityService`, which imports THIS file
    // (`ConnectionsService`); injecting the service back would close a real
    // circular require that breaks `design:paramtypes` reflection (verified:
    // it resolves to `undefined` and Nest cannot identify the token). A
    // repository has no such cycle, exactly like the `Notification` one above.
    @InjectRepository(MemberPreferences)
    private readonly memberPreferences: Repository<MemberPreferences>,
    private readonly vouchService: VouchService,
    private readonly eventEmitter: EventEmitter2,
    private readonly blockFilter: BlockFilterService,
    private readonly dataSource: DataSource,
  ) {}

  async requestConnection(
    requesterId: string,
    toSlug: string,
    message?: string,
    introducerSlug?: string,
    reason?: string,
  ): Promise<Connection> {
    const target = await this.profiles.findOne({
      where: { slug: toSlug },
      relations: { user: true },
    });
    if (!target) {
      throw new NotFoundException('Member not found');
    }
    const addresseeId = target.userId;
    if (addresseeId === requesterId) {
      throw new BadRequestException('You cannot connect to yourself');
    }
    // A block either way severs the possibility of a new request (spec §2).
    if (await this.blockFilter.isBlockedEitherWay(requesterId, addresseeId)) {
      throw new ForbiddenException('You cannot connect with this member');
    }
    // Only active members can receive connection requests (spec §8).
    if (!target.user || target.user.status !== UserStatus.Active) {
      throw new ForbiddenException('This member is not accepting connections');
    }

    const existing = await this.findPair(requesterId, addresseeId);
    if (existing) {
      switch (existing.status) {
        case ConnectionStatus.Blocked:
          // Don't disclose that the *other* member blocked you — return the
          // same 409 as a pending request so a block is indistinguishable. Only
          // your own block is surfaced (you placed it; you can unblock).
          if (existing.blockedBy === requesterId) {
            throw new ConflictException(
              'Unblock this member before sending a request',
            );
          }
          throw new ConflictException('A request is already pending');
        case ConnectionStatus.Accepted:
          throw new ConflictException('You are already connected');
        case ConnectionStatus.Pending:
          // PRD-03. Which way the pending request points changes what the
          // requester is being told, so the two directions get two different
          // messages. Their OWN outgoing request keeps the original wording;
          // a request the OTHER member sent THEM says so, because the previous
          // single message drove the client's "you've already reached out"
          // panel and that is the opposite of what had happened. Discloses
          // nothing: this member is the addressee of that request, so it is
          // already in their bell and on their connections page.
          //
          // The masked cases stay masked. A block by the other party (above)
          // and a decline hold (below) both keep throwing the unchanged
          // 'A request is already pending', which is what makes them
          // indistinguishable from one another.
          if (existing.addresseeId === requesterId) {
            throw new ConflictException(
              'This member has already asked to connect with you',
            );
          }
          throw new ConflictException('A request is already pending');
        case ConnectionStatus.Declined: {
          // PRD-20. A refusal now holds: this throws while the cooldown for
          // this direction is running, and permanently once the cap is hit.
          await this.assertFirstContactAllowed(requesterId);
          const { hasPriorDecline } = await this.assertRequestNotOnDeclineHold(
            requesterId,
            addresseeId,
          );
          const gate = await this.resolveRequestGate(
            requesterId,
            target,
            existing,
            introducerSlug,
          );
          // Re-open a previously declined relationship as a fresh request.
          existing.requesterId = requesterId;
          existing.addresseeId = addresseeId;
          existing.status = ConnectionStatus.Pending;
          existing.requestMessage = this.messageAfterDecline(
            message,
            hasPriorDecline,
          );
          existing.requestReason = this.messageAfterDecline(
            reason,
            hasPriorDecline,
          );
          existing.respondedAt = null;
          existing.blockedBy = null;
          existing.introducedBy = gate.introducedBy;
          existing.flagged = gate.flagged;
          const reopened = await this.connections.save(existing);
          // PRD-365: the daily-cap ledger records a request that EXISTS. Run
          // before the save, a failed write (a lost unique-pair race mapped to
          // 409, a constraint, a dropped connection) still burned one of the
          // member's 20 daily slots for a request nobody ever received.
          await this.recordRequestEvent(requesterId);
          this.emitRequested(reopened);
          return reopened;
        }
      }
    }

    // Also gated on the fresh-create path, deliberately. `remove` DELETEs a
    // declined pair row, so "decline, delete, ask again" would otherwise walk
    // straight past a guard that only ran on the re-open branch. The decline
    // record outlives the edge, so both paths meet the same hold. The PRD-365
    // volume caps and report-driven pause run first on both paths too.
    await this.assertFirstContactAllowed(requesterId);
    const { hasPriorDecline } = await this.assertRequestNotOnDeclineHold(
      requesterId,
      addresseeId,
    );
    const gate = await this.resolveRequestGate(
      requesterId,
      target,
      null,
      introducerSlug,
    );
    const { low, high } = this.pair(requesterId, addresseeId);
    const conn = this.connections.create({
      requesterId,
      addresseeId,
      userLow: low,
      userHigh: high,
      status: ConnectionStatus.Pending,
      requestMessage: this.messageAfterDecline(message, hasPriorDecline),
      requestReason: this.messageAfterDecline(reason, hasPriorDecline),
      introducedBy: gate.introducedBy,
      flagged: gate.flagged,
    });
    try {
      const saved = await this.connections.save(conn);
      // PRD-365: after the save, for the reason the re-open branch gives —
      // the 409 below is exactly the failure that used to consume a slot.
      await this.recordRequestEvent(requesterId);
      this.emitRequested(saved);
      return saved;
    } catch (err) {
      // A concurrent request can win the race to the UNIQUE pair; map the
      // constraint violation to a 409 instead of a 500.
      if (isUniqueViolation(err)) {
        throw new ConflictException('A request is already pending');
      }
      throw err;
    }
  }

  /**
   * `POST /connections` wrapper: creates the request, then maps it to the same
   * `ConnectionListItem` shape the list path returns. This keeps the create
   * response from leaking raw entity columns (`userLow`/`userHigh`/`blockedBy`/
   * `flagged`) — `requestConnection` itself still returns the entity because
   * the messaging flow relies on it.
   */
  async requestConnectionView(
    requesterId: string,
    toSlug: string,
    message?: string,
    introducerSlug?: string,
    reason?: string,
  ): Promise<ConnectionListItem> {
    const connection = await this.requestConnection(
      requesterId,
      toSlug,
      message,
      introducerSlug,
      reason,
    );
    const otherUserId = this.otherId(connection, requesterId);
    const [profilesById, relationshipsByUserId] = await Promise.all([
      this.profilesByUserIds(
        [otherUserId, connection.introducedBy].filter(
          (userId): userId is string => userId !== null && userId !== undefined,
        ),
      ),
      this.relationshipsByUserIds(requesterId, [otherUserId]),
    ]);
    return toConnectionListItem(
      connection,
      requesterId,
      profilesById.get(otherUserId),
      relationshipsByUserId.get(otherUserId) ?? NO_RELATIONSHIP,
      connection.introducedBy
        ? profilesById.get(connection.introducedBy)
        : undefined,
    );
  }

  // §8 request gate. Returns the fields to persist on the connection:
  //  - open     → allowed, no introducer, not flagged.
  //  - network  → existing connections re-open freely; a stranger must name an
  //               introducer connected to BOTH parties, else 403.
  //  - private  → allowed but flagged for later moderation.
  //
  // PRD-366: the recipient's "who can message me" preference is layered on top
  // of visibility, and the stricter of the two wins:
  //  - 'everyone'    → the visibility rules above, unchanged.
  //  - 'introduced'  → a mutual-connection introducer is required whatever the
  //                    visibility (the same rule `network` applies); a
  //                    `private` target is still flagged.
  //  - 'connections' → every new request is refused with 403
  //                    RECIPIENT_NOT_ACCEPTING_REQUESTS.
  // Enquiries about the recipient's own listing never pass through here
  // (`MessageRequestsService.deliverEnquiry`): the recipient published that
  // listing to be contacted, so 'connections' does not stop an enquiry.
  private async resolveRequestGate(
    requesterId: string,
    target: Profile,
    existing: Connection | null,
    introducerSlug: string | undefined,
  ): Promise<{ introducedBy: string | null; flagged: boolean }> {
    const whoCanMessage = await this.recipientWhoCanMessage(target.userId);
    if (whoCanMessage === 'connections') {
      throw recipientNotAcceptingRequestsException();
    }
    const flagged = target.visibility === ProfileVisibility.Private;
    const requiresIntroduction =
      target.visibility === ProfileVisibility.Network ||
      whoCanMessage === 'introduced';
    if (!requiresIntroduction) {
      return { introducedBy: null, flagged }; // open, or private (flagged)
    }
    if (existing?.status === ConnectionStatus.Accepted) {
      return { introducedBy: null, flagged };
    }
    if (!introducerSlug) {
      throw new ForbiddenException(
        'This member requires an introduction from a mutual connection',
      );
    }
    const introducer = await this.profiles.findOne({
      where: { slug: introducerSlug },
    });
    if (!introducer) {
      throw new NotFoundException('Introducer not found');
    }
    const introducerId = introducer.userId;
    if (introducerId === requesterId || introducerId === target.userId) {
      throw new ForbiddenException('Introducer must be a mutual connection');
    }
    const [knowsRequester, knowsTarget] = await Promise.all([
      this.areConnected(requesterId, introducerId),
      this.areConnected(target.userId, introducerId),
    ]);
    if (!knowsRequester || !knowsTarget) {
      throw new ForbiddenException('Introducer must be a mutual connection');
    }
    return { introducedBy: introducerId, flagged };
  }

  /**
   * PRD-20. Refuse a new request from `requesterId` to `addresseeId` while a
   * previous refusal still holds, and refuse it for good once this addressee
   * has declined this requester {@link DECLINE_REQUEST_CAP} times.
   *
   * THE REFUSAL IS SILENT ON PURPOSE. Both branches throw the exact
   * `'A request is already pending'` conflict the file already uses for "the
   * other member blocked you", so a cooldown, a cap and a block are one
   * indistinguishable answer. Saying "you have been declined twice" would hand
   * the requester a running report of a decision the decliner never chose to
   * share: today a decline reveals only that the outgoing request quietly went
   * away, and that is exactly as much as this keeps revealing.
   *
   * Returns whether ANY prior decline exists in this direction, which decides
   * whether the request may still carry the requester's own words.
   */
  private async assertRequestNotOnDeclineHold(
    requesterId: string,
    addresseeId: string,
  ): Promise<{ hasPriorDecline: boolean }> {
    const record = await this.connectionDeclines.findOne({
      where: { requesterId, addresseeId },
    });
    if (!record) {
      return { hasPriorDecline: false };
    }
    if (record.declineCount >= DECLINE_REQUEST_CAP) {
      throw new ConflictException('A request is already pending');
    }
    const cooldownDays =
      DECLINE_COOLDOWN_DAYS[
        Math.min(record.declineCount, DECLINE_COOLDOWN_DAYS.length) - 1
      ]!;
    const reopensAt = new Date(
      new Date(record.lastDeclinedAt).getTime() +
        cooldownDays * MILLISECONDS_PER_DAY,
    );
    if (reopensAt.getTime() > Date.now()) {
      throw new ConflictException('A request is already pending');
    }
    return { hasPriorDecline: true };
  }

  /**
   * The requester's own words, dropped once this member has declined them.
   *
   * WHY DROP RATHER THAN 400. `requestMessage` (2000 chars) and the
   * `custom:<label>` form of `requestReason` (200 chars) are free text that the
   * addressee is shown. Carrying them into a re-request after a refusal makes
   * the request note a message channel that survives being told no, which is
   * the actual harm here: the point of asking again should be to ask again, so
   * a re-request after a decline is the bare question and nothing attached.
   *
   * It is dropped silently rather than rejected because a 400 saying "you may
   * not include a message" would itself announce the decline, undoing the
   * quiet that {@link assertRequestNotOnDeclineHold} is protecting. The
   * addressee still sees who is asking, and can accept, decline, or block.
   */
  private messageAfterDecline(
    text: string | undefined,
    hasPriorDecline: boolean,
  ): string | null {
    if (hasPriorDecline) {
      return null;
    }
    return text ?? null;
  }

  /**
   * Record one refusal of `requesterId` by `addresseeId`, inside the caller's
   * transaction so a decline can never commit without the count that guards it.
   *
   * Written as a raw upsert because the increment has to read the stored value
   * in the same statement (`decline_count + 1`); a read-then-write pair would
   * lose a count to a concurrent decline, and TypeORM's `orUpdate` can only
   * overwrite with the incoming values.
   */
  private async recordDecline(
    manager: EntityManager,
    requesterId: string,
    addresseeId: string,
    declinedAt: Date,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO "connection_declines"
         ("requester_id", "addressee_id", "decline_count", "last_declined_at")
       VALUES ($1, $2, 1, $3)
       ON CONFLICT ("requester_id", "addressee_id") DO UPDATE
         SET "decline_count" = "connection_declines"."decline_count" + 1,
             "last_declined_at" = EXCLUDED."last_declined_at"`,
      [requesterId, addresseeId, declinedAt],
    );
  }

  /**
   * The two guards every `respond` action shares: the connection exists, and
   * the actor is a party to it. Extracted so {@link respondWithReply} (PRD-340)
   * enforces exactly these before it ever touches acceptance, never a
   * separate, looser check written twice.
   */
  private async loadRespondableConnection(
    connectionId: string,
    actorId: string,
  ): Promise<Connection> {
    const conn = await this.connections.findOne({
      where: { id: connectionId },
    });
    if (!conn) {
      throw new NotFoundException('Connection not found');
    }
    if (actorId !== conn.requesterId && actorId !== conn.addresseeId) {
      throw new ForbiddenException('Not your connection');
    }
    return conn;
  }

  /**
   * The accept/decline transition: still-pending, addressee-only, atomic
   * claim (so a race with the OTHER action loses cleanly), and the decline
   * ledger read/write PRD-20 depends on. Shared by `respond('accept' |
   * 'decline', ...)` and {@link respondWithReply} (PRD-340's reply-implies-
   * accept), so a reply can never accept anything the ordinary Accept button
   * would have refused: same status check, same addressee check, same claim.
   * Does NOT emit `CONNECTION_ACCEPTED`; each caller does that itself, since
   * only `respondWithReply` has a `replyBody` to attach to the payload.
   */
  private async acceptOrDecline(
    conn: Connection,
    actorId: string,
    action: 'accept' | 'decline',
  ): Promise<Connection> {
    if (conn.status !== ConnectionStatus.Pending) {
      throw new ConflictException('There is no pending request');
    }
    if (actorId !== conn.addresseeId) {
      throw new ForbiddenException(
        'Only the addressee can respond to a request',
      );
    }
    const newStatus =
      action === 'accept'
        ? ConnectionStatus.Accepted
        : ConnectionStatus.Declined;
    const respondedAt = new Date();
    // One transaction so the status flip and the decline ledger cannot
    // disagree (PRD-20). A decline that committed without its
    // `connection_declines` row would leave the pair with no cooldown at
    // all, which is precisely the hole this closes; a rollback here simply
    // leaves the request pending, which the addressee can retry.
    await this.dataSource.transaction(async (manager) => {
      // Conditional claim: only one responder flips it out of pending. A
      // concurrent accept/decline sees affected === 0 and loses, so
      // CONNECTION_ACCEPTED (which materializes the conversation, §7) fires
      // exactly once.
      const claim = await manager.update(
        Connection,
        { id: conn.id, status: ConnectionStatus.Pending },
        { status: newStatus, respondedAt },
      );
      if (claim.affected !== 1) {
        throw new ConflictException('There is no pending request');
      }
      if (action === 'decline') {
        await this.recordDecline(
          manager,
          conn.requesterId,
          conn.addresseeId,
          respondedAt,
        );
        return;
      }
      // Accepting resolves the history in BOTH directions. A connection
      // both members ended up wanting settles whatever the earlier
      // refusals were about, so if they ever part the count starts from
      // nothing rather than from a hold neither of them remembers.
      //
      // One call per direction: `manager.delete` does not accept an array
      // of conditions. With `invalidWhereValuesBehavior` configured, TypeORM
      // normalizes the array into an object keyed "0"/"1" and throws
      // `Property "0" was not found`, rolling back every accept.
      await manager.delete(ConnectionDecline, {
        requesterId: conn.requesterId,
        addresseeId: conn.addresseeId,
      });
      await manager.delete(ConnectionDecline, {
        requesterId: conn.addresseeId,
        addresseeId: conn.requesterId,
      });
    });
    conn.status = newStatus;
    conn.respondedAt = respondedAt;
    return conn;
  }

  async respond(
    connectionId: string,
    actorId: string,
    action: ConnectionAction,
  ): Promise<Connection> {
    const conn = await this.loadRespondableConnection(connectionId, actorId);

    switch (action) {
      case 'accept':
      case 'decline': {
        const updated = await this.acceptOrDecline(conn, actorId, action);
        if (action === 'accept') {
          this.eventEmitter.emit(CONNECTION_ACCEPTED, {
            connectionId: updated.id,
            requesterId: updated.requesterId,
            addresseeId: updated.addresseeId,
            requestMessage: updated.requestMessage,
          } satisfies ConnectionAcceptedEvent);
        }
        return updated;
      }
      case 'block': {
        // Two changes here close P1-3:
        //
        // 1. TOCTOU fix. The old code read the row, checked `blockedBy` in
        //    memory, then did an UNCONDITIONAL `save`. Between the read and the
        //    save the OTHER party could place their own block, which this
        //    actor's save would then overwrite (`blockedBy = actorId`) —
        //    letting them seize, then `unblock`/`remove`, and escape someone
        //    else's block. The write is now an atomic CONDITIONAL update
        //    (`status != Blocked`), mirroring `social.service.blockMember`: a
        //    racing block by the other party leaves `affected === 0`, so the
        //    seizure can never land. Re-blocking one's own block is idempotent.
        //
        // 2. Unify the two block systems. Connection-level block now ALSO
        //    writes a first-class `blocks` row (same transaction), so
        //    `BlockFilterService` — which feeds/search/notifications/group-adds
        //    consult — sees a connection-level block just like a `/blocks` one.
        //    Previously `respond('block')` wrote no `blocks` row and those
        //    surfaces were blind to it.
        const blockerId = actorId;
        const blockedId = this.otherId(conn, actorId);
        const { low, high } = this.pair(conn.requesterId, conn.addresseeId);
        const respondedAt = new Date();
        await this.dataSource.transaction(async (manager) => {
          // PRD-363: the same sever `SocialService.blockMember` runs, which
          // also stashes an `accepted`/`pending` status for the unblock.
          const affected = await severConnectionForBlock(
            manager,
            { low, high },
            blockerId,
            respondedAt,
          );
          if (affected === 0) {
            // Already blocked. If the OTHER party owns the block, refuse (no
            // seizure) and roll back so no `blocks` row is written; if this
            // actor already owns it, fall through — re-blocking is idempotent.
            const current = await manager.findOneByOrFail(Connection, {
              id: conn.id,
            });
            if (current.blockedBy !== blockerId) {
              throw new ForbiddenException(
                'This connection is already blocked by the other member',
              );
            }
          }
          await manager
            .createQueryBuilder()
            .insert()
            .into(Block)
            .values({ blockerId, blockedId, reason: null })
            .orIgnore()
            .execute();
        });
        // Post-commit, best-effort: same live-room eviction
        // `SocialService.blockMember` triggers. Both entry points write the
        // same `blocks` row and the same severed edge, so both must also cut
        // the pair's socket room — otherwise which button the member pressed
        // would decide whether the block took effect live.
        this.emitBestEffort(MEMBER_BLOCKED, {
          blockerId,
          blockedId,
        } satisfies MemberBlockedEvent);
        return this.connections.findOneByOrFail({ id: conn.id });
      }
      case 'unblock': {
        if (conn.status !== ConnectionStatus.Blocked) {
          throw new ConflictException('This connection is not blocked');
        }
        if (conn.blockedBy !== actorId) {
          throw new ForbiddenException('Only the blocker can unblock');
        }
        // Symmetric inverse of the `block` case (P1-3, unblock side): lifting a
        // connection-level block must ALSO delete the first-class `blocks` row
        // that block wrote, or `BlockFilterService` (feeds, search,
        // notifications, group-adds) would keep hiding the pair even though the
        // connection edge is restored. Mirrors `social.service.unblockMember`
        // exactly — both entry points now agree, whichever placed the block.
        // The connection flip is CONDITIONAL on `blockedBy = actorId` so a
        // racing seizure by the other party can't be lifted by the wrong actor,
        // matching the in-memory guard above without a TOCTOU window.
        //
        // PRD-363: the pair returns to exactly what the block took (an
        // `accepted` connection or a `pending` request with its original
        // requester), or to `declined` when nothing was stashed. The DM's
        // `openedAt` is restored by `ConversationsService` on MEMBER_UNBLOCKED.
        const blockedId = this.otherId(conn, actorId);
        const { low, high } = this.pair(conn.requesterId, conn.addresseeId);
        await this.dataSource.transaction(async (manager) => {
          await restoreConnectionAfterUnblock(manager, { low, high }, actorId);
          await manager.delete(Block, { blockerId: actorId, blockedId });
        });
        this.emitBestEffort(MEMBER_UNBLOCKED, {
          unblockerId: actorId,
          unblockedId: blockedId,
        } satisfies MemberUnblockedEvent);
        return this.connections.findOneByOrFail({ id: conn.id });
      }
    }
  }

  /**
   * `PATCH /connections/:id` wrapper: performs the action, then maps the result
   * to the same `ConnectionListItem` shape the list/create paths return. Like
   * {@link requestConnectionView}, this keeps the response from leaking raw
   * entity columns (`userLow`/`userHigh`/`blockedBy`/`flagged`/`introducedBy`)
   * to the client. `respond` itself still returns the entity for internal
   * callers that need it.
   */
  async respondView(
    connectionId: string,
    actorId: string,
    action: ConnectionAction,
  ): Promise<
    ConnectionListItem & { restoredStatus?: RestoredConnectionStatus }
  > {
    const connection = await this.respond(connectionId, actorId, action);
    const otherUserId = this.otherId(connection, actorId);
    const [profilesById, relationshipsByUserId] = await Promise.all([
      this.profilesByUserIds(
        [otherUserId, connection.introducedBy].filter(
          (userId): userId is string => userId !== null && userId !== undefined,
        ),
      ),
      this.relationshipsByUserIds(actorId, [otherUserId]),
    ]);
    const item = toConnectionListItem(
      connection,
      actorId,
      profilesById.get(otherUserId),
      relationshipsByUserId.get(otherUserId) ?? NO_RELATIONSHIP,
      connection.introducedBy
        ? profilesById.get(connection.introducedBy)
        : undefined,
    );
    // PRD-363: an unblock also reports what it put back, the same field
    // `DELETE /blocks/:slug` returns. The restored row's own status is the
    // answer: `declined` means nothing was stashed.
    if (action === 'unblock') {
      return {
        ...item,
        restoredStatus: toRestoredConnectionStatus(connection.status),
      };
    }
    return item;
  }

  /**
   * PRD-340: reply-implies-accept. The addressee of a stranger's pending
   * message request answers it by writing their OWN reply and sending it,
   * with no separate Accept tap first, the way WhatsApp/Instagram treat a
   * typed reply as consent. Enforces exactly the guards `respond('accept',
   * ...)` does, via the SAME two private helpers: the actor must be a party
   * to the connection, it must still be `Pending` (a block via either
   * `respond('block', ...)` or the separate `/blocks` resource already flips
   * it to `Blocked`, see `severConnectionForBlock`, so this throws the same
   * `ConflictException` a plain Accept would), and only the addressee may
   * accept. It does NOT re-check "who can message me" or profile visibility:
   * those gated the request's CREATION, and neither the ordinary Accept
   * button nor this one re-opens that question, since accepting answers a
   * request that already passed them.
   *
   * The reply itself is never posted here. `MessageRequestsService`'s
   * existing `CONNECTION_ACCEPTED` listener does it (cross-feature via the
   * event emitter, never a direct call, so connections stays decoupled from
   * messaging), extended to also post `replyBody` right after the intro
   * message it may seed, in that one sequential chain, so the two can never
   * land out of order.
   */
  async respondWithReply(
    connectionId: string,
    actorId: string,
    replyBody: string,
  ): Promise<Connection> {
    const conn = await this.loadRespondableConnection(connectionId, actorId);
    const updated = await this.acceptOrDecline(conn, actorId, 'accept');
    this.eventEmitter.emit(CONNECTION_ACCEPTED, {
      connectionId: updated.id,
      requesterId: updated.requesterId,
      addresseeId: updated.addresseeId,
      requestMessage: updated.requestMessage,
      replyBody,
    } satisfies ConnectionAcceptedEvent);
    return updated;
  }

  /** `POST /connections/:id/reply` wrapper, mapped like {@link respondView}. */
  async respondWithReplyView(
    connectionId: string,
    actorId: string,
    replyBody: string,
  ): Promise<ConnectionListItem> {
    const connection = await this.respondWithReply(
      connectionId,
      actorId,
      replyBody,
    );
    const otherUserId = this.otherId(connection, actorId);
    const [profilesById, relationshipsByUserId] = await Promise.all([
      this.profilesByUserIds(
        [otherUserId, connection.introducedBy].filter(
          (userId): userId is string => userId !== null && userId !== undefined,
        ),
      ),
      this.relationshipsByUserIds(actorId, [otherUserId]),
    ]);
    return toConnectionListItem(
      connection,
      actorId,
      profilesById.get(otherUserId),
      relationshipsByUserId.get(otherUserId) ?? NO_RELATIONSHIP,
      connection.introducedBy
        ? profilesById.get(connection.introducedBy)
        : undefined,
    );
  }

  async remove(connectionId: string, actorId: string): Promise<{ ok: true }> {
    const conn = await this.connections.findOne({
      where: { id: connectionId },
    });
    if (!conn) {
      throw new NotFoundException('Connection not found');
    }
    if (actorId !== conn.requesterId && actorId !== conn.addresseeId) {
      throw new ForbiddenException('Not your connection');
    }
    // You cannot delete a block the OTHER party placed on you (only they unblock).
    if (
      conn.status === ConnectionStatus.Blocked &&
      conn.blockedBy !== actorId
    ) {
      throw new ForbiddenException('You are blocked');
    }
    await this.connections.delete(connectionId);
    return { ok: true };
  }

  /**
   * One page of the member's own address book.
   *
   * Two shapes, deliberately:
   *
   *  - With no search term and the default recency ordering, the original
   *    `findAndCount` per tab runs untouched. That is the common case and it
   *    needs no join.
   *  - With `q` or a non-default `sort`, the page is resolved by
   *    {@link listBySearchOrSort}, which joins the other member's profile so
   *    the filter and the ordering happen in SQL and the `total` stays honest
   *    across pages.
   *
   * Either way the mapping tail is shared, so every row carries the same
   * relationship signals, the same introducer, and the viewer's own private
   * note.
   */
  async list(
    userId: string,
    tab: ConnectionTab,
    query?: ConnectionListOptions,
  ): Promise<Paginated<ConnectionListItem>> {
    const page = normalizePage(query?.page);
    const take = PAGE_SIZE;
    const skip = (page - 1) * PAGE_SIZE;
    const searchTerm = query?.q?.trim() ?? '';
    const sort: ConnectionSort = query?.sort ?? 'recent';

    let rows: Connection[];
    let total: number;
    if (searchTerm || sort !== 'recent') {
      [rows, total] = await this.listBySearchOrSort(
        userId,
        tab,
        searchTerm,
        sort,
        page,
      );
    } else if (tab === 'incoming') {
      [rows, total] = await this.connections.findAndCount({
        where: { addresseeId: userId, status: ConnectionStatus.Pending },
        order: { createdAt: 'DESC' },
        take,
        skip,
      });
    } else if (tab === 'outgoing') {
      [rows, total] = await this.connections.findAndCount({
        where: { requesterId: userId, status: ConnectionStatus.Pending },
        order: { createdAt: 'DESC' },
        take,
        skip,
      });
    } else if (tab === 'vouched') {
      // Members the viewer has vouched for. VouchService owns the "who did I
      // vouch for" read; we push the intersection with the accepted-connection
      // set into SQL — the accepted edge where the far end is one of those
      // vouchees — so `findAndCount` paginates and totals server-side instead of
      // loading the viewer's entire connection set to filter in memory.
      const vouchedIds = await this.vouchService.getActiveVoucheeIds(userId);
      if (!vouchedIds.length) {
        rows = [];
        total = 0;
      } else {
        [rows, total] = await this.connections.findAndCount({
          where: [
            {
              requesterId: userId,
              addresseeId: In(vouchedIds),
              status: ConnectionStatus.Accepted,
            },
            {
              addresseeId: userId,
              requesterId: In(vouchedIds),
              status: ConnectionStatus.Accepted,
            },
          ],
          order: { respondedAt: 'DESC' },
          take,
          skip,
        });
      }
    } else {
      // all: accepted connections the user is in.
      [rows, total] = await this.connections.findAndCount({
        where: [
          { requesterId: userId, status: ConnectionStatus.Accepted },
          { addresseeId: userId, status: ConnectionStatus.Accepted },
        ],
        order: { respondedAt: 'DESC' },
        take,
        skip,
      });
    }

    const otherIds = rows.map((c) => this.otherId(c, userId));
    const introducerIds = rows
      .map((c) => c.introducedBy)
      .filter((id): id is string => id !== null && id !== undefined);
    const [
      profilesById,
      relationshipsByUserId,
      notesByConnectionId,
      requestReadByConnectionId,
    ] = await Promise.all([
      this.profilesByUserIds([...otherIds, ...introducerIds]),
      this.relationshipsByUserIds(userId, otherIds),
      this.viewerNotesByConnectionId(
        userId,
        rows.map((c) => c.id),
      ),
      // PRD-344: only the "outgoing" tab ever shows a sender their own
      // pending request back, so this is the only tab worth the extra
      // notification + privacy reads; every other tab pays nothing for it.
      tab === 'outgoing'
        ? this.requestReadFlagsByConnectionId(userId, rows)
        : Promise.resolve(new Map<string, boolean | null>()),
    ]);
    const items = rows.map((c) => {
      const otherUserId = this.otherId(c, userId);
      return toConnectionListItem(
        c,
        userId,
        profilesById.get(otherUserId),
        relationshipsByUserId.get(otherUserId) ?? NO_RELATIONSHIP,
        c.introducedBy ? profilesById.get(c.introducedBy) : undefined,
        notesByConnectionId.get(c.id) ?? null,
        requestReadByConnectionId.get(c.id) ?? null,
      );
    });
    return { items, total, page, pageSize: PAGE_SIZE };
  }

  /**
   * PRD-344: has the addressee of each of the viewer's own OUTGOING pending
   * requests seen it, so the sender can tell whether their intro was read,
   * the same fact WhatsApp/Instagram show as a read tick.
   *
   * A pending request has no conversation yet (that only materializes on
   * accept), so there is no read watermark to report. The only EXISTING
   * signal is whether the addressee's `ConnectionRequest` bell notification
   * for this connection has been marked read. That is a proxy for having
   * seen the notification, not literally "opened the Requests tab": it flips
   * whenever the addressee reads that notification, including a bulk "mark
   * all read". It is the best signal available without a new column on
   * `connections` (a schema migration is out of scope for this change).
   *
   * Gated by `share_read_receipts` exactly like every other read-receipt
   * surface in this codebase (`MessagingCoreService.buildMemberSummaries`,
   * `ConversationsService`): reciprocal, so a withheld read state reads as
   * `null` whenever EITHER the viewer or the addressee has turned their own
   * sharing off, keeping a real read state from leaking through a preference
   * meant to hide it.
   */
  private async requestReadFlagsByConnectionId(
    viewerId: string,
    rows: Connection[],
  ): Promise<Map<string, boolean | null>> {
    const result = new Map<string, boolean | null>();
    if (!rows.length) {
      return result;
    }
    const addresseeIds = [...new Set(rows.map((c) => c.addresseeId))];
    const [privacyRows, notificationRows] = await Promise.all([
      this.memberPreferences.find({
        where: { userId: In([viewerId, ...addresseeIds]) },
        select: { userId: true, shareReadReceipts: true },
      }),
      this.notifications.find({
        where: {
          userId: In(addresseeIds),
          type: NotificationType.ConnectionRequest,
        },
        select: { userId: true, payload: true, read: true },
      }),
    ]);
    // Absent row = never opened Settings = sharing on, the same default
    // `AddMessagingPrivacyPreferences1820500000000`'s column default and
    // `PreferencesService.defaults()` both encode.
    const sharesReadReceiptsByUser = new Map(
      privacyRows.map((row) => [row.userId, row.shareReadReceipts]),
    );
    const viewerShares = sharesReadReceiptsByUser.get(viewerId) ?? true;
    const readByConnectionId = new Map<string, boolean>();
    for (const row of notificationRows) {
      const connectionId = row.payload?.connectionId;
      if (typeof connectionId !== 'string') continue;
      // A re-opened (declined, then re-asked) request can, in principle,
      // carry more than one `ConnectionRequest` notification for the same
      // connection id. Any one of them being read is enough to call it read.
      readByConnectionId.set(
        connectionId,
        readByConnectionId.get(connectionId) === true || row.read,
      );
    }
    for (const conn of rows) {
      const addresseeShares =
        sharesReadReceiptsByUser.get(conn.addresseeId) ?? true;
      if (!viewerShares || !addresseeShares) {
        result.set(conn.id, null);
        continue;
      }
      result.set(conn.id, readByConnectionId.get(conn.id) ?? false);
    }
    return result;
  }

  /**
   * The searched and/or re-ordered variant of {@link list}'s row fetch.
   *
   * Returns `[rows, total]` in the same shape the plain `findAndCount`
   * branches do, so the caller's mapping tail is identical either way.
   */
  private async listBySearchOrSort(
    userId: string,
    tab: ConnectionTab,
    searchTerm: string,
    sort: ConnectionSort,
    page: number,
  ): Promise<[Connection[], number]> {
    let vouchedIds: string[] | null = null;
    if (tab === 'vouched') {
      vouchedIds = await this.vouchService.getActiveVoucheeIds(userId);
      if (!vouchedIds.length) {
        return [[], 0];
      }
    }
    const query = this.buildSearchableListQuery(
      userId,
      tab,
      vouchedIds,
      searchTerm,
    );

    if (sort === 'mutuals') {
      return this.pageRankedByMutuals(userId, tab, query, page);
    }

    if (sort === 'alphabetical') {
      // Folded so "Ávila" sorts with the A's rather than after Z, which is
      // what the database's own collation does under a C-like locale.
      query
        .orderBy(foldedTextExpression('other.first_name'), 'ASC')
        .addOrderBy(foldedTextExpression('other.last_name'), 'ASC');
    } else {
      this.applyRecencyOrder(query, tab);
    }
    // A stable tiebreak, so two rows with the same timestamp (or the same
    // name) cannot swap places between page 1 and page 2 and hide a row.
    query.addOrderBy('connection.id', 'ASC');

    // `.offset()`/`.limit()` rather than `.skip()`/`.take()`: this query joins
    // and can order by a joined column, which is exactly the combination
    // `.skip()`/`.take()` gets wrong.
    return query
      .offset((page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .getManyAndCount();
  }

  /**
   * "Most mutuals first". The count is viewer-relative, so it is not a column
   * anything can `ORDER BY`: the matching set is taken in recency order up to
   * {@link MUTUAL_SORT_MAX}, scored with the existing batched mutual-count
   * read, re-ordered, and then sliced into a page.
   *
   * `total` stays the true total, so the tab badge and the list still agree.
   * Sorting is stable, so members who share the same number of mutuals keep
   * the recency order they arrived in.
   */
  private async pageRankedByMutuals(
    userId: string,
    tab: ConnectionTab,
    query: SelectQueryBuilder<Connection>,
    page: number,
  ): Promise<[Connection[], number]> {
    const total = await query.clone().getCount();
    if (!total) {
      return [[], 0];
    }
    const ranking = this.applyRecencyOrder(query.clone(), tab)
      .addOrderBy('connection.id', 'ASC')
      .limit(MUTUAL_SORT_MAX);
    const candidates = await ranking.getMany();
    const mutualCounts = await this.mutualCountsByUserIds(
      userId,
      candidates.map((c) => this.otherId(c, userId)),
    );
    const ordered = [...candidates].sort(
      (left, right) =>
        (mutualCounts.get(this.otherId(right, userId)) ?? 0) -
        (mutualCounts.get(this.otherId(left, userId)) ?? 0),
    );
    const skip = (page - 1) * PAGE_SIZE;
    return [ordered.slice(skip, skip + PAGE_SIZE), total];
  }

  /**
   * The joined query behind search and non-default sorts: the viewer's edges
   * for this tab, with the OTHER member's profile joined on so their name,
   * handle, and headline are filterable and sortable in SQL.
   *
   * The join condition derives the far end of each edge from the viewer, which
   * is the same "who is the other person here" rule {@link otherId} applies in
   * memory. Every predicate is still anchored on `connections`, so the profile
   * comparison only ever runs over the viewer's own connection degree.
   */
  private buildSearchableListQuery(
    userId: string,
    tab: ConnectionTab,
    vouchedIds: string[] | null,
    searchTerm: string,
  ): SelectQueryBuilder<Connection> {
    const otherUserIdExpression =
      'CASE WHEN connection.requester_id = :viewerUserId ' +
      'THEN connection.addressee_id ELSE connection.requester_id END';
    const query = this.connections
      .createQueryBuilder('connection')
      .setParameter('viewerUserId', userId)
      .innerJoin(Profile, 'other', `other.user_id = ${otherUserIdExpression}`);

    if (tab === 'incoming') {
      query
        .where('connection.addressee_id = :viewerUserId')
        .andWhere('connection.status = :status', {
          status: ConnectionStatus.Pending,
        });
    } else if (tab === 'outgoing') {
      query
        .where('connection.requester_id = :viewerUserId')
        .andWhere('connection.status = :status', {
          status: ConnectionStatus.Pending,
        });
    } else {
      query
        .where(
          '(connection.requester_id = :viewerUserId ' +
            'OR connection.addressee_id = :viewerUserId)',
        )
        .andWhere('connection.status = :status', {
          status: ConnectionStatus.Accepted,
        });
      if (vouchedIds) {
        // The vouched tab is the accepted set narrowed to members the viewer
        // vouched for. Expressed on the joined profile, so it composes with
        // the search predicate instead of needing a second `where` shape.
        query.andWhere('other.user_id IN (:...vouchedIds)', { vouchedIds });
      }
    }

    if (searchTerm) {
      // One folded `LIKE` over name + handle + headline. Both sides go through
      // the same folding, so "Sao" matches "São" and "SÃO" alike. The term is
      // LIKE-escaped so a member typing `%` searches for a percent sign rather
      // than matching everyone.
      query.andWhere(
        `${foldedTextExpression(`(${CONNECTION_SEARCH_HAYSTACK})`)} ` +
          `LIKE ${foldedTextExpression(':searchPattern')} ESCAPE '\\'`,
        { searchPattern: `%${escapeLikeTerm(searchTerm)}%` },
      );
    }
    return query;
  }

  /**
   * Newest first, reading the timestamp that actually means something for the
   * tab: when the request was sent for the pending tabs, when it was accepted
   * for the connected ones. Mirrors the plain `findAndCount` branches exactly.
   */
  private applyRecencyOrder(
    query: SelectQueryBuilder<Connection>,
    tab: ConnectionTab,
  ): SelectQueryBuilder<Connection> {
    return tab === 'incoming' || tab === 'outgoing'
      ? query.orderBy('connection.created_at', 'DESC')
      : query.orderBy('connection.responded_at', 'DESC');
  }

  /**
   * The viewer's OWN notes for a page of connections, keyed by connection id.
   *
   * `authorId: viewerUserId` is the whole privacy guarantee for the private
   * note, and it lives here rather than in the mapper on purpose: a note
   * written by the other party is never loaded, so no later change to a
   * response DTO can leak one. Both parties may hold a note on the same
   * connection; each read sees only their own.
   */
  private async viewerNotesByConnectionId(
    viewerUserId: string,
    connectionIds: string[],
  ): Promise<Map<string, string>> {
    if (!connectionIds.length) {
      return new Map();
    }
    const rows = await this.connectionNotes.find({
      where: { authorId: viewerUserId, connectionId: In(connectionIds) },
    });
    return new Map(rows.map((note) => [note.connectionId, note.body]));
  }

  /**
   * Write (or clear) the viewer's private note on one of their connections.
   *
   * Only a party to the connection may annotate it. An empty body, or one that
   * strips down to nothing, deletes the note rather than storing a blank every
   * read site would then have to treat as absent. Markup is stripped once here,
   * at the write boundary, never at render.
   */
  async setNote(
    connectionId: string,
    authorId: string,
    body: string,
  ): Promise<{ note: string | null }> {
    const conn = await this.connections.findOne({
      where: { id: connectionId },
    });
    if (!conn) {
      throw new NotFoundException('Connection not found');
    }
    if (authorId !== conn.requesterId && authorId !== conn.addresseeId) {
      throw new ForbiddenException('Not your connection');
    }
    const stored = toStoredPlainTextOrNull(body);
    if (!stored) {
      await this.connectionNotes.delete({ connectionId, authorId });
      return { note: null };
    }
    // `(connection_id, author_id)` is UNIQUE, so a re-save is one atomic
    // upsert instead of a read-then-write that two tabs could race.
    await this.connectionNotes.upsert(
      { connectionId, authorId, body: stored, updatedAt: new Date() },
      { conflictPaths: ['connectionId', 'authorId'] },
    );
    return { note: stored };
  }

  /**
   * The total behind each tab, in one shot — powers the client's tab badges
   * without fetching any list. Each count mirrors the matching `tab` filter in
   * {@link list} exactly, so a badge and its opened list always agree. "blocked"
   * is intentionally absent: blocks are owned by the social/blocks resource, not
   * this endpoint.
   */
  async counts(userId: string): Promise<ConnectionCounts> {
    const accepted: FindOptionsWhere<Connection>[] = [
      { requesterId: userId, status: ConnectionStatus.Accepted },
      { addresseeId: userId, status: ConnectionStatus.Accepted },
    ];
    const [all, incoming, outgoing, vouched] = await Promise.all([
      this.connections.count({ where: accepted }),
      this.connections.count({
        where: { addresseeId: userId, status: ConnectionStatus.Pending },
      }),
      this.connections.count({
        where: { requesterId: userId, status: ConnectionStatus.Pending },
      }),
      this.countVouched(userId),
    ]);
    return { all, incoming, outgoing, vouched };
  }

  /**
   * How many of the viewer's accepted connections they've also vouched for.
   * Mirrors the `vouched` branch of {@link list}: VouchService supplies the
   * members the viewer vouched for, and the intersection with their accepted
   * connections is a bounded `COUNT` in SQL — the `(userLow, userHigh)` pair is
   * unique, so each vouchee contributes at most one accepted edge and the count
   * is exact.
   */
  private async countVouched(userId: string): Promise<number> {
    const vouchedIds = await this.vouchService.getActiveVoucheeIds(userId);
    if (!vouchedIds.length) {
      return 0;
    }
    return this.connections.count({
      where: [
        {
          requesterId: userId,
          addresseeId: In(vouchedIds),
          status: ConnectionStatus.Accepted,
        },
        {
          addresseeId: userId,
          requesterId: In(vouchedIds),
          status: ConnectionStatus.Accepted,
        },
      ],
    });
  }

  async areConnected(a: string, b: string): Promise<boolean> {
    const conn = await this.findPair(a, b);
    return conn?.status === ConnectionStatus.Accepted;
  }

  async getAcceptedConnectionUserIds(userId: string): Promise<string[]> {
    const rows = await this.connections.find({
      where: [
        { requesterId: userId, status: ConnectionStatus.Accepted },
        { addresseeId: userId, status: ConnectionStatus.Accepted },
      ],
      take: DEFAULT_LIST_LIMIT,
    });
    return rows.map((c) =>
      c.requesterId === userId ? c.addresseeId : c.requesterId,
    );
  }

  /**
   * Every accepted-connection counterpart id for `userId` — deliberately NOT
   * capped at `DEFAULT_LIST_LIMIT`, unlike `getAcceptedConnectionUserIds`
   * (whose cap is fine for the UI lists it backs, e.g. "Say hello" -> "Message"
   * button state). This backs an internal SQL predicate instead of a rendered
   * list: `EventsService.scopedVisibilityWhere`'s browse/search OR-in on
   * `host_id` for `network`-visibility gatherings. Truncating that id-set
   * would silently make a viewer's own 201st+ connection's `network`-only
   * gathering invisible in browse/search — a real UX bug for a privacy
   * feature (someone's own connection can't find their gathering), even
   * though the per-event gate (`areConnected`, an uncapped pair check) never
   * had this problem. Id-only select — the caller needs ids, not full rows.
   */
  async allAcceptedConnectionUserIds(userId: string): Promise<string[]> {
    const rows = await this.connections.find({
      where: [
        { requesterId: userId, status: ConnectionStatus.Accepted },
        { addresseeId: userId, status: ConnectionStatus.Accepted },
      ],
      select: { requesterId: true, addresseeId: true },
    });
    return rows.map((c) =>
      c.requesterId === userId ? c.addresseeId : c.requesterId,
    );
  }

  /**
   * When `userId` connected with each of `counterpartIds`, keyed by
   * counterpart id: `respondedAt` (stamped the moment the request was
   * accepted), falling back to `createdAt` for a legacy row that never
   * recorded one. A counterpart with no ACCEPTED connection is absent from the
   * map. ONE query over both request directions regardless of how many ids
   * are passed, so the DM inbox (`ConversationsService.listConversations`)
   * labels every row's "Connected since" without a per-conversation lookup.
   */
  async acceptedSinceByCounterpart(
    userId: string,
    counterpartIds: string[],
  ): Promise<Map<string, Date>> {
    if (!counterpartIds.length) {
      return new Map();
    }
    const rows = await this.connections.find({
      where: [
        {
          requesterId: userId,
          addresseeId: In(counterpartIds),
          status: ConnectionStatus.Accepted,
        },
        {
          addresseeId: userId,
          requesterId: In(counterpartIds),
          status: ConnectionStatus.Accepted,
        },
      ],
      select: {
        requesterId: true,
        addresseeId: true,
        respondedAt: true,
        createdAt: true,
      },
    });
    return new Map(
      rows.map((row) => [
        row.requesterId === userId ? row.addresseeId : row.requesterId,
        row.respondedAt ?? row.createdAt,
      ]),
    );
  }

  /**
   * The slugs of the viewer's accepted connections — the minimal signal the
   * client needs to flip a member's "Say hello" button to "Message". Mirrors
   * `getAcceptedConnectionUserIds`, resolving each counterpart user-id to its
   * profile slug. The viewer's own slug never appears.
   */
  async getAcceptedConnectionSlugs(userId: string): Promise<string[]> {
    const counterpartUserIds = await this.getAcceptedConnectionUserIds(userId);
    if (counterpartUserIds.length === 0) return [];
    const profilesByUserId = await this.profilesByUserIds(counterpartUserIds);
    return counterpartUserIds
      .map((counterpartUserId) => profilesByUserId.get(counterpartUserId)?.slug)
      .filter((slug): slug is string => typeof slug === 'string');
  }

  /**
   * Every relationship the viewer holds, in one call (PRD-03): accepted
   * connections, requests waiting for their answer, and requests they sent.
   *
   * Supersedes `getAcceptedConnectionSlugs` for the client store, which only
   * ever learned about the accepted half. A member with a request waiting from
   * somebody was shown "Say hello" on that person's profile and had the send
   * refused, because the only relationship signal the app had was "connected or
   * not". `incoming` carries the connection id as well as the slug, so the
   * profile can answer the request where it is read.
   *
   * ONE query, uncapped, selecting four columns. Uncapped because a truncated
   * set here is a wrong answer rather than a short list: the one relationship
   * that fell off the end is exactly the one whose profile would then offer the
   * wrong action. A member's accepted-plus-pending edge count is small by
   * design here (this platform has no follower graph), and both the accepted
   * and the pending lookups this replaces already ran per session.
   *
   * Declined and blocked pairs are deliberately absent. A decline hold is
   * silent by design (see `assertRequestNotOnDeclineHold`) and a block by the
   * other party is masked, so neither may be inferable from what this returns.
   */
  async getRelationshipSlugs(
    userId: string,
  ): Promise<ConnectionRelationshipSlugs> {
    const wanted = In([ConnectionStatus.Accepted, ConnectionStatus.Pending]);
    const rows = await this.connections.find({
      where: [
        { requesterId: userId, status: wanted },
        { addresseeId: userId, status: wanted },
      ],
      select: {
        id: true,
        status: true,
        requesterId: true,
        addresseeId: true,
      },
    });
    if (rows.length === 0) {
      return { connected: [], incoming: [], sent: [] };
    }
    const counterpartIds = rows.map((row) =>
      row.requesterId === userId ? row.addresseeId : row.requesterId,
    );
    const profilesByUserId = await this.profilesByUserIds(counterpartIds);
    const connected: string[] = [];
    const incoming: IncomingConnectionRef[] = [];
    const sent: string[] = [];
    for (const row of rows) {
      const counterpartId =
        row.requesterId === userId ? row.addresseeId : row.requesterId;
      // A counterpart whose profile no longer resolves (an erased account) has
      // no slug for the client to key on, so the edge is simply not reported.
      const slug = profilesByUserId.get(counterpartId)?.slug;
      if (!slug) {
        continue;
      }
      if (row.status === ConnectionStatus.Accepted) {
        connected.push(slug);
      } else if (row.addresseeId === userId) {
        incoming.push({ slug, connectionId: row.id });
      } else {
        sent.push(slug);
      }
    }
    return { connected, incoming, sent };
  }

  // --- internals ---

  /**
   * PRD-365: how many DISTINCT signed-in members have a live (open or
   * escalated) report against `$1` filed in the last `$3` days. A report counts
   * when it targets the member directly (`member` subject, addressed by userId
   * `$2` or by slug, the same two shapes `AccountEnforcementService
   * .resolveReportedProfile` accepts) or targets a message they sent. Staff
   * (moderator/admin) always read 0, so a report pile-on can never silence the
   * people who send moderation notices through `deliverEnquiry`.
   *
   * Anonymous reports (`reporter_id IS NULL`) are left out on purpose: the
   * public report endpoint is capped per IP, which is far weaker than one
   * account per person, so they cannot be counted as distinct people. A
   * member's reports against themselves are left out too.
   *
   * The message branch guards the `uuid` cast with a shape check so a
   * malformed `subject_id` can never abort the whole query.
   */
  private static readonly REQUEST_PAUSE_REPORTERS_SQL = `CASE WHEN EXISTS (
      SELECT 1 FROM "users" staff
      WHERE staff."id" = $1
        AND staff."role" IN ('${UserRole.Moderator}', '${UserRole.Admin}')
    ) THEN 0 ELSE (
      SELECT COUNT(DISTINCT report."reporter_id")
      FROM "reports" report
      WHERE report."status" IN ('${ReportStatus.Open}', '${ReportStatus.Escalated}')
        AND report."reporter_id" IS NOT NULL
        AND report."reporter_id" <> $1
        AND report."created_at" > now() - make_interval(days => $3::int)
        AND (
          (
            report."subject_type" = '${ReportSubjectType.Member}'
            AND report."subject_id" IN (
              $2::text,
              (SELECT profile."slug" FROM "profiles" profile WHERE profile."user_id" = $1)
            )
          )
          OR (
            report."subject_type" = '${ReportSubjectType.Message}'
            AND EXISTS (
              SELECT 1 FROM "messages" message
              WHERE message."sender_id" = $1
                AND message."id" = CASE
                  WHEN report."subject_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN report."subject_id"::uuid
                END
            )
          )
        )
    ) END`;

  /**
   * PRD-365: every cap a NEW connection request from `requesterId` must clear,
   * read in one round trip, checked in order of what the member most needs to
   * hear:
   *
   *  1. The report-driven pause (403 CONNECTION_REQUESTS_PAUSED). Nothing is
   *     written to the member's account: the pause is derived live from the
   *     reports table, so it lifts by itself the moment moderators resolve
   *     enough of them or they age out of the window.
   *  2. The rolling daily cap (429 CONNECTION_REQUEST_DAILY_LIMIT), read from
   *     the `connection_request_events` ledger so withdrawing a request or
   *     re-opening a declined pair cannot reset it.
   *  3. The open-pending cap (429 CONNECTION_REQUEST_PENDING_LIMIT), served by
   *     `IDX_connections_requester_status_responded_at`. It counts a request
   *     STASHED by a block (`blocked` + `status_before_block = 'pending'`) as
   *     open too, because it is: `severConnectionForBlock` flips a pending row
   *     to `blocked` and keeps the `pending` for the unblock to restore. A
   *     count over `status = 'pending'` alone let a member at the cap block
   *     their own addressees, watch the counter fall, send a fresh batch and
   *     unblock everyone, holding far more open requests than the cap allows.
   *
   * Checked before the request is written, so two requests racing at the very
   * edge can both pass; the per-minute throttle on both request routes bounds
   * that overshoot to a handful. The existing throttle stays in place.
   */
  private async assertFirstContactAllowed(requesterId: string): Promise<void> {
    const rows = await this.dataSource.query<
      Array<{
        distinctReporterCount: number;
        dailyCount: number;
        pendingCount: number;
      }>
    >(
      `SELECT
         (${ConnectionsService.REQUEST_PAUSE_REPORTERS_SQL})::int AS "distinctReporterCount",
         (SELECT COUNT(*) FROM "connection_request_events" request_event
           WHERE request_event."requester_id" = $1
             AND request_event."created_at" > now() - make_interval(hours => $4::int)
         )::int AS "dailyCount",
         (SELECT COUNT(*) FROM "connections" outgoing
           WHERE outgoing."requester_id" = $1
             AND (
               outgoing."status" = '${ConnectionStatus.Pending}'
               OR (
                 outgoing."status" = '${ConnectionStatus.Blocked}'
                 AND outgoing."status_before_block" = '${ConnectionStatus.Pending}'
               )
             )
         )::int AS "pendingCount"`,
      [
        requesterId,
        requesterId,
        REQUEST_PAUSE_REPORT_WINDOW_DAYS,
        CONNECTION_REQUEST_DAILY_WINDOW_HOURS,
      ],
    );
    const counts = rows[0];
    if (
      (counts?.distinctReporterCount ?? 0) >= REQUEST_PAUSE_DISTINCT_REPORTERS
    ) {
      throw connectionRequestsPausedException();
    }
    if ((counts?.dailyCount ?? 0) >= MAX_NEW_CONNECTION_REQUESTS_PER_DAY) {
      throw connectionRequestDailyLimitException();
    }
    if ((counts?.pendingCount ?? 0) >= MAX_OPEN_PENDING_REQUESTS) {
      throw connectionRequestPendingLimitException();
    }
  }

  /**
   * PRD-365: the report-driven pause on its own, for cold contact that is
   * exempt from the volume caps (`MessageRequestsService.deliverEnquiry`).
   * Callers skip it for accepted connections: replies within an existing
   * connection are never paused.
   */
  async assertRequestsNotPaused(userId: string): Promise<void> {
    const rows = await this.dataSource.query<
      Array<{ distinctReporterCount: number }>
    >(
      `SELECT (${ConnectionsService.REQUEST_PAUSE_REPORTERS_SQL})::int AS "distinctReporterCount"`,
      [userId, userId, REQUEST_PAUSE_REPORT_WINDOW_DAYS],
    );
    if (
      (rows[0]?.distinctReporterCount ?? 0) >= REQUEST_PAUSE_DISTINCT_REPORTERS
    ) {
      throw connectionRequestsPausedException();
    }
  }

  /**
   * PRD-365: append one row to the daily-cap ledger once a request has cleared
   * every gate, pruning this member's rows that have left the window in the
   * same statement (a data-modifying CTE always runs), so the ledger never
   * holds more than a day of requests per member.
   */
  private async recordRequestEvent(requesterId: string): Promise<void> {
    await this.dataSource.query(
      `WITH pruned AS (
         DELETE FROM "connection_request_events"
         WHERE "requester_id" = $1
           AND "created_at" <= now() - make_interval(hours => $2::int)
       )
       INSERT INTO "connection_request_events" ("requester_id") VALUES ($1)`,
      [requesterId, CONNECTION_REQUEST_DAILY_WINDOW_HOURS],
    );
  }

  /**
   * PRD-366: the recipient's "who can message me" choice. A member with no
   * `member_preferences` row, or a value outside the closed set, reads as
   * `everyone`, the platform's behaviour before the setting existed.
   */
  private async recipientWhoCanMessage(userId: string): Promise<WhoCanMessage> {
    const rows = await this.dataSource.query<
      Array<{ whoCanMessage: string | null }>
    >(
      `SELECT "who_can_message" AS "whoCanMessage" FROM "member_preferences" WHERE "user_id" = $1`,
      [userId],
    );
    const value = rows[0]?.whoCanMessage;
    return (
      WHO_CAN_MESSAGE_VALUES.find((option) => option === value) ??
      DEFAULT_WHO_CAN_MESSAGE
    );
  }

  private emitRequested(conn: Connection): void {
    this.eventEmitter.emit(CONNECTION_REQUESTED, {
      connectionId: conn.id,
      requesterId: conn.requesterId,
      addresseeId: conn.addresseeId,
      introducedBy: conn.introducedBy,
    } satisfies ConnectionRequestedEvent);
  }

  /**
   * Fire a post-commit domain event without letting a listener's failure bubble
   * into (and 500) a write that has already committed. Mirrors
   * `GroupsService.emitBestEffort` / `SocialService.emitBestEffort`.
   */
  private emitBestEffort(eventName: string, payload: unknown): void {
    try {
      this.eventEmitter.emit(eventName, payload);
    } catch {
      // best-effort: post-commit live fan-out never fails a committed write.
    }
  }

  private otherId(conn: Connection, userId: string): string {
    return conn.requesterId === userId ? conn.addresseeId : conn.requesterId;
  }

  private pair(a: string, b: string): { low: string; high: string } {
    return a < b ? { low: a, high: b } : { low: b, high: a };
  }

  /**
   * Create an already-`Accepted` connection inside the CALLER'S transaction,
   * addressed by user ids. The signup flow uses this to auto-connect an inviter
   * with the member they personally brought in, so the connection commits or
   * rolls back together with the account creation, invite claim, and auto-vouch.
   *
   * Deliberately silent: it does NOT emit `CONNECTION_ACCEPTED`. That event
   * materializes a conversation (§7) and would survive a rollback of the
   * caller's transaction — and an auto-connect is an implicit link, not a user
   * action, so it produces no notification or conversation.
   *
   * Bare insert, no duplicate handling: the member is created in the same
   * transaction, so no prior `(userLow, userHigh)` row can exist. Skips (returns
   * false) a self-connection — impossible for a brand-new signup, but keeps the
   * helper safe for any caller.
   *
   * `requestReason` carries the `system:autoConnect` sentinel rather than
   * `null`. This row was never a hello the new member received, so it must not
   * read as one: `NowInsightsService` (the profile "Now" card) sums hellos,
   * replies, and a response-time median straight off `connections` rows, and a
   * silent, already-accepted, zero-latency row would otherwise inflate every
   * one of those figures for a personally invited member's first window and
   * could pull a genuinely slow responder's median down to a claim they never
   * earned. The `system:` prefix (not the exact string) is deliberate: it lets
   * `NowInsightsService` exclude any future system-written row for free by
   * matching the prefix, not this one literal value.
   */
  async createConnectionInTransaction(
    manager: EntityManager,
    inviterId: string,
    memberId: string,
  ): Promise<boolean> {
    if (inviterId === memberId) {
      return false;
    }
    const { low, high } = this.pair(inviterId, memberId);
    await manager.insert(Connection, {
      requesterId: inviterId,
      addresseeId: memberId,
      userLow: low,
      userHigh: high,
      status: ConnectionStatus.Accepted,
      respondedAt: new Date(),
      requestMessage: null,
      requestReason: 'system:autoConnect',
      introducedBy: null,
      flagged: false,
    });
    return true;
  }

  private findPair(a: string, b: string): Promise<Connection | null> {
    const { low, high } = this.pair(a, b);
    return this.connections.findOne({
      where: { userLow: low, userHigh: high },
    });
  }

  private async profilesByUserIds(
    userIds: string[],
  ): Promise<Map<string, Profile>> {
    if (!userIds.length) {
      return new Map();
    }
    const found = await this.profiles.find({
      where: { userId: In(userIds) },
    });
    return new Map(found.map((p) => [p.userId, p]));
  }

  /**
   * The viewer-relative relationship (shared connections + vouch badge) for each
   * of `otherIds`, batched into one map. Members with nothing shared are simply
   * absent — callers default to {@link NO_RELATIONSHIP}.
   */
  private async relationshipsByUserIds(
    viewerUserId: string,
    otherIds: string[],
  ): Promise<Map<string, ConnectionRelationship>> {
    const relationships = new Map<string, ConnectionRelationship>();
    if (!otherIds.length) {
      return relationships;
    }
    const [mutualCounts, vouchBadges] = await Promise.all([
      this.mutualCountsByUserIds(viewerUserId, otherIds),
      this.vouchBadgesByUserIds(viewerUserId, otherIds),
    ]);
    for (const otherId of new Set(otherIds)) {
      const mutuals = mutualCounts.get(otherId) ?? 0;
      const vouchBadge = vouchBadges.get(otherId) ?? null;
      if (mutuals || vouchBadge) {
        relationships.set(otherId, { mutuals, vouchBadge });
      }
    }
    return relationships;
  }

  /**
   * Shared accepted-connection counts between the viewer and each of `otherIds`.
   * Loads every accepted edge touching an other member, collects the far ends of
   * those edges, then asks — in one bounded query filtered to exactly those far
   * ends — which are the viewer's own connections. Cost scales with the size of
   * the page's neighbourhood, not the viewer's total connection degree, so the
   * viewer's full accepted set is never loaded. The direct viewer↔other edge is
   * excluded for free — the viewer is never a member of their own connection set.
   *
   * PUBLIC (like `acceptedConnectionsAmong`) because `EventAudienceGateService`
   * (events feature) reuses this "any mutual connection?" computation to back
   * `EventVisibility.ExtendedNetwork`'s 2nd-degree gate. This is a
   * GENERALIZATION of `resolveRequestGate`'s profile-`network` graph test
   * above, not the same test: that gate checks whether ONE NAMED introducer
   * is connected to both parties; this one checks whether ANY mutual
   * connection exists at all. Same underlying accepted-connections graph and
   * the same query shape (edges touching the other side, then intersected
   * against the viewer's own connections), reused rather than re-derived —
   * but a different question is being asked.
   */
  async mutualCountsByUserIds(
    viewerUserId: string,
    otherIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!otherIds.length) {
      return counts;
    }
    const otherSet = new Set(otherIds);
    const edges = await this.connections.find({
      where: [
        { requesterId: In(otherIds), status: ConnectionStatus.Accepted },
        { addresseeId: In(otherIds), status: ConnectionStatus.Accepted },
      ],
    });
    // The far end of each edge from an other member is a candidate mutual; only
    // these ids need to be tested against the viewer's connections.
    const candidateFarEnds = new Set<string>();
    for (const edge of edges) {
      for (const candidate of [edge.requesterId, edge.addresseeId]) {
        if (!otherSet.has(candidate)) {
          continue;
        }
        const farEnd =
          candidate === edge.requesterId ? edge.addresseeId : edge.requesterId;
        candidateFarEnds.add(farEnd);
      }
    }
    const viewerConnections = await this.acceptedConnectionsAmong(
      viewerUserId,
      [...candidateFarEnds],
    );
    if (!viewerConnections.size) {
      return counts;
    }
    for (const edge of edges) {
      for (const candidate of [edge.requesterId, edge.addresseeId]) {
        if (!otherSet.has(candidate)) {
          continue;
        }
        const farEnd =
          candidate === edge.requesterId ? edge.addresseeId : edge.requesterId;
        if (viewerConnections.has(farEnd)) {
          counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
        }
      }
    }
    return counts;
  }

  /**
   * Of `candidateIds`, the subset that are accepted-connected to the viewer —
   * one bounded query (`In(candidateIds)`) instead of loading the viewer's whole
   * accepted set. The viewer never appears in the result (no self-edge exists),
   * so a candidate equal to the viewer is harmlessly filtered out.
   *
   * PUBLIC because callers outside this service need a precise membership test
   * bounded by a KNOWN candidate set — e.g. messaging's group member-gate, which
   * must not use the 200-capped `getAcceptedConnectionUserIds` (a valid
   * connection beyond that cap would be wrongly rejected). Cost scales with
   * `candidateIds.length`, never the viewer's total connection degree.
   */
  async acceptedConnectionsAmong(
    viewerUserId: string,
    candidateIds: string[],
  ): Promise<Set<string>> {
    const connected = new Set<string>();
    if (!candidateIds.length) {
      return connected;
    }
    const edges = await this.connections.find({
      where: [
        {
          requesterId: viewerUserId,
          addresseeId: In(candidateIds),
          status: ConnectionStatus.Accepted,
        },
        {
          addresseeId: viewerUserId,
          requesterId: In(candidateIds),
          status: ConnectionStatus.Accepted,
        },
      ],
    });
    for (const edge of edges) {
      connected.add(
        edge.requesterId === viewerUserId ? edge.addresseeId : edge.requesterId,
      );
    }
    return connected;
  }

  /**
   * `userId`'s accepted-connection counterpart ids, ordered oldest-accepted
   * edge first (ties broken by connection `id`) — a deterministic ordering
   * key for {@link mutualMembers}'s "top `limit`" slice, so the same names
   * don't shuffle between requests on unstable DB row order. Distinct from
   * `getAcceptedConnectionUserIds` (200-capped, unordered — fine for the UI
   * lists it backs) and `allAcceptedConnectionUserIds` (uncapped, also
   * unordered) — this one is for a list a person actually reads in order.
   */
  private async acceptedConnectionUserIdsOrdered(
    userId: string,
  ): Promise<string[]> {
    const rows = await this.connections.find({
      where: [
        { requesterId: userId, status: ConnectionStatus.Accepted },
        { addresseeId: userId, status: ConnectionStatus.Accepted },
      ],
      order: { respondedAt: 'ASC', id: 'ASC' },
    });
    return rows.map((c) =>
      c.requesterId === userId ? c.addresseeId : c.requesterId,
    );
  }

  /**
   * Mutual (accepted-connected-to-both) member ids between `viewerUserId` and
   * `otherUserId`, in the deterministic order documented on
   * {@link acceptedConnectionUserIdsOrdered}. The per-pair logic
   * `mutualCountsByUserIds` uses to test "is this far end also one of the
   * viewer's accepted connections?" is {@link acceptedConnectionsAmong} — this
   * reuses that exact same bounded query rather than re-deriving the join, it
   * just supplies a single member's ordered connection list as the candidate
   * set instead of `mutualCountsByUserIds`'s batched, unordered one.
   */
  private async mutualUserIdsBetween(
    viewerUserId: string,
    otherUserId: string,
  ): Promise<string[]> {
    const otherConnections =
      await this.acceptedConnectionUserIdsOrdered(otherUserId);
    if (!otherConnections.length) {
      return [];
    }
    const viewerConnections = await this.acceptedConnectionsAmong(
      viewerUserId,
      otherConnections,
    );
    if (!viewerConnections.size) {
      return [];
    }
    // Filter, don't rebuild from the Set — this preserves
    // acceptedConnectionUserIdsOrdered's deterministic order, which a Set
    // (or a fresh query keyed by IN (...)) would not.
    return otherConnections.filter((id) => viewerConnections.has(id));
  }

  /**
   * The viewer and `otherUserId`'s shared accepted connections: a total count
   * plus up to `limit` of their profiles (slug + name + `photoVisible`-gated
   * avatar), for a "N mutual connections" chip on another member's profile. Ordering is deterministic
   * end-to-end — {@link mutualUserIdsBetween}'s order is preserved through the
   * final profile lookup by mapping `top` to a userId->Profile lookup rather
   * than trusting `Repository.find`'s row order (unstable for an `IN (...)`
   * with no `ORDER BY`).
   */
  async mutualMembers(
    viewerUserId: string,
    otherUserId: string,
    limit = 2,
  ): Promise<{
    count: number;
    members: {
      slug: string;
      firstName: string;
      lastName: string;
      avatarUrl: string | null;
    }[];
  }> {
    const mutualUserIds = await this.mutualUserIdsBetween(
      viewerUserId,
      otherUserId,
    );
    const top = mutualUserIds.slice(0, limit);
    const profiles = top.length
      ? await this.profiles.find({
          where: { userId: In(top) },
          select: {
            userId: true,
            slug: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            photoVisible: true,
          },
        })
      : [];
    const profileByUserId = new Map(profiles.map((p) => [p.userId, p]));
    const members = top
      .map((userId) => profileByUserId.get(userId))
      .filter((p): p is Profile => p !== undefined)
      .map((p) => ({
        slug: p.slug,
        firstName: p.firstName,
        lastName: p.lastName,
        // The card shows each mutual's real face, so it goes through the one
        // `photoVisible` gate every cross-domain face uses — a mutual who hid
        // their photo falls back to initials here too.
        avatarUrl: toVisibleAvatarUrl(p),
      }));
    return { count: mutualUserIds.length, members };
  }

  /**
   * The vouch badge between the viewer and each of `otherIds`: `you-vouched`
   * when the viewer vouched for them, `vouched-for-you` the other way, `mutual`
   * for both. One query loads every vouch in either direction across the set.
   */
  private async vouchBadgesByUserIds(
    viewerUserId: string,
    otherIds: string[],
  ): Promise<Map<string, VouchBadge>> {
    const badges = new Map<string, VouchBadge>();
    if (!otherIds.length) {
      return badges;
    }
    const { youVouched, vouchedForYou } =
      await this.vouchService.getVouchDirections(viewerUserId, otherIds);
    for (const otherId of new Set(otherIds)) {
      const gave = youVouched.has(otherId);
      const received = vouchedForYou.has(otherId);
      if (gave && received) {
        badges.set(otherId, 'mutual');
      } else if (gave) {
        badges.set(otherId, 'you-vouched');
      } else if (received) {
        badges.set(otherId, 'vouched-for-you');
      }
    }
    return badges;
  }
}
