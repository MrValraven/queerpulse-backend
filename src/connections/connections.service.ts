import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { In, QueryFailedError, Repository } from 'typeorm';
import {
  CONNECTION_ACCEPTED,
  ConnectionAcceptedEvent,
  CONNECTION_REQUESTED,
  ConnectionRequestedEvent,
} from './connection.events';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import {
  ConnectionListItem,
  toConnectionListItem,
} from './connection-response';
import { Connection, ConnectionStatus } from './entities/connection.entity';
import { Paginated, PAGE_SIZE, normalizePage } from '../common/pagination';

export type ConnectionAction = 'accept' | 'decline' | 'block' | 'unblock';
export type ConnectionTab = 'all' | 'incoming' | 'outgoing' | 'vouched';

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err.driverError as { code?: string })?.code === '23505'
  );
}

@Injectable()
export class ConnectionsService {
  constructor(
    @InjectRepository(Connection)
    private readonly connections: Repository<Connection>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(Vouch) private readonly vouches: Repository<Vouch>,
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
    const profilesById = await this.profilesByUserIds(
      [otherUserId, connection.introducedBy].filter(
        (userId): userId is string => userId !== null && userId !== undefined,
      ),
    );
    return toConnectionListItem(
      connection,
      requesterId,
      profilesById.get(otherUserId),
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
      // The vouched filter (members the viewer has vouched for) can't run in
      // SQL alongside the accepted-connection query, so fetch the full accepted
      // set, filter it, and paginate in memory — this keeps `total` honest so
      // the client's infinite scroll stops at the real end.
      const accepted = await this.connections.find({
        where: [
          { requesterId: userId, status: ConnectionStatus.Accepted },
          { addresseeId: userId, status: ConnectionStatus.Accepted },
        ],
        order: { respondedAt: 'DESC' },
      });
      const given = await this.vouches.find({
        where: { voucherId: userId },
      });
      const vouchedIds = new Set(given.map((v) => v.voucheeId));
      const filtered = accepted.filter((c) =>
        vouchedIds.has(this.otherId(c, userId)),
      );
      total = filtered.length;
      rows = filtered.slice(skip, skip + take);
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
    const profilesById = await this.profilesByUserIds([
      ...otherIds,
      ...introducerIds,
    ]);
    const items = rows.map((c) =>
      toConnectionListItem(
        c,
        userId,
        profilesById.get(this.otherId(c, userId)),
        c.introducedBy ? profilesById.get(c.introducedBy) : undefined,
      ),
    );
    return { items, total, page, pageSize: PAGE_SIZE };
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
    });
    return rows.map((c) =>
      c.requesterId === userId ? c.addresseeId : c.requesterId,
    );
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
}
