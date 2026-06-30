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
import { Profile } from '../users/entities/profile.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import {
  ConnectionListItem,
  toConnectionListItem,
} from './connection-response';
import { Connection, ConnectionStatus } from './entities/connection.entity';

export type ConnectionAction = 'accept' | 'decline' | 'block' | 'unblock';
export type ConnectionTab = 'all' | 'incoming' | 'outgoing' | 'vouched';

@Injectable()
export class ConnectionsService {
  constructor(
    @InjectRepository(Connection)
    private readonly connections: Repository<Connection>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(Vouch) private readonly vouches: Repository<Vouch>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async requestConnection(
    requesterId: string,
    toSlug: string,
    message?: string,
  ): Promise<Connection> {
    const target = await this.profiles.findOne({ where: { slug: toSlug } });
    if (!target) {
      throw new NotFoundException('Member not found');
    }
    const addresseeId = target.userId;
    if (addresseeId === requesterId) {
      throw new BadRequestException('You cannot connect to yourself');
    }

    const existing = await this.findPair(requesterId, addresseeId);
    if (existing) {
      switch (existing.status) {
        case ConnectionStatus.Blocked:
          throw new ForbiddenException('This connection is blocked');
        case ConnectionStatus.Accepted:
          throw new ConflictException('You are already connected');
        case ConnectionStatus.Pending:
          throw new ConflictException('A request is already pending');
        case ConnectionStatus.Declined: {
          // Re-open a previously declined relationship as a fresh request.
          existing.requesterId = requesterId;
          existing.addresseeId = addresseeId;
          existing.status = ConnectionStatus.Pending;
          existing.requestMessage = message ?? null;
          existing.respondedAt = null;
          existing.blockedBy = null;
          const reopened = await this.connections.save(existing);
          this.emitRequested(reopened);
          return reopened;
        }
      }
    }

    const { low, high } = this.pair(requesterId, addresseeId);
    const conn = this.connections.create({
      requesterId,
      addresseeId,
      userLow: low,
      userHigh: high,
      status: ConnectionStatus.Pending,
      requestMessage: message ?? null,
    });
    try {
      const saved = await this.connections.save(conn);
      this.emitRequested(saved);
      return saved;
    } catch (err) {
      // A concurrent request can win the race to the UNIQUE pair; map the
      // constraint violation to a 409 instead of a 500.
      if (
        err instanceof QueryFailedError &&
        (err.driverError as { code?: string })?.code === '23505'
      ) {
        throw new ConflictException('A request is already pending');
      }
      throw err;
    }
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
        conn.status =
          action === 'accept'
            ? ConnectionStatus.Accepted
            : ConnectionStatus.Declined;
        conn.respondedAt = new Date();
        const saved = await this.connections.save(conn);
        if (action === 'accept') {
          // §7: messaging materializes the conversation + seed message on accept.
          this.eventEmitter.emit(CONNECTION_ACCEPTED, {
            connectionId: saved.id,
            requesterId: saved.requesterId,
            addresseeId: saved.addresseeId,
            requestMessage: saved.requestMessage,
          } satisfies ConnectionAcceptedEvent);
        }
        return saved;
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

  async remove(
    connectionId: string,
    actorId: string,
  ): Promise<{ ok: true }> {
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
  ): Promise<ConnectionListItem[]> {
    let rows: Connection[];
    if (tab === 'incoming') {
      rows = await this.connections.find({
        where: { addresseeId: userId, status: ConnectionStatus.Pending },
        order: { createdAt: 'DESC' },
      });
    } else if (tab === 'outgoing') {
      rows = await this.connections.find({
        where: { requesterId: userId, status: ConnectionStatus.Pending },
        order: { createdAt: 'DESC' },
      });
    } else {
      // all + vouched both start from accepted connections the user is in.
      rows = await this.connections.find({
        where: [
          { requesterId: userId, status: ConnectionStatus.Accepted },
          { addresseeId: userId, status: ConnectionStatus.Accepted },
        ],
        order: { respondedAt: 'DESC' },
      });
      if (tab === 'vouched') {
        const given = await this.vouches.find({
          where: { voucherId: userId },
        });
        const vouchedIds = new Set(given.map((v) => v.voucheeId));
        rows = rows.filter((c) =>
          vouchedIds.has(this.otherId(c, userId)),
        );
      }
    }

    const otherIds = rows.map((c) => this.otherId(c, userId));
    const profilesById = await this.profilesByUserIds(otherIds);
    return rows.map((c) =>
      toConnectionListItem(c, userId, profilesById.get(this.otherId(c, userId))),
    );
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
