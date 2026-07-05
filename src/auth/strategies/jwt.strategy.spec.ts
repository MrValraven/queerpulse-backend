import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessTokenPayload, JwtStrategy } from './jwt.strategy';

function makeStrategy(): JwtStrategy {
  const config = { getOrThrow: jest.fn().mockReturnValue('access-secret') };
  return new JwtStrategy(config as unknown as ConfigService);
}

describe('JwtStrategy.validate', () => {
  const strategy = makeStrategy();
  const full: AccessTokenPayload = {
    sub: 'u1',
    email: 'a@b.c',
    status: 'active',
    role: 'member',
  };

  it('maps a complete access payload onto the request user', () => {
    expect(strategy.validate(full)).toEqual({
      userId: 'u1',
      email: 'a@b.c',
      status: 'active',
      role: 'member',
    });
  });

  it.each(['sub', 'email', 'status', 'role'] as const)(
    'rejects a payload missing %s (access/refresh confusion defense)',
    (missing) => {
      const payload = { ...full } as Record<string, unknown>;
      delete payload[missing];
      expect(() =>
        strategy.validate(payload as unknown as AccessTokenPayload),
      ).toThrow(UnauthorizedException);
    },
  );

  it('rejects a bare refresh-style payload (only sub)', () => {
    expect(() =>
      strategy.validate({ sub: 'u1' } as unknown as AccessTokenPayload),
    ).toThrow(UnauthorizedException);
  });
});
