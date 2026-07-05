import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { User, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { USER_PROMOTED, UserPromotedEvent } from '../users/user.events';
import {
  USER_SESSION_REVOKED,
  UserSessionRevokedEvent,
} from '../chat/session.events';
import { InvitesService } from '../membership/invites.service';
import { SignupRejectedError } from './errors/signup-rejected.error';
import { RefreshToken } from './entities/refresh-token.entity';

export interface GoogleUserInput {
  googleId: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string | null;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    private readonly dataSource: DataSource,
    private readonly invitesService: InvitesService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async validateOrCreateGoogleUser(
    profile: GoogleUserInput,
    inviteCode?: string,
  ): Promise<User> {
    const existing = await this.usersService.findByGoogleId(profile.googleId);
    if (existing) {
      return existing; // returning member — invite not required
    }
    if (!inviteCode) {
      throw new SignupRejectedError('invite_required');
    }

    const user = await this.dataSource.transaction(async (manager) => {
      const { inviteId, inviterId } =
        await this.invitesService.validateInviteForSignup(
          manager,
          inviteCode,
          profile.email,
        );
      const created = await this.usersService.createGoogleUser(manager, {
        googleId: profile.googleId,
        email: profile.email,
        firstName: profile.firstName,
        lastName: profile.lastName,
        avatarUrl: profile.avatarUrl ?? null,
        status: UserStatus.Active,
        invitedBy: inviterId,
      });
      await this.invitesService.claimInvite(manager, inviteId, created.id);
      return created;
    });

    // Parity with the accept flow: the new member gets the "PromotedToMember"
    // notification via the existing USER_PROMOTED listener.
    this.eventEmitter.emit(USER_PROMOTED, {
      userId: user.id,
    } satisfies UserPromotedEvent);

    return user;
  }

  async issueTokens(user: User, userAgent?: string): Promise<TokenPair> {
    const { accessToken, refreshToken } = await this.issueTokensWithRow(
      user,
      userAgent,
    );
    return { accessToken, refreshToken };
  }

  async rotateRefreshToken(
    rawRefreshToken: string,
    userAgent?: string,
  ): Promise<TokenPair> {
    // 1. Signature/expiry check (throws -> 401).
    try {
      await this.jwtService.verifyAsync(rawRefreshToken, {
        secret: this.configService.getOrThrow<string>('auth.jwtRefreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // 2. Allowlist lookup by sha-256 hash.
    const tokenHash = this.hashToken(rawRefreshToken);
    const row = await this.refreshTokens.findOne({ where: { tokenHash } });
    if (!row) {
      throw new UnauthorizedException('Unknown refresh token');
    }

    // 3. Reuse detection: an already-revoked token presented again = theft.
    if (row.revokedAt) {
      await this.revokeFamily(row.userId, 'reuse-detected', {
        rowId: row.id,
        userAgent,
      });
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Expired refresh token');
    }

    // 4. Load the user fresh (current status/role) before minting a new pair.
    const user = await this.usersService.findById(row.userId);
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }

    // 5. Rotate atomically. The old row's revoke and the new row's insert are a
    //    SINGLE transaction, so there is never a window with two live tokens.
    //    The revoke is a CONDITIONAL claim (`revoked_at IS NULL`, mirroring the
    //    invites.service pattern): if two refresh requests race on the same
    //    token, exactly one wins the claim — the loser sees `affected === 0` and
    //    is treated as reuse (its whole family is revoked).
    const newRowId = randomUUID();
    const outcome = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(RefreshToken);
      const claim = await repo.update(
        { id: row.id, revokedAt: IsNull() },
        { revokedAt: new Date(), replacedBy: newRowId },
      );
      if (claim.affected === 0) {
        // Lost the race (concurrent rotation/reuse). Write nothing here — the
        // transaction commits as a no-op and we revoke the family outside it so
        // that revocation survives instead of being rolled back.
        return { reuse: true as const };
      }
      const tokens = await this.issueTokensWithRow(
        user,
        userAgent,
        newRowId,
        manager,
      );
      return {
        reuse: false as const,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      };
    });

    if (outcome.reuse) {
      await this.revokeFamily(row.userId, 'reuse-detected', {
        rowId: row.id,
        userAgent,
      });
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    return {
      accessToken: outcome.accessToken,
      refreshToken: outcome.refreshToken,
    };
  }

  async revokeRefreshToken(rawRefreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(rawRefreshToken);
    // Look the row up first so we know whose live sockets to drop. A missing or
    // already-revoked token is a no-op (logout is best-effort).
    const row = await this.refreshTokens.findOne({ where: { tokenHash } });
    if (!row || row.revokedAt) {
      return;
    }
    await this.refreshTokens.update(
      { id: row.id, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    // Never log the token itself — only that a revocation happened.
    this.logger.log('Revoked 1 refresh token on logout');
    // Force-disconnect this member's live WebSocket sockets — an open socket
    // otherwise outlives logout (the chat gateway consumes this event).
    this.eventEmitter.emit(USER_SESSION_REVOKED, {
      userId: row.userId,
    } satisfies UserSessionRevokedEvent);
  }

  /** Revoke every live refresh token for a user (logout-all / global sign-out). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.revokeFamily(userId, 'logout-all');
  }

  // --- internals ---

  /**
   * Revoke all of a user's currently-live refresh tokens in one statement and
   * emit a security log line. Used for both explicit logout-all and reuse
   * detection. Logs never include token values/secrets.
   */
  private async revokeFamily(
    userId: string,
    reason: 'reuse-detected' | 'logout-all',
    context: { rowId?: string; userAgent?: string } = {},
  ): Promise<void> {
    const result = await this.refreshTokens.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    this.logger.warn(
      `Refresh token family revoked: reason=${reason} userId=${userId} ` +
        `rowId=${context.rowId ?? 'n/a'} userAgent=${context.userAgent ?? 'n/a'} ` +
        `count=${result.affected ?? 0}`,
    );
    // Drop the member's live sockets too. Covers both logout-all and reuse
    // detection (a compromise signal) — the chat gateway consumes this event.
    this.eventEmitter.emit(USER_SESSION_REVOKED, {
      userId,
    } satisfies UserSessionRevokedEvent);
  }

  private async persistRefreshToken(
    userId: string,
    refreshToken: string,
    userAgent?: string,
    id?: string,
    manager?: EntityManager,
  ): Promise<RefreshToken> {
    const repo = manager
      ? manager.getRepository(RefreshToken)
      : this.refreshTokens;
    const decoded = this.jwtService.decode(refreshToken);
    const row = repo.create({
      // A pre-generated id lets the rotation claim reference `replaced_by`
      // before the new row is inserted, keeping both writes in one transaction.
      ...(id ? { id } : {}),
      userId,
      tokenHash: this.hashToken(refreshToken),
      expiresAt: new Date(decoded.exp * 1000),
      userAgent: userAgent ?? null,
    });
    return repo.save(row);
  }

  // Issue tokens AND return the persisted refresh-row id (for replaced_by linkage).
  private async issueTokensWithRow(
    user: User,
    userAgent?: string,
    rowId?: string,
    manager?: EntityManager,
  ): Promise<TokenPair & { rowId: string }> {
    const accessToken = await this.jwtService.signAsync(
      { sub: user.id, email: user.email, status: user.status, role: user.role },
      {
        secret: this.configService.getOrThrow<string>('auth.jwtAccessSecret'),
        expiresIn: this.configService.get<string>(
          'auth.jwtAccessTtl',
          '15m',
        ) as JwtSignOptions['expiresIn'],
      },
    );
    const refreshToken = await this.jwtService.signAsync(
      // jti guarantees every refresh token is unique even when two are minted
      // for the same user within the same second — otherwise identical payloads
      // would produce identical sha-256 hashes and an ambiguous allowlist lookup.
      { sub: user.id, jti: randomUUID() },
      {
        secret: this.configService.getOrThrow<string>('auth.jwtRefreshSecret'),
        expiresIn: this.configService.get<string>(
          'auth.jwtRefreshTtl',
          '30d',
        ) as JwtSignOptions['expiresIn'],
      },
    );
    const row = await this.persistRefreshToken(
      user.id,
      refreshToken,
      userAgent,
      rowId,
      manager,
    );
    return { accessToken, refreshToken, rowId: row.id };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
