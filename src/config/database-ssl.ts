import { readFileSync } from 'node:fs';

/**
 * Postgres TLS resolution, shared by the two things that open connections:
 *
 *   - the running app      (`src/database/database.module.ts`)
 *   - the migration CLI    (`src/data-source.ts`, via `migration:run:prod`)
 *
 * These MUST agree. When they didn't, `preDeployCommand` migrated over a
 * plaintext connection and reported success, then the app failed to negotiate
 * TLS and crash-looped — a green deploy step followed by an unexplained restart
 * loop. Both now call `resolvePostgresSsl()`.
 */

export type PostgresSslOptions = boolean | Record<string, unknown>;

/**
 * Whether to negotiate TLS at all.
 *
 * `DATABASE_SSL` (true/false) is the explicit operator override — set it when
 * TLS terminates at a sidecar/proxy, or for a plaintext Postgres reached over a
 * trusted private network. Without it, TLS defaults ON in production.
 */
export function isPostgresSslEnabled(nodeEnv = process.env.NODE_ENV): boolean {
  const explicit = process.env.DATABASE_SSL;
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return nodeEnv === 'production';
}

/**
 * Resolve the `pg` TLS options.
 *
 * When TLS is on, certificate verification is ON by default — the secure
 * posture. Supply a CA bundle via `DATABASE_SSL_CA` (inline PEM or a file path)
 * to verify against a private CA. `DATABASE_SSL_INSECURE=true` keeps the
 * encrypted channel but skips certificate verification.
 *
 * On `DATABASE_SSL_INSECURE`: it is the correct setting for a managed Postgres
 * that presents a self-signed certificate and is only reachable over the
 * provider's own network (Railway's public proxy is exactly this). It trades
 * away MITM protection, so prefer `DATABASE_SSL_CA` when the provider publishes
 * a CA, or `DATABASE_SSL=false` when you are on a trusted private network and
 * the server speaks plaintext anyway. See README "Deployment".
 */
export function resolvePostgresSsl(
  sslEnabled = isPostgresSslEnabled(),
): PostgresSslOptions {
  if (!sslEnabled) {
    return false;
  }

  if (process.env.DATABASE_SSL_INSECURE === 'true') {
    return { rejectUnauthorized: false };
  }

  const ssl: Record<string, unknown> = { rejectUnauthorized: true };
  const ca = process.env.DATABASE_SSL_CA;
  if (ca) {
    ssl.ca = ca.includes('BEGIN CERTIFICATE') ? ca : readFileSync(ca, 'utf8');
  }
  return ssl;
}
