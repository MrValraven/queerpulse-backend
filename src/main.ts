// MUST be first: initializes Sentry before express/pg are imported, so its
// auto-instrumentation can patch them. See ./instrument.ts.
import './instrument';

import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as Sentry from '@sentry/node';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
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

  // Security middleware before routes.
  app.use(cookieParser());
  app.use(helmet());

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
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Interactive API docs at /docs (off in production unless explicitly enabled).
  if (!isProd || process.env.ENABLE_SWAGGER === 'true') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('QueerPulse API')
      .setDescription('QueerPulse backend API')
      .setVersion('0.1.0')
      .addCookieAuth('access_token')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
  }

  app.enableShutdownHooks();

  // Drain Sentry's transport buffer before the process exits. Without this, the
  // errors captured in the seconds before a SIGTERM are dropped — exactly the
  // ones from a bad rollout, which is when a restart policy is cycling and you
  // most need to see them.
  if (process.env.SENTRY_DSN) {
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
