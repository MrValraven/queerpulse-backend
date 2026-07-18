import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  isPostgresSslEnabled,
  resolvePostgresSsl,
} from '../config/database-ssl';

/** Parse an optional integer env var, falling back to a default. */
function intEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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
        ssl: resolvePostgresSsl(
          isPostgresSslEnabled(config.get<string>('app.nodeEnv')),
        ),
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
