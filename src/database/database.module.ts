import { readFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

/** Parse an optional integer env var, falling back to a default. */
function intEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Whether to negotiate TLS with Postgres. `DATABASE_SSL` (true/false) is an
 * explicit override for operators — e.g. disable it when TLS terminates at a
 * sidecar/proxy or for a plaintext local Postgres. Without it, TLS follows the
 * `database.ssl` default (on in production).
 */
function isSslEnabled(config: ConfigService): boolean {
  const explicit = process.env.DATABASE_SSL;
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return Boolean(config.get<boolean>('database.ssl'));
}

/**
 * Resolve the Postgres TLS options.
 *
 * SSL is enabled whenever `database.ssl` is true (production by default). When
 * enabled, certificate verification is ON by default (`rejectUnauthorized:
 * true`) — the secure posture. A CA bundle can be supplied via
 * `DATABASE_SSL_CA` (inline PEM or a file path). Verification is only disabled
 * when the operator explicitly opts in with `DATABASE_SSL_INSECURE=true`, which
 * should be reserved for local/self-signed setups.
 */
function resolveSsl(sslEnabled: boolean): boolean | Record<string, unknown> {
  if (!sslEnabled) {
    return false;
  }

  if (process.env.DATABASE_SSL_INSECURE === 'true') {
    // Explicit, documented opt-out of cert verification. Never for production.
    return { rejectUnauthorized: false };
  }

  const ssl: Record<string, unknown> = { rejectUnauthorized: true };
  const ca = process.env.DATABASE_SSL_CA;
  if (ca) {
    ssl.ca = ca.includes('BEGIN CERTIFICATE') ? ca : readFileSync(ca, 'utf8');
  }
  return ssl;
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('database.url'),
        autoLoadEntities: true,
        synchronize: false,
        // Reject an undefined value in a `where` clause instead of silently
        // dropping the predicate (which would match/mutate an unintended row).
        invalidWhereValuesBehavior: { undefined: 'throw' },
        namingStrategy: new SnakeNamingStrategy(),
        ssl: resolveSsl(isSslEnabled(config)),
        migrations: ['dist/migrations/*.js'],
        // pg pool + timeout tuning. Driven by env with production-safe defaults;
        // keeps a runaway query or a saturated pool from taking the app down.
        extra: {
          max: intEnv(process.env.DATABASE_POOL_MAX, 10),
          min: intEnv(process.env.DATABASE_POOL_MIN, 0),
          connectionTimeoutMillis: intEnv(
            process.env.DATABASE_CONNECTION_TIMEOUT_MS,
            10_000,
          ),
          idleTimeoutMillis: intEnv(
            process.env.DATABASE_IDLE_TIMEOUT_MS,
            30_000,
          ),
          statement_timeout: intEnv(
            process.env.DATABASE_STATEMENT_TIMEOUT_MS,
            30_000,
          ),
        },
      }),
    }),
  ],
})
export class DatabaseModule {}
