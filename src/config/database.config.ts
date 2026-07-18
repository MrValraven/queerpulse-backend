import { registerAs } from '@nestjs/config';

export default registerAs('database', () => ({
  url: process.env.DATABASE_URL,
  // synchronize is NEVER true — schema is owned by migrations.
  synchronize: false as const,
  // TLS is NOT configured here. It lives in src/config/database-ssl.ts, which
  // both the app and the migration CLI import — the CLI has no Nest container,
  // so a ConfigService-only knob could not reach it, and the two drifted apart.
}));
