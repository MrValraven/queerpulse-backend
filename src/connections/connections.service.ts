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
import { EntityManager, FindOptionsWhere, In, Repository } from 'typeorm';
import {
  CONNECTION_ACCEPTED,
  ConnectionAcceptedEvent,
  CONNECTION_REQUESTED,
  ConnectionRequestedEvent,
} from './connection.events';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { VouchService } from '../vouch/vouch.service';
import {
  ConnectionCounts,
  ConnectionListItem,
  ConnectionRelationship,
  VouchBadge,
  toConnectionListItem,
} from './connection-response';
import { Connection, ConnectionStatus } from './entities/connection.entity';
import { Paginated, PAGE_SIZE, normalizePage } from '../common/pagination';

export type ConnectionAction = 'accept' | 'decline' | 'block' | 'unblock';
export type ConnectionTab = 'all' | 'incoming' | 'outgoing' | 'vouched';

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
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly vouchService: VouchService,
    private readonly eventEmitter: EventEmitter2,
    private readonly blockFilter: BlockFilterService,
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
          throw new ConflictException('A request is already pending');
        case ConnectionStatus.Declined: {
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
          existing.requestMessage = message ?? null;
          existing.requestReason = reason ?? null;
          existing.respondedAt = null;
          existing.blockedBy = null;
          existing.introducedBy = gate.introducedBy;
          existing.flagged = gate.flagged;
          const reopened = await this.connections.save(existing);
          this.emitRequested(reopened);
          return reopened;
        }
      }
    }

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
      requestMessage: message ?? null,
      requestReason: reason ?? null,
      introducedBy: gate.introducedBy,
      flagged: gate.flagged,
    });
    try {
      const saved = await this.connections.save(conn);
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
  private async resolveRequestGate(
    requesterId: string,
    target: Profile,
    existing: Connection | null,
    introducerSlug: string | undefined,
  ): Promise<{ introducedBy: string | null; flagged: boolean }> {
    if (target.visibility === ProfileVisibility.Private) {
      return { introducedBy: null, flagged: true };
    }
    if (target.visibility !== ProfileVisibility.Network) {
      return { introducedBy: null, flagged: false }; // open
    }
    // network
    if (existing?.status === ConnectionStatus.Accepted) {
      return { introducedBy: null, flagged: false };
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
    return { introducedBy: introducerId, flagged: false };
  }

  async respond(
    connectionId: string,
    actorId: string,
    action: ConnectionAction,
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

    switch (action) {
      case 'accept':
      case 'decline': {
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
        // Conditional claim: only one responder flips it out of pending. A
        // concurrent accept/decline sees affected === 0 and loses, so
        // CONNECTION_ACCEPTED (which materializes the conversation, §7) fires
        // exactly once.
        const claim = await this.connections.update(
          { id: conn.id, status: ConnectionStatus.Pending },
          { status: newStatus, respondedAt },
        );
        if (claim.affected !== 1) {
          throw new ConflictException('There is no pending request');
        }
        conn.status = newStatus;
        conn.respondedAt = respondedAt;
        if (action === 'accept') {
          this.eventEmitter.emit(CONNECTION_ACCEPTED, {
            connectionId: conn.id,
            requesterId: conn.requesterId,
            addresseeId: conn.addresseeId,
            requestMessage: conn.requestMessage,
          } satisfies ConnectionAcceptedEvent);
        }
        return conn;
      }
      case 'block': {
        // Can't seize a block the OTHER party already placed (else they could
        // re-block → unblock/remove to escape someone else's block).
        if (
          conn.status === ConnectionStatus.Blocked &&
          conn.blockedBy !== actorId
        ) {
          throw new ForbiddenException(
            'This connection is already blocked by the other member',
          );
        }
        conn.status = ConnectionStatus.Blocked;
        conn.blockedBy = actorId;
        conn.respondedAt = new Date();
        return this.connections.save(conn);
      }
      case 'unblock': {
        if (conn.status !== ConnectionStatus.Blocked) {
          throw new ConflictException('This connection is not blocked');
        }
        if (conn.blockedBy !== actorId) {
          throw new ForbiddenException('Only the blocker can unblock');
        }
        conn.status = ConnectionStatus.Declined;
        conn.blockedBy = null;
        return this.connections.save(conn);
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
  ): Promise<ConnectionListItem> {
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

  async list(
    userId: string,
    tab: ConnectionTab,
    query?: { page?: number },
  ): Promise<Paginated<ConnectionListItem>> {
    const page = normalizePage(query?.page);
    const take = PAGE_SIZE;
    const skip = (page - 1) * PAGE_SIZE;

    let rows: Connection[];
    let total: number;
    if (tab === 'incoming') {
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
    const [profilesById, relationshipsByUserId] = await Promise.all([
      this.profilesByUserIds([...otherIds, ...introducerIds]),
      this.relationshipsByUserIds(userId, otherIds),
    ]);
    const items = rows.map((c) => {
      const otherUserId = this.otherId(c, userId);
      return toConnectionListItem(
        c,
        userId,
        profilesById.get(otherUserId),
        relationshipsByUserId.get(otherUserId) ?? NO_RELATIONSHIP,
        c.introducedBy ? profilesById.get(c.introducedBy) : undefined,
      );
    });
    return { items, total, page, pageSize: PAGE_SIZE };
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

  // --- internals ---

  private emitRequested(conn: Connection): void {
    this.eventEmitter.emit(CONNECTION_REQUESTED, {
      connectionId: conn.id,
      requesterId: conn.requesterId,
      addresseeId: conn.addresseeId,
      introducedBy: conn.introducedBy,
    } satisfies ConnectionRequestedEvent);
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
      requestReason: null,
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
   */
  private async mutualCountsByUserIds(
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
   */
  private async acceptedConnectionsAmong(
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
