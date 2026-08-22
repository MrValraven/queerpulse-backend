import { generateKeyPairSync } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { CardTokenService } from './card-token.service';

function makeService() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const config = {
    get: (key: string) =>
      key === 'CARD_SIGNING_PRIVATE_KEY'
        ? privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
        : key === 'CARD_SIGNING_PUBLIC_KEY'
          ? publicKey.export({ type: 'spki', format: 'pem' }).toString()
          : undefined,
  } as unknown as ConfigService;
  return new CardTokenService(config);
}

describe('CardTokenService', () => {
  const cardId = '11111111-1111-1111-1111-111111111111';

  it('round-trips a freshly minted token back to its card id', () => {
    const service = makeService();
    const { token } = service.mint(cardId);
    expect(service.verify(token)).toBe(cardId);
  });

  it('reports an expiry roughly 60 seconds out', () => {
    const service = makeService();
    const { expiresAt } = service.mint(cardId);
    const deltaMs = new Date(expiresAt).getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(50_000);
    expect(deltaMs).toBeLessThanOrEqual(60_000);
  });

  it('rejects a token whose payload was tampered with', () => {
    const service = makeService();
    const { token } = service.mint(cardId);
    const [, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        c: 'other-card',
        e: Math.floor(Date.now() / 1000) + 60,
      }),
    ).toString('base64url');
    expect(service.verify(`${forged}.${signature}`)).toBeNull();
  });

  it('rejects a token signed by a different key', () => {
    const { token } = makeService().mint(cardId);
    expect(makeService().verify(token)).toBeNull();
  });

  it('rejects an expired token', () => {
    const service = makeService();
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
    const { token } = service.mint(cardId);
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000_061_000);
    expect(service.verify(token)).toBeNull();
    jest.restoreAllMocks();
  });

  it('rejects malformed input without throwing', () => {
    const service = makeService();
    expect(service.verify('')).toBeNull();
    expect(service.verify('not-a-token')).toBeNull();
    expect(service.verify('a.b.c')).toBeNull();
    expect(service.verify('!!!.###')).toBeNull();
  });

  it('rejects a non-string token without throwing', () => {
    const service = makeService();
    expect(() => service.verify(undefined as unknown as string)).not.toThrow();
    expect(service.verify(undefined as unknown as string)).toBeNull();
    expect(service.verify(null as unknown as string)).toBeNull();
    expect(service.verify(12345 as unknown as string)).toBeNull();
    expect(service.verify([] as unknown as string)).toBeNull();
  });
});
