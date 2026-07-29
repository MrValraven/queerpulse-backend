import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import {
  isPostgresSslEnabled,
  resolvePostgresSsl,
} from '../config/database-ssl';
import type { DatabasePoolConfig } from '../config/database.config';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // Pool + timeout tuning is resolved and validated in database.config;
        // getOrThrow because that factory is always loaded — an absence here
        // is a wiring bug, not a runtime condition to paper over with defaults.
        const databasePool =
          config.getOrThrow<DatabasePoolConfig>('database.pool');
        return {
          type: 'postgres' as const,
          url: config.get<string>('database.url'),
          autoLoadEntities: true,
          synchronize: false,
          // Reject an undefined value in a `where` clause instead of silently
          // dropping the predicate (which would match/mutate an unintended row).
          invalidWhereValuesBehavior: { undefined: 'throw' as const },
          namingStrategy: new SnakeNamingStrategy(),
          ssl: resolvePostgresSsl(
            isPostgresSslEnabled(config.get<string>('app.nodeEnv')),
          ),
          extra: {
            max: databasePool.max,
            min: databasePool.min,
            connectionTimeoutMillis: databasePool.connectionTimeoutMillis,
            idleTimeoutMillis: databasePool.idleTimeoutMillis,
            statement_timeout: databasePool.statementTimeoutMillis,
          },
        };
      },
    }),
  ],
})
export class DatabaseModule {}
