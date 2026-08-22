import { generateKeyPairSync } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { CardTokenService, MAX_CODE_VERSION } from './card-token.service';

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

  it('mints the same token for the same card and code version', () => {
    const service = makeService();
    expect(service.mint(cardId, 1)).toBe(service.mint(cardId, 1));
  });

  it('mints a different token once the code version moves', () => {
    const service = makeService();
    expect(service.mint(cardId, 1)).not.toBe(service.mint(cardId, 2));
  });

  it('round-trips a token back to its card id and code version', () => {
    const service = makeService();
    expect(service.verify(service.mint(cardId, 7))).toEqual({
      cardId,
      codeVersion: 7,
    });
  });

  it('never expires', () => {
    const service = makeService();
    const token = service.mint(cardId, 1);
    jest.useFakeTimers().setSystemTime(new Date('2099-01-01T00:00:00Z'));
    expect(service.verify(token)).toEqual({ cardId, codeVersion: 1 });
    jest.useRealTimers();
  });

  it('rejects a token whose payload was tampered with', () => {
    const service = makeService();
    const [, signature] = service.mint(cardId, 1).split('.');
    const forged = Buffer.alloc(18);
    Buffer.from('22222222222222222222222222222222', 'hex').copy(forged, 0);
    forged.writeUInt16BE(1, 16);
    expect(
      service.verify(`${forged.toString('base64url')}.${signature}`),
    ).toBeNull();
  });

  it('rejects a token signed by a different key', () => {
    const token = makeService().mint(cardId, 1);
    expect(makeService().verify(token)).toBeNull();
  });

  it('rejects a payload of the wrong length', () => {
    const service = makeService();
    const [, signature] = service.mint(cardId, 1).split('.');
    const short = Buffer.alloc(8).toString('base64url');
    expect(service.verify(`${short}.${signature}`)).toBeNull();
  });

  it('rejects a signature that is not 64 bytes', () => {
    const service = makeService();
    const [payload] = service.mint(cardId, 1).split('.');
    expect(
      service.verify(`${payload}.${Buffer.alloc(32).toString('base64url')}`),
    ).toBeNull();
  });

  it('rejects a malformed token', () => {
    const service = makeService();
    expect(service.verify('not-a-token')).toBeNull();
    expect(service.verify('')).toBeNull();
  });

  it('refuses to mint for something that is not a UUID', () => {
    const service = makeService();
    expect(() => service.mint('not-a-uuid', 1)).toThrow();
  });

  it('refuses to mint a code version outside the field it fits in', () => {
    const service = makeService();
    expect(() => service.mint(cardId, 0)).toThrow();
    expect(() => service.mint(cardId, MAX_CODE_VERSION + 1)).toThrow();
  });

  it('reports itself unconfigured when no signing keys are set', () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    expect(new CardTokenService(config).isConfigured).toBe(false);
  });
});
