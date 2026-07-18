import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '../../users/entities/user.entity';
import { AccessTokenPayload, JwtStrategy } from './jwt.strategy';

// The DB row backing the token. Defaults to a live user whose status/role match
// the token claims, so a test that cares about neither can ignore it.
function makeStrategy(
  dbUser: Partial<User> | null = {
    id: 'u1',
    email: 'a@b.c',
    status: UserStatus.Active,
    role: UserRole.Member,
  },
): { strategy: JwtStrategy; findOne: jest.Mock } {
  const config = { getOrThrow: jest.fn().mockReturnValue('access-secret') };
  const findOne = jest.fn().mockResolvedValue(dbUser);
  const users = { findOne } as unknown as Repository<User>;
  return {
    strategy: new JwtStrategy(config as unknown as ConfigService, users),
    findOne,
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
});
