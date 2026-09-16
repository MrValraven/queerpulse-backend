// Importing chat.gateway.ts pulls in the `cookie` package at module scope
// (`import { parseCookie } from 'cookie'`), which is ESM-only and ts-jest
// cannot load. Same module mock chat.gateway.spec.ts and
// chat.gateway.delivered.spec.ts use; these tests never read a cookie.
jest.mock('cookie', () => ({ parseCookie: jest.fn(() => ({})) }));

import * as fs from 'fs';
import * as path from 'path';
import { GATEWAY_OPTIONS } from '@nestjs/websockets/constants';
import { ChatGateway } from './chat.gateway';
import {
  DEFAULT_FRONTEND_ORIGIN,
  resolveAllowedOrigins,
} from '../config/frontend-origins';

type HandshakeHeaders = Record<string, string | string[] | undefined>;
type AllowRequestCallback = (err: string | null, allow: boolean) => void;
type AllowRequest = (
  req: { headers: HandshakeHeaders },
  cb: AllowRequestCallback,
) => void;

interface GatewayOptionsWithOriginGate {
  allowRequest?: AllowRequest;
}

/**
 * Reads the REAL `allowRequest` handshake gate off `ChatGateway`'s own
 * `@WebSocketGateway` decorator metadata, the same way
 * `chat.gateway.spec.ts`'s `gatewayPipe()` reads the gateway's validation
 * pipe off `PIPES_METADATA`. `allowHandshakeOrigin` is a module-private
 * function in `chat.gateway.ts` (not exported), so this is the only way to
 * exercise the function the gateway actually wires up, rather than a
 * hand-rolled copy of its logic that could drift from the source silently.
 */
function getAllowHandshakeOrigin(): AllowRequest {
  const options = Reflect.getMetadata(
    GATEWAY_OPTIONS,
    ChatGateway,
  ) as GatewayOptionsWithOriginGate;
  const allowRequest = options.allowRequest;
  if (!allowRequest) {
    throw new Error('ChatGateway declares no allowRequest handshake gate');
  }
  return allowRequest;
}

/** Runs the real handshake gate against a single Origin header value. */
function checkOrigin(origin: string | undefined): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const headers: HandshakeHeaders = {};
    if (origin !== undefined) {
      headers.origin = origin;
    }
    getAllowHandshakeOrigin()({ headers }, (err, allow) => {
      if (err) {
        reject(new Error(err));
        return;
      }
      resolve(allow);
    });
  });
}

const ORIGIN_ENV_KEYS = ['FRONTEND_URL', 'NODE_ENV'] as const;

describe('chat gateway handshake origin gate (allowHandshakeOrigin, ENG-261/ENG-268)', () => {
  const originalValues: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ORIGIN_ENV_KEYS) {
      originalValues[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ORIGIN_ENV_KEYS) {
      const original = originalValues[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  describe('in production (no DEFAULT_FRONTEND_ORIGIN union)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      process.env.FRONTEND_URL = 'https://queerpulse.com';
    });

    it('accepts the exact configured origin', async () => {
      await expect(checkOrigin('https://queerpulse.com')).resolves.toBe(true);
    });

    it('rejects an origin outside the allowlist', async () => {
      await expect(checkOrigin('https://evil.example')).resolves.toBe(false);
    });

    it('rejects the same host on a different scheme (http instead of https)', async () => {
      await expect(checkOrigin('http://queerpulse.com')).resolves.toBe(false);
    });

    it('rejects the same host with an explicit port the allowlist never declared', async () => {
      await expect(checkOrigin('https://queerpulse.com:8443')).resolves.toBe(
        false,
      );
    });

    it('accepts the handshake when the Origin header is absent entirely', async () => {
      // Documented behaviour: non-browser clients (native apps, tests) send
      // no Origin at all, and they sit outside the CSWSH threat model.
      await expect(checkOrigin(undefined)).resolves.toBe(true);
    });

    it('rejects the dev-server origin unless it was itself configured', async () => {
      await expect(checkOrigin(DEFAULT_FRONTEND_ORIGIN)).resolves.toBe(false);
    });
  });

  describe('outside production (the ENG-261 union with DEFAULT_FRONTEND_ORIGIN)', () => {
    beforeEach(() => {
      delete process.env.NODE_ENV;
      process.env.FRONTEND_URL = 'https://staging.queerpulse.com';
    });

    it('still accepts the configured origin', async () => {
      await expect(checkOrigin('https://staging.queerpulse.com')).resolves.toBe(
        true,
      );
    });

    it('also accepts the dev-server origin even though FRONTEND_URL points elsewhere', async () => {
      await expect(checkOrigin(DEFAULT_FRONTEND_ORIGIN)).resolves.toBe(true);
    });

    it('still rejects an origin that is neither configured nor the dev-server default', async () => {
      await expect(checkOrigin('https://evil.example')).resolves.toBe(false);
    });
  });
});

// `resolveAllowedOrigins` itself has no test coverage in
// `src/config/frontend-origins.spec.ts` (confirmed by reading that file in
// full before writing this one): it only exercises `parseFrontendOrigins`,
// `resolveFrontendOrigins` and `invalidFrontendOrigins`. Covered here instead,
// since the coordinator asked for this file not to be created or edited by
// this task (another session already owns it) and the origin-gate spec is the
// function's other direct caller.
describe('resolveAllowedOrigins (gap: uncovered by src/config/frontend-origins.spec.ts)', () => {
  const originalValues: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ORIGIN_ENV_KEYS) {
      originalValues[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ORIGIN_ENV_KEYS) {
      const original = originalValues[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  it('in production, returns exactly the configured FRONTEND_URL list, in order', () => {
    process.env.NODE_ENV = 'production';
    process.env.FRONTEND_URL =
      'https://queerpulse.com,https://www.queerpulse.com';
    expect(resolveAllowedOrigins()).toEqual([
      'https://queerpulse.com',
      'https://www.queerpulse.com',
    ]);
  });

  it('in production, leaves DEFAULT_FRONTEND_ORIGIN out unless it is configured', () => {
    process.env.NODE_ENV = 'production';
    process.env.FRONTEND_URL = 'https://queerpulse.com';
    expect(resolveAllowedOrigins()).not.toContain(DEFAULT_FRONTEND_ORIGIN);
  });

  it('outside production, unions in DEFAULT_FRONTEND_ORIGIN alongside the configured list', () => {
    delete process.env.NODE_ENV;
    process.env.FRONTEND_URL = 'https://staging.queerpulse.com';
    expect(resolveAllowedOrigins()).toEqual([
      'https://staging.queerpulse.com',
      DEFAULT_FRONTEND_ORIGIN,
    ]);
  });

  it('outside production, does not duplicate DEFAULT_FRONTEND_ORIGIN when it is already configured', () => {
    delete process.env.NODE_ENV;
    process.env.FRONTEND_URL = DEFAULT_FRONTEND_ORIGIN;
    expect(resolveAllowedOrigins()).toEqual([DEFAULT_FRONTEND_ORIGIN]);
  });

  it('outside production with FRONTEND_URL unset, returns only the single dev-server default', () => {
    delete process.env.NODE_ENV;
    delete process.env.FRONTEND_URL;
    expect(resolveAllowedOrigins()).toEqual([DEFAULT_FRONTEND_ORIGIN]);
  });
});

// The gateway's `allowRequest` reads the SAME function main.ts's HTTP CORS
// reads (see both files' own comments, ENG-261), so a browser allowed to call
// the API is always allowed to open a socket to it. Asserting that at runtime
// would mean booting main.ts's full Nest application, which GLOBAL-RULES
// forbids here (no `pnpm build`/app bootstrap in a unit spec) and which the
// brief says to skip in that case. This instead statically confirms both call
// sites are wired to `resolveAllowedOrigins`, source-text only, no app boot.
describe('HTTP CORS and the WS origin gate read the same allowlist function (static check, no app boot)', () => {
  it('main.ts resolves its CORS allowlist through resolveAllowedOrigins', () => {
    const mainSource = fs.readFileSync(
      path.join(__dirname, '..', 'main.ts'),
      'utf8',
    );
    expect(mainSource).toMatch(
      /import\s*\{[^}]*resolveAllowedOrigins[^}]*\}\s*from\s*'\.\/config\/frontend-origins'/,
    );
    expect(mainSource).toMatch(/resolveAllowedOrigins\(\)/);
  });

  it('chat.gateway.ts resolves the handshake allowlist through the same resolveAllowedOrigins', () => {
    const gatewaySource = fs.readFileSync(
      path.join(__dirname, 'chat.gateway.ts'),
      'utf8',
    );
    expect(gatewaySource).toMatch(
      /import\s*\{[^}]*resolveAllowedOrigins[^}]*\}\s*from\s*'\.\.\/config\/frontend-origins'/,
    );
    expect(gatewaySource).toMatch(/allowRequest\s*:\s*allowHandshakeOrigin/);
    expect(gatewaySource).toMatch(/resolveAllowedOrigins\(\)\.includes\(/);
  });
});
