import { registerAs } from '@nestjs/config';

/**
 * Transactional-email (SMTP) configuration, gated by env exactly like the Mux
 * and Web Push integrations. When neither `SMTP_URL` nor `SMTP_HOST` is set the
 * mailer falls back to a log-only transport (dev/test) that never sends over the
 * network — so nothing is silently dropped, and the moment real SMTP creds are
 * provided the same code path delivers for real. Credentials come from the
 * environment the maintainer sets; none are ever hardcoded here.
 */
export default registerAs('mail', () => ({
  // A full SMTP connection string (`smtp://user:pass@host:port` /
  // `smtps://...`). Takes precedence over the discrete host/port fields.
  smtpUrl: process.env.SMTP_URL,
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined,
  // `true` for implicit TLS (port 465); `false` (default) uses STARTTLS.
  secure: process.env.SMTP_SECURE === 'true',
  user: process.env.SMTP_USER,
  password: process.env.SMTP_PASSWORD,
  // The From header on every message (e.g. `QueerPulse <hello@queerpulse.org>`).
  from: process.env.MAIL_FROM,
  // Where internal/ops notifications (e.g. a new marketing-form inquiry) are
  // sent. Optional: when unset, the mailer falls back to `MAIL_FROM` (the
  // platform's own address), so no new credential is required to wire it up.
  opsInbox: process.env.OPS_INBOX_EMAIL,
}));
