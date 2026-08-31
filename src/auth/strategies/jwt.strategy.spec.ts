import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '../../users/entities/user.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { AccessTokenPayload, JwtStrategy } from './jwt.strategy';

// The DB row backing the token. Defaults to a live user whose status/role match
// the token claims, so a test that cares about neither can ignore it.
//
// `isSessionLive` defaults to true, which is what an unrevoked session answers.
// A test about session revocation flips it; every other test is unaffected,
// exactly as a legacy token with no `sid` claim is.
function makeStrategy(
  dbUser: Partial<User> | null = {
    id: 'u1',
    email: 'a@b.c',
    status: UserStatus.Active,
    role: UserRole.Member,
  },
  isSessionLive = true,
): { strategy: JwtStrategy; findOne: jest.Mock; sessionExists: jest.Mock } {
  const config = { getOrThrow: jest.fn().mockReturnValue('access-secret') };
  const findOne = jest.fn().mockResolvedValue(dbUser);
  const users = { findOne } as unknown as Repository<User>;
  const sessionExists = jest.fn().mockResolvedValue(isSessionLive);
  const refreshTokens = {
    exists: sessionExists,
  } as unknown as Repository<RefreshToken>;
  return {
    strategy: new JwtStrategy(
      config as unknown as ConfigService,
      users,
      refreshTokens,
    ),
    findOne,
    sessionExists,
  };
}

describe('JwtStrategy.validate', () => {
  const full: AccessTokenPayload = {
    sub: 'u1',
    email: 'a@b.c',
    status: 'active',
    role: 'member',
  };

  it('maps a complete access payload onto the request user', async () => {
    const { strategy } = makeStrategy();
    await expect(strategy.validate(full)).resolves.toEqual({
      userId: 'u1',
      email: 'a@b.c',
      status: 'active',
      role: 'member',
    });
  });

  it.each(['sub', 'email', 'status', 'role'] as const)(
    'rejects a payload missing %s (access/refresh confusion defense)',
    async (missing) => {
      const { strategy } = makeStrategy();
      const payload = { ...full } as Record<string, unknown>;
      delete payload[missing];
      await expect(
        strategy.validate(payload as unknown as AccessTokenPayload),
      ).rejects.toThrow(UnauthorizedException);
    },
  );

  it('rejects a bare refresh-style payload (only sub)', async () => {
    const { strategy } = makeStrategy();
    await expect(
      strategy.validate({ sub: 'u1' } as unknown as AccessTokenPayload),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('does not hit the database for a malformed payload', async () => {
    const { strategy, findOne } = makeStrategy();
    await expect(
      strategy.validate({ sub: 'u1' } as unknown as AccessTokenPayload),
    ).rejects.toThrow(UnauthorizedException);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('rejects a valid token whose user no longer exists', async () => {
    const { strategy } = makeStrategy(null);
    await expect(strategy.validate(full)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  // The point of the per-request lookup: claims are baked in at sign time, so a
  // token minted before a ban would otherwise carry `active` until it expired.
  it('serves live status/role from the DB, not the stale token claims', async () => {
    const { strategy } = makeStrategy({
      id: 'u1',
      email: 'a@b.c',
      status: UserStatus.Suspended,
      // A permanent ban (suspendedUntil === null) never lapses, so the live
      // lookup serves Suspended without triggering the expiry write-back.
      suspendedUntil: null,
      role: UserRole.Member,
    });
    await expect(strategy.validate(full)).resolves.toEqual({
      userId: 'u1',
      email: 'a@b.c',
      status: UserStatus.Suspended,
      role: UserRole.Member,
    });
  });

  it('looks the user up by the token subject', async () => {
    const { strategy, findOne } = makeStrategy();
    await strategy.validate(full);
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u1' } }),
    );
  });

  describe('session liveness (the `sid` claim)', () => {
    const withSession: AccessTokenPayload = { ...full, sid: 'fam-1' };

    it('surfaces the session id on the request user', async () => {
      const { strategy } = makeStrategy();
      await expect(strategy.validate(withSession)).resolves.toEqual(
        expect.objectContaining({ sessionId: 'fam-1' }),
      );
    });

    it('checks the family this token names, live and unexpired', async () => {
      const { strategy, sessionExists } = makeStrategy();
      await strategy.validate(withSession);
      const [options] = sessionExists.mock.calls[0] as [
        {
          where: { familyId: string; revokedAt?: unknown; expiresAt?: unknown };
        },
      ];
      expect(options.where.familyId).toBe('fam-1');
      // Both conditions matter: revocation is "signed out", expiry is the
      // 30-day life running out before the purge job deletes the rows.
      expect(options.where.revokedAt).toBeDefined();
      expect(options.where.expiresAt).toBeDefined();
    });

    // The whole point of the claim. Before it, a device whose session had been
    // revoked kept authenticating every HTTP route for the rest of its access
    // TTL and only its socket was dropped.
    it('rejects a token whose session has been signed out', async () => {
      const { strategy } = makeStrategy(undefined, false);
      await expect(strategy.validate(withSession)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    // Tokens minted before the deploy that added the claim. Rejecting them
    // would sign every member out at deploy time; they age out within one
    // access TTL on their own.
    it('accepts a legacy token with no session id without asking the store', async () => {
      const { strategy, sessionExists } = makeStrategy(undefined, false);
      await expect(strategy.validate(full)).resolves.toEqual(
        expect.objectContaining({ userId: 'u1' }),
      );
      expect(sessionExists).not.toHaveBeenCalled();
    });

    // A claim that can be switched off by sending the wrong type is not a check.
    it('rejects a non-string session id', async () => {
      const { strategy } = makeStrategy();
      await expect(
        strategy.validate({
          ...full,
          sid: 42,
        } as unknown as AccessTokenPayload),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
