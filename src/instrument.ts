import * as Sentry from '@sentry/node';

/**
 * Sentry initialization, isolated in its own module so it runs BEFORE anything
 * else is imported.
 *
 * This file must be the first import in `main.ts`. Sentry's auto-instrumentation
 * patches `http`, `express` and `pg` at require-time, so it has to run before
 * those modules are loaded. When `Sentry.init` sat inline in `main.ts` it was
 * hoisted below `import { AppModule }` — errors were still captured, but with no
 * request context (URL, method, user, breadcrumbs), which is most of the value.
 *
 * No-op unless SENTRY_DSN is set.
 */
export function initSentry(): void {
  if (!process.env.SENTRY_DSN) {
    return;
  }
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0,
  });
}

initSentry();
