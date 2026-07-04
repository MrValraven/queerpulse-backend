import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, IsNull, Repository } from 'typeorm';
import { User, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { USER_PROMOTED, UserPromotedEvent } from '../users/user.events';
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

    // 3. Reuse detection: a revoked token presented again = theft.
    if (row.revokedAt) {
      await this.refreshTokens.update(
        { userId: row.userId, revokedAt: IsNull() },
        { revokedAt: new Date() },
      );
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Expired refresh token');
    }

    // 4. Rotate: load the user (fresh status/role), issue new pair.
    const user = await this.usersService.findById(row.userId);
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }
    const tokens = await this.issueTokensWithRow(user, userAgent);

    // 5. Revoke the old row and link it to its replacement.
    await this.refreshTokens.update(row.id, {
      revokedAt: new Date(),
      replacedBy: tokens.rowId,
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async revokeRefreshToken(rawRefreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(rawRefreshToken);
    await this.refreshTokens.update(
      { tokenHash, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }

  // --- internals ---

  private async persistRefreshToken(
    userId: string,
    refreshToken: string,
    userAgent?: string,
  ): Promise<RefreshToken> {
    const decoded = this.jwtService.decode(refreshToken);
    const row = this.refreshTokens.create({
      userId,
      tokenHash: this.hashToken(refreshToken),
      expiresAt: new Date(decoded.exp * 1000),
      userAgent: userAgent ?? null,
    });
    return this.refreshTokens.save(row);
  }

  // Issue tokens AND return the persisted refresh-row id (for replaced_by linkage).
  private async issueTokensWithRow(
    user: User,
    userAgent?: string,
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
    );
    return { accessToken, refreshToken, rowId: row.id };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
