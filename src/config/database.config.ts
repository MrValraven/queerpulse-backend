import { registerAs } from '@nestjs/config';

export default registerAs('database', () => ({
  url: process.env.DATABASE_URL,
  // synchronize is NEVER true — schema is owned by migrations.
  synchronize: false as const,
  ssl: process.env.NODE_ENV === 'production',
}));
