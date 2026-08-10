// MUST be first: initializes Sentry before express/pg are imported, so its
// auto-instrumentation can patch them. See ./instrument.ts.
import './instrument';

import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as Sentry from '@sentry/node';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { VALIDATION_PIPE_OPTIONS } from './common/validation-pipe.options';
import { DEFAULT_FRONTEND_ORIGIN } from './config/frontend-origins';

// How long to let Sentry drain its buffer on shutdown before giving up.
const SENTRY_FLUSH_TIMEOUT_MS = 2000;

async function bootstrap() {
  const isProd = process.env.NODE_ENV === 'production';

  // rawBody: exposes req.rawBody for HMAC-verified webhooks (Mux).
  // bufferLogs: hold startup logs until the pino logger is attached.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const configService = app.get(ConfigService);

  // Trust the first proxy hop so req.ip reflects the client rather than the load
  // balancer — this is what keys the throttler. (Cookie `secure` is NOT derived
  // from this; it comes from NODE_ENV, which is more robust than trusting a
  // forwarded header.)
  app.set('trust proxy', 1);

  // Security middleware before routes. helmet's defaults are configured
  // explicitly here rather than relied on implicitly:
  //  - HSTS: pin browsers to HTTPS for 2 years, cover subdomains, and mark the
  //    origin preload-eligible. Behind the TLS-terminating proxy this is only
  //    emitted on secure requests, which is the correct behavior.
  //  - referrerPolicy: `no-referrer` — a JSON API never needs to leak the
  //    requesting URL to a third party, so send no Referer at all.
  //  - crossOriginResourcePolicy: `same-site` — helmet's default is
  //    `same-origin`, which blocks the SPA (queerpulse.com) from embedding
  //    `/files/*` images served from the API's own subdomain
  //    (api.queerpulse.com) with `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`,
  //    since those are same-SITE but cross-ORIGIN. `GET /files/*`
  //    (files.controller.ts) is built for same-site embedding — the SameSite=Lax
  //    session cookie already requires it — so `same-site` matches that posture
  //    exactly: same-registrable-domain embedding works, genuinely cross-site
  //    embedding stays blocked. Server-side link unfurlers are unaffected (CORP
  //    is a browser-only subresource protection).
  // CORS is configured separately below; helmet does not touch it.
  app.use(cookieParser());
  app.use(
    helmet({
      hsts: {
        maxAge: 63072000, // 2 years, in seconds
        includeSubDomains: true,
        preload: true,
      },
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // FRONTEND_URL is a comma-separated allowlist parsed by app.config via
  // src/config/frontend-origins.ts — the same parser the chat gateway's CORS
  // callback uses, so HTTP and socket.io can never disagree about who's allowed.
  const frontendOrigins = configService.get<string[]>('app.frontendOrigins', [
    DEFAULT_FRONTEND_ORIGIN,
  ]);
  // Only trust the localhost dev origin outside production.
  const origins = isProd
    ? frontendOrigins
    : Array.from(new Set([...frontendOrigins, DEFAULT_FRONTEND_ORIGIN]));
  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  });

  app.useGlobalPipes(
    // See VALIDATION_PIPE_OPTIONS — `exposeUnsetFields: false` is load-bearing
    // (a partial-update DTO must not clobber hydrated columns with `undefined`).
    new ValidationPipe(VALIDATION_PIPE_OPTIONS),
  );

  // URI-based API versioning: every route answers at `/v1/...` by default. This
  // is non-breaking because the frontend prepends the same `/v1` prefix in its
  // request builder (src/shared/api/client.ts). Controllers whose paths are
  // referenced by EXTERNAL systems that cannot be updated in lockstep (the
  // Railway healthcheck, the Google OAuth callback, the `/auth/refresh` the SPA
  // hits directly, the `/csrf-token` bootstrap, and the Mux webhook URL) opt out
  // with `@Controller({ version: VERSION_NEUTRAL })` so they keep responding at
  // their current, unversioned paths.
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  // Interactive API docs at /docs. Enabled in every NON-production environment;
  // NEVER in production, regardless of ENABLE_SWAGGER — a public, machine-readable
  // map of every route and DTO is an attacker aid and must not be reachable in
  // prod even by misconfiguration. ENABLE_SWAGGER can still turn docs OFF in a
  // non-prod deploy (e.g. a shared staging box); leaving it unset keeps the
  // developer default of docs-on.
  if (!isProd && process.env.ENABLE_SWAGGER !== 'false') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('QueerPulse API')
      .setDescription(
        'QueerPulse backend API. Versioned endpoints live under the `/v1` prefix; ' +
          'a handful of externally-referenced routes (health, csrf-token, auth, Mux ' +
          'webhook) are version-neutral and answer at their unprefixed paths.',
      )
      .setVersion('1.0.0')
      // Session auth is a JWT carried in the httpOnly `access_token` cookie, so
      // the documented scheme is cookie auth (not a bearer header).
      .addCookieAuth('access_token')
      // Point "Try it out" at the versioned prefix so requests hit `/v1/...`.
      // Version-neutral routes are reachable by editing the path in the UI.
      .addServer('/v1')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
  }

  app.enableShutdownHooks();

  // Drain Sentry's transport buffer before the process exits. Without this, the
  // errors captured in the seconds before a SIGTERM are dropped — exactly the
  // ones from a bad rollout, which is when a restart policy is cycling and you
  // most need to see them.
  if (configService.get<string>('app.sentryDsn')) {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        void Sentry.close(SENTRY_FLUSH_TIMEOUT_MS).then(() => process.exit(0));
      });
    }
  }

  const port = configService.get<number>('app.port') ?? 3000;
  await app.listen(port);
}

void bootstrap();
