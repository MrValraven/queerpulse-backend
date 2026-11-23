import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { HttpThrottlerGuard } from './http-throttler.guard';

/**
 * PRD-501: the global throttler counts a signed-in request per member and an
 * anonymous one per client IP, so members behind one venue's Wi-Fi each keep
 * their own bucket.
 */

const ACCESS_SECRET = 'access-secret-for-the-throttler-spec';
const MEMBER_ID = '3f2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d';
const CLIENT_IP = '203.0.113.7';
const NOW = new Date('2026-11-23T12:00:00Z');

const signer = new JwtService();

interface TokenOptions {
  secret?: string;
  claims?: Record<string, unknown>;
}

function accessToken(options: TokenOptions = {}): string {
  return signer.sign(
    {
      sub: MEMBER_ID,
      email: 'sam@example.com',
      status: 'active',
      role: 'member',
      ...options.claims,
    },
    { secret: options.secret ?? ACCESS_SECRET, expiresIn: '15m' },
  );
}

type RequestShape = {
  ip: string;
  ips: string[];
  cookies?: Record<string, string>;
};

function request(cookies?: Record<string, string>): RequestShape {
  return { ip: CLIENT_IP, ips: [], cookies };
}

const storage: ThrottlerStorage = {
  increment: jest.fn(),
};

class TestableThrottlerGuard extends HttpThrottlerGuard {
  constructor(config?: ConfigService) {
    super({ throttlers: [] }, storage, new Reflector());
    this.throttlerConfig = config;
  }

  trackerFor(req: RequestShape): Promise<string> {
    return this.getTracker(req);
  }
}

function guardWithConfig(): TestableThrottlerGuard {
  return new TestableThrottlerGuard(
    new ConfigService({ auth: { jwtAccessSecret: ACCESS_SECRET } }),
  );
}

describe('HttpThrottlerGuard tracker (PRD-501)', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('counts a request with a valid access token per member', async () => {
    const guard = guardWithConfig();

    await expect(
      guard.trackerFor(request({ access_token: accessToken() })),
    ).resolves.toBe(`member:${MEMBER_ID}`);
  });

  it('counts an anonymous request per client IP', async () => {
    await expect(guardWithConfig().trackerFor(request())).resolves.toBe(
      CLIENT_IP,
    );
  });

  it('counts a token signed with another secret per client IP', async () => {
    const forged = accessToken({ secret: 'someone-else-secret' });

    await expect(
      guardWithConfig().trackerFor(request({ access_token: forged })),
    ).resolves.toBe(CLIENT_IP);
  });

  it('counts a malformed cookie per client IP', async () => {
    await expect(
      guardWithConfig().trackerFor(request({ access_token: 'not-a-jwt' })),
    ).resolves.toBe(CLIENT_IP);
  });

  it('keeps a token that lapsed minutes ago in the member bucket for the refresh call', async () => {
    const token = accessToken();
    jest.setSystemTime(new Date('2026-11-23T12:45:00Z'));

    await expect(
      guardWithConfig().trackerFor(request({ access_token: token })),
    ).resolves.toBe(`member:${MEMBER_ID}`);
  });

  it('counts a token that lapsed over an hour ago per client IP', async () => {
    const token = accessToken();
    jest.setSystemTime(new Date('2026-11-23T13:30:00Z'));

    await expect(
      guardWithConfig().trackerFor(request({ access_token: token })),
    ).resolves.toBe(CLIENT_IP);
  });

  it('counts a token without an email claim per client IP', async () => {
    const token = accessToken({ claims: { email: undefined } });

    await expect(
      guardWithConfig().trackerFor(request({ access_token: token })),
    ).resolves.toBe(CLIENT_IP);
  });

  it('counts every request per client IP when no config was injected', async () => {
    const guard = new TestableThrottlerGuard();

    await expect(
      guard.trackerFor(request({ access_token: accessToken() })),
    ).resolves.toBe(CLIENT_IP);
  });

  // `main.ts` sets `trust proxy` to 1, so Express already resolves `req.ip` to
  // the client the load balancer saw. The leftmost X-Forwarded-For entry is
  // whatever the client typed, so keying on it would let one client rotate
  // buckets at will.
  it('keys an anonymous request on the address Express resolved behind the proxy', async () => {
    await expect(
      guardWithConfig().trackerFor({
        ip: CLIENT_IP,
        ips: ['198.51.100.9', CLIENT_IP],
      }),
    ).resolves.toBe(CLIENT_IP);
  });
});
