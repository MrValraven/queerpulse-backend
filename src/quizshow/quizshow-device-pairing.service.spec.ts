import { HttpException, HttpStatus } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac } from 'node:crypto';
import type * as NodeCrypto from 'node:crypto';
import {
  QUIZSHOW_LIMITS,
  QUIZSHOW_PAIRING_CODE_PATTERN,
} from './quizshow.contract';
import { QuizshowDevicePairingService } from './quizshow-device-pairing.service';
import { quizshowCodeOf } from './quizshow-errors';

// A case can script the digit draws; every other case gets real randomness.
const mockRandomIntScript: { draw: ((bound: number) => number) | null } = {
  draw: null,
};

jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof NodeCrypto>('node:crypto');
  return {
    ...actual,
    randomInt: (bound: number) =>
      mockRandomIntScript.draw === null
        ? actual.randomInt(bound)
        : mockRandomIntScript.draw(bound),
  };
});

const ACCESS_SECRET = 'access-secret-for-the-device-ticket-spec';
const NOW = 1_800_000_000_000;
const SCOPE = { kind: 'event' as const, eventSlug: 'drag-bingo', gameId: null };
const TEN_MINUTES_MS = 10 * 60 * 1000;
const REQUESTER = 'host-1';
// Zeros are outside the code alphabet, so no drawn code can ever collide with it.
const UNUSED_CODE = '000000';
const DEVICE_TICKET_KEY = createHmac('sha256', ACCESS_SECRET)
  .update('quizshow-device-ticket-v1')
  .digest();

function build() {
  const config = { getOrThrow: jest.fn(() => ACCESS_SECRET) };
  const jwt = new JwtService({});
  const service = new QuizshowDevicePairingService(
    jwt,
    config as unknown as ConfigService,
  );
  return { service, jwt };
}

function thrownBy(run: () => unknown): HttpException {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('Expected the call to throw a refusal.');
}

afterEach(() => {
  mockRandomIntScript.draw = null;
});

describe('QuizshowDevicePairingService pairing', () => {
  it('starts with a code, a 43 character poll token and the code lifetime', () => {
    const { service } = build();
    const start = service.startPairing('screen', null, NOW);
    expect(start.pairingCode).toMatch(QUIZSHOW_PAIRING_CODE_PATTERN);
    expect(start.pollToken).toHaveLength(43);
    expect(start.pairingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(start.expiresAt).toBe(NOW + QUIZSHOW_LIMITS.pairingCodeTtlMs);
  });

  it('answers 503 rate limited after 10 draws that all repeat a pending code', () => {
    const { service } = build();
    const { pairingCode } = service.startPairing('screen', null, NOW);
    let drawCount = 0;
    mockRandomIntScript.draw = () => {
      const digit = pairingCode.charAt(drawCount % pairingCode.length);
      drawCount += 1;
      return '23456789'.indexOf(digit);
    };
    const refusal = thrownBy(() => service.startPairing('screen', null, NOW));
    expect(refusal.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(quizshowCodeOf(refusal)).toBe('quizshow_pairing_rate_limited');
    expect(drawCount).toBe(10 * QUIZSHOW_LIMITS.pairingCodeLength);
  });

  it('gives the same 404 for a wrong token, an unknown id and an expired entry', () => {
    const { service } = build();
    const start = service.startPairing('screen', null, NOW);
    const wrongToken = thrownBy(() =>
      service.claimPairing(start.pairingId, 'x'.repeat(43), NOW),
    );
    const unknownId = thrownBy(() =>
      service.claimPairing(
        '00000000-0000-4000-8000-000000000000',
        start.pollToken,
        NOW,
      ),
    );
    const expired = thrownBy(() =>
      service.claimPairing(start.pairingId, start.pollToken, start.expiresAt),
    );
    for (const refusal of [wrongToken, unknownId, expired]) {
      expect(refusal.getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect(quizshowCodeOf(refusal)).toBe('quizshow_pairing_not_found');
    }
  });

  it('answers waiting, then the same ticket on every claim until the code expires, then once more, then 404', () => {
    const { service } = build();
    const start = service.startPairing('screen', null, NOW);
    expect(service.claimPairing(start.pairingId, start.pollToken, NOW)).toEqual(
      { status: 'waiting', expiresAt: start.expiresAt },
    );
    expect(
      service.completePairing(start.pairingId, 'session-1', 'ticket-1', SCOPE),
    ).toBe(true);
    expect(
      service.completePairing(start.pairingId, 'session-2', 'ticket-2', SCOPE),
    ).toBe(false);
    const pairedClaim = {
      status: 'paired',
      deviceTicket: 'ticket-1',
      sessionId: 'session-1',
      kind: 'event',
      eventSlug: 'drag-bingo',
      gameId: null,
    };
    expect(service.claimPairing(start.pairingId, start.pollToken, NOW)).toEqual(
      pairedClaim,
    );
    // A TV whose first paired answer got lost claims again and gets the same ticket.
    expect(
      service.claimPairing(
        start.pairingId,
        start.pollToken,
        start.expiresAt - 1,
      ),
    ).toEqual(pairedClaim);
    expect(
      service.findPendingByCode(
        start.pairingCode,
        REQUESTER,
        start.expiresAt - 1,
      ),
    ).toEqual({ ok: false, code: 'quizshow_pairing_code_used' });
    expect(
      service.claimPairing(start.pairingId, start.pollToken, start.expiresAt),
    ).toEqual(pairedClaim);
    const lateClaim = thrownBy(() =>
      service.claimPairing(start.pairingId, start.pollToken, start.expiresAt),
    );
    expect(quizshowCodeOf(lateClaim)).toBe('quizshow_pairing_not_found');
    expect(
      service.completePairing(start.pairingId, 'session-1', 'ticket-1', SCOPE),
    ).toBe(false);
  });

  it('answers a repeated paired claim with a wrong poll token with the same 404', () => {
    const { service } = build();
    const start = service.startPairing('screen', null, NOW);
    service.completePairing(start.pairingId, 'session-1', 'ticket-1', SCOPE);
    expect(
      service.claimPairing(start.pairingId, start.pollToken, NOW),
    ).toMatchObject({ status: 'paired', deviceTicket: 'ticket-1' });
    const wrongToken = thrownBy(() =>
      service.claimPairing(start.pairingId, 'b'.repeat(43), NOW),
    );
    expect(quizshowCodeOf(wrongToken)).toBe('quizshow_pairing_not_found');
  });

  it('finds a fresh code and names a missing, an expired and a used one', () => {
    const { service } = build();
    const helper = service.startPairing('helper', 'member-1', NOW);
    expect(
      service.findPendingByCode(helper.pairingCode, REQUESTER, NOW),
    ).toEqual({
      ok: true,
      pairing: {
        pairingId: helper.pairingId,
        kind: 'helper',
        starterUserId: 'member-1',
      },
    });
    expect(
      service.findPendingByCode(
        helper.pairingCode,
        REQUESTER,
        helper.expiresAt,
      ),
    ).toEqual({ ok: false, code: 'quizshow_pairing_code_expired' });

    const screen = service.startPairing('screen', 'member-1', NOW);
    expect(
      service.findPendingByCode(screen.pairingCode, REQUESTER, NOW),
    ).toMatchObject({
      ok: true,
      pairing: { kind: 'screen', starterUserId: null },
    });
    service.completePairing(screen.pairingId, 'session-1', 'ticket-1', SCOPE);
    expect(
      service.findPendingByCode(screen.pairingCode, REQUESTER, NOW),
    ).toEqual({
      ok: false,
      code: 'quizshow_pairing_code_used',
    });

    const unusedCode =
      ['222222', '333333'].find(
        (code) => code !== helper.pairingCode && code !== screen.pairingCode,
      ) ?? '444444';
    expect(service.findPendingByCode(unusedCode, REQUESTER, NOW)).toEqual({
      ok: false,
      code: 'quizshow_pairing_code_not_found',
    });
  });

  it('keeps an expired entry for 10 minutes, then sweeps it', () => {
    const { service } = build();
    const start = service.startPairing('screen', null, NOW);
    service.sweepExpired(start.expiresAt + TEN_MINUTES_MS - 1);
    expect(
      service.findPendingByCode(start.pairingCode, REQUESTER, start.expiresAt),
    ).toEqual({ ok: false, code: 'quizshow_pairing_code_expired' });
    service.sweepExpired(start.expiresAt + TEN_MINUTES_MS);
    expect(
      service.findPendingByCode(start.pairingCode, REQUESTER, start.expiresAt),
    ).toEqual({ ok: false, code: 'quizshow_pairing_code_not_found' });
  });

  it('refuses the lookup once a requester holds 10 misses in the window', () => {
    const { service } = build();
    const fresh = service.startPairing('screen', null, NOW);
    for (let miss = 0; miss < 10; miss += 1) {
      expect(service.findPendingByCode(UNUSED_CODE, REQUESTER, NOW)).toEqual({
        ok: false,
        code: 'quizshow_pairing_code_not_found',
      });
    }
    expect(
      service.findPendingByCode(fresh.pairingCode, REQUESTER, NOW),
    ).toEqual({ ok: false, code: 'quizshow_pairing_too_many_tries' });
    expect(
      service.findPendingByCode(fresh.pairingCode, 'host-2', NOW),
    ).toMatchObject({ ok: true });
  });

  it('counts used and expired codes as misses and keeps the count after a find', () => {
    const { service } = build();
    const used = service.startPairing('screen', null, NOW);
    service.completePairing(used.pairingId, 'session-1', 'ticket-1', SCOPE);
    const expiring = service.startPairing('screen', null, NOW);
    const fresh = service.startPairing('screen', null, NOW);
    const later = expiring.expiresAt;
    for (let miss = 0; miss < 4; miss += 1) {
      service.findPendingByCode(used.pairingCode, REQUESTER, later);
      service.findPendingByCode(expiring.pairingCode, REQUESTER, later);
    }
    service.findPendingByCode(UNUSED_CODE, REQUESTER, later);
    const freshAgain = service.startPairing('screen', null, later);
    expect(
      service.findPendingByCode(freshAgain.pairingCode, REQUESTER, later),
    ).toMatchObject({ ok: true });
    expect(
      service.findPendingByCode(fresh.pairingCode, REQUESTER, later),
    ).toEqual({ ok: false, code: 'quizshow_pairing_code_expired' });
    expect(
      service.findPendingByCode(freshAgain.pairingCode, REQUESTER, later),
    ).toEqual({ ok: false, code: 'quizshow_pairing_too_many_tries' });
  });

  it('stops counting misses older than the window', () => {
    const { service } = build();
    for (let miss = 0; miss < 10; miss += 1) {
      service.findPendingByCode(UNUSED_CODE, REQUESTER, NOW);
    }
    expect(
      service.findPendingByCode(
        UNUSED_CODE,
        REQUESTER,
        NOW + TEN_MINUTES_MS - 1,
      ),
    ).toEqual({ ok: false, code: 'quizshow_pairing_too_many_tries' });
    service.sweepExpired(NOW + TEN_MINUTES_MS);
    expect(
      service.findPendingByCode(UNUSED_CODE, REQUESTER, NOW + TEN_MINUTES_MS),
    ).toEqual({ ok: false, code: 'quizshow_pairing_code_not_found' });
  });

  it('sweeps on an unref interval and clears it on shutdown', () => {
    const { service } = build();
    const unref = jest.fn();
    const fakeTimer = { unref } as unknown as NodeJS.Timeout;
    const setSpy = jest
      .spyOn(global, 'setInterval')
      .mockImplementation(() => fakeTimer);
    const clearSpy = jest
      .spyOn(global, 'clearInterval')
      .mockImplementation(() => undefined);
    service.onModuleInit();
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 60 * 1000);
    expect(unref).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
    expect(clearSpy).toHaveBeenCalledWith(fakeTimer);
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });
});

describe('QuizshowDevicePairingService tickets', () => {
  const ticketInput = {
    sessionId: 'session-1',
    pairingId: 'pairing-1',
    kind: 'helper' as const,
    helperUserId: 'member-1',
    now: NOW,
  };

  it('verifies its own ticket with the contract claims', () => {
    const { service } = build();
    const ticket = service.mintDeviceTicket(ticketInput);
    const issuedAtSeconds = NOW / 1000;
    expect(service.verifyDeviceTicket(ticket, NOW)).toEqual({
      typ: 'quizshow_device',
      sid: 'session-1',
      pid: 'pairing-1',
      kind: 'helper',
      uid: 'member-1',
      iat: issuedAtSeconds,
      exp: issuedAtSeconds + QUIZSHOW_LIMITS.deviceTicketTtlMs / 1000,
    });
  });

  it('leaves uid off a screen ticket', () => {
    const { service } = build();
    const ticket = service.mintDeviceTicket({
      ...ticketInput,
      kind: 'screen',
      helperUserId: null,
    });
    const claims = service.verifyDeviceTicket(ticket, NOW);
    expect(claims?.kind).toBe('screen');
    expect(claims).not.toHaveProperty('uid');
  });

  it('refuses a ticket signed with the raw access secret', () => {
    const { service, jwt } = build();
    const issuedAtSeconds = NOW / 1000;
    const forged = jwt.sign(
      {
        typ: 'quizshow_device',
        sid: 'session-1',
        pid: 'pairing-1',
        kind: 'screen',
        iat: issuedAtSeconds,
        exp: issuedAtSeconds + 3600,
      },
      { secret: ACCESS_SECRET, algorithm: 'HS256' },
    );
    expect(service.verifyDeviceTicket(forged, NOW)).toBeNull();
  });

  it('refuses to mint a helper ticket without the helper user id', () => {
    const { service } = build();
    expect(() =>
      service.mintDeviceTicket({ ...ticketInput, helperUserId: null }),
    ).toThrow();
  });

  it('refuses a screen ticket with a uid and a helper ticket without one', () => {
    const { service, jwt } = build();
    const issuedAtSeconds = NOW / 1000;
    const baseClaims = {
      typ: 'quizshow_device',
      sid: 'session-1',
      pid: 'pairing-1',
      iat: issuedAtSeconds,
      exp: issuedAtSeconds + 3600,
    };
    const screenWithUid = jwt.sign(
      { ...baseClaims, kind: 'screen', uid: 'member-1' },
      { secret: DEVICE_TICKET_KEY, algorithm: 'HS256' },
    );
    const helperWithoutUid = jwt.sign(
      { ...baseClaims, kind: 'helper' },
      { secret: DEVICE_TICKET_KEY, algorithm: 'HS256' },
    );
    expect(service.verifyDeviceTicket(screenWithUid, NOW)).toBeNull();
    expect(service.verifyDeviceTicket(helperWithoutUid, NOW)).toBeNull();
  });

  it('refuses a token signed with the device key and another typ', () => {
    const { service, jwt } = build();
    const issuedAtSeconds = NOW / 1000;
    const wrongType = jwt.sign(
      {
        typ: 'access',
        sid: 'session-1',
        pid: 'pairing-1',
        kind: 'screen',
        iat: issuedAtSeconds,
        exp: issuedAtSeconds + 3600,
      },
      { secret: DEVICE_TICKET_KEY, algorithm: 'HS256' },
    );
    expect(service.verifyDeviceTicket(wrongType, NOW)).toBeNull();
  });

  it('refuses an expired ticket', () => {
    const { service } = build();
    const ticket = service.mintDeviceTicket(ticketInput);
    expect(
      service.verifyDeviceTicket(
        ticket,
        NOW + QUIZSHOW_LIMITS.deviceTicketTtlMs,
      ),
    ).toBeNull();
  });

  it('refuses an access token', () => {
    const { service, jwt } = build();
    const accessToken = jwt.sign(
      { sub: 'member-1', status: 'active' },
      { secret: ACCESS_SECRET, algorithm: 'HS256', expiresIn: '15m' },
    );
    expect(service.verifyDeviceTicket(accessToken, Date.now())).toBeNull();
  });

  it('refuses garbage', () => {
    const { service } = build();
    expect(service.verifyDeviceTicket('not-a-ticket', NOW)).toBeNull();
  });
});
