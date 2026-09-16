import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '../users/entities/user.entity';
import { SocketTicketService } from './socket-ticket.service';

const ACCESS_TTL_MS = 15 * 60 * 1000;

describe('SocketTicketService', () => {
  let service: SocketTicketService;

  beforeEach(() => {
    service = new SocketTicketService();
  });

  it('redeems a freshly-minted ticket for the same user it was minted for', () => {
    const { ticket } = service.mint(
      'user-1',
      'family-1',
      UserStatus.Active,
      ACCESS_TTL_MS,
    );

    const record = service.redeem(ticket, 'user-1');

    expect(record).not.toBeNull();
    expect(record?.userId).toBe('user-1');
    expect(record?.sessionId).toBe('family-1');
    expect(record?.status).toBe(UserStatus.Active);
    expect(record?.exp).toBe(Math.floor((Date.now() + ACCESS_TTL_MS) / 1000));
  });

  it('redeems a ticket exactly once: the second attempt with the same ticket fails', () => {
    const { ticket } = service.mint(
      'user-1',
      undefined,
      UserStatus.Active,
      ACCESS_TTL_MS,
    );

    const first = service.redeem(ticket, 'user-1');
    const second = service.redeem(ticket, 'user-1');

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('fails an unknown ticket (never minted)', () => {
    expect(service.redeem('st_does-not-exist', 'user-1')).toBeNull();
  });

  it('fails an expired ticket', () => {
    jest.useFakeTimers();
    try {
      const { ticket, ttlMs } = service.mint(
        'user-1',
        undefined,
        UserStatus.Active,
        ACCESS_TTL_MS,
      );
      jest.advanceTimersByTime(ttlMs + 1);
      expect(service.redeem(ticket, 'user-1')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses a ticket minted for a different user, and still burns it (single-use even on a mismatch)', () => {
    const { ticket } = service.mint(
      'user-a',
      undefined,
      UserStatus.Active,
      ACCESS_TTL_MS,
    );

    // user-b (an attacker, or simply the wrong socket) presents user-a's ticket.
    expect(service.redeem(ticket, 'user-b')).toBeNull();
    // The ticket is spent even though the mismatched attempt failed. A
    // second presentation, even by the correct user, no longer redeems it.
    expect(service.redeem(ticket, 'user-a')).toBeNull();
  });

  it('sweepExpired removes only lapsed entries, leaving live ones redeemable', () => {
    jest.useFakeTimers();
    try {
      // Minted at t=0, TTL 30s, so it lapses at t=30_000.
      service.mint('user-1', undefined, UserStatus.Active, ACCESS_TTL_MS);
      // Advance to t=20_000: `expiring` has not lapsed yet, so THIS mint call's
      // own internal sweep (see `mint`'s doc) finds nothing to remove and both
      // entries coexist. `fresh` is minted here, so it lapses at t=50_000.
      jest.advanceTimersByTime(20_000);
      const fresh = service.mint(
        'user-2',
        undefined,
        UserStatus.Active,
        ACCESS_TTL_MS,
      );
      expect(service.size()).toBe(2);

      // Advance to t=35_000: past `expiring`'s lapse, short of `fresh`'s.
      jest.advanceTimersByTime(15_000);
      service.sweepExpired();

      expect(service.size()).toBe(1);
      expect(service.redeem(fresh.ticket, 'user-2')).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('mint sweeps expired entries as a side effect, keeping the store from growing unbounded', () => {
    jest.useFakeTimers();
    try {
      const first = service.mint(
        'user-1',
        undefined,
        UserStatus.Active,
        ACCESS_TTL_MS,
      );
      jest.advanceTimersByTime(first.ttlMs + 1);
      expect(service.size()).toBe(1);

      service.mint('user-2', undefined, UserStatus.Active, ACCESS_TTL_MS);
      // The stale entry from user-1 was swept before user-2's was inserted.
      expect(service.size()).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * The core cross-cutting security guarantee of the whole design: a minted
   * ticket must be structurally rejected everywhere a real JWT is accepted,
   * both the HTTP bearer/cookie path (`JwtStrategy`, driven by
   * `passport-jwt`'s own `jwt.verify`) and the socket handshake
   * (`ChatGateway.authenticate`/`verifyAccessToken`, which calls
   * `JwtService.verifyAsync` directly). Both of those ultimately call the
   * exact same `jsonwebtoken` verification this test exercises against a
   * REAL `JwtService` (not a mock), so a single demonstration that a ticket
   * can never pass it is a valid proof for both call sites.
   */
  it('a minted ticket is never a valid JWT and cannot pass real JWT verification', async () => {
    const { ticket } = service.mint(
      'user-1',
      undefined,
      UserStatus.Active,
      ACCESS_TTL_MS,
    );
    // A real JWT is exactly three dot-separated segments; a ticket never is.
    expect(ticket.split('.')).toHaveLength(1);

    const jwt = new JwtService({ secret: 'test-access-secret' });
    await expect(
      jwt.verifyAsync(ticket, {
        secret: 'test-access-secret',
        algorithms: ['HS256'],
      }),
    ).rejects.toThrow();
  });
});
