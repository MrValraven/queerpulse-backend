import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  vouchThreshold: parseInt(process.env.VOUCH_THRESHOLD ?? '2', 10),
  inviteMonthlyQuota: parseInt(process.env.INVITE_MONTHLY_QUOTA ?? '1', 10),
}));
