import { registerAs } from '@nestjs/config';
import { parseFrontendOrigins } from './frontend-origins';

export default registerAs('app', () => {
  // FRONTEND_URL is a comma-separated allowlist; see ./frontend-origins.ts.
  const frontendOrigins = parseFrontendOrigins(process.env.FRONTEND_URL);
  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: parseInt(process.env.PORT ?? '3000', 10),
    /** Every origin allowed to call the API (HTTP CORS + socket.io handshake). */
    frontendOrigins,
    /**
     * The canonical origin — the FIRST allowlist entry. Consumers that need one
     * unambiguous origin (OAuth redirects, Mux playback URLs) use this: the API
     * can accept requests from apex + www + staging, but it can only redirect a
     * member to one of them. With a single FRONTEND_URL this is unchanged.
     */
    frontendUrl: frontendOrigins[0],
    vouchThreshold: parseInt(process.env.VOUCH_THRESHOLD ?? '2', 10),
    inviteMonthlyQuota: parseInt(process.env.INVITE_MONTHLY_QUOTA ?? '1', 10),
  };
});
