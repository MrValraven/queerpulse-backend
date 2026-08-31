import * as Sentry from '@sentry/node';
// Zero-dependency by construction (see the module header there), so importing
// it here cannot load `http`, `express` or `pg` ahead of `Sentry.init` and the
// "must be the first import" property below still holds. Never let this file
// grow an import that reaches the Nest container.
import {
  isSensitiveQueryParameterName,
  redactSensitiveQueryParameters,
  redactSensitiveQueryString,
  REDACTED_QUERY_VALUE,
} from './common/redact-url';

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
 *
 * This is the ONE place SENTRY_DSN is read straight from process.env rather
 * than through ConfigService: this module runs before NestFactory.create, so
 * the validated ConfigModule does not exist yet. The same value IS validated
 * (env.validation.ts) and re-exposed as `app.sentryDsn` once the app has booted
 * — code that runs after bootstrap (e.g. main.ts's shutdown flush) reads it
 * from there.
 */
export function initSentry(): void {
  if (!process.env.SENTRY_DSN) {
    return;
  }
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0,
    beforeSend: scrubSensitiveQueryParameters,
  });
}

/**
 * Strips credential-bearing query parameters out of every event on its way to
 * Sentry.
 *
 * The request context that makes Sentry worth having is also what carries the
 * leak: the HTTP integration attaches the request URL and its query string to
 * every captured error, so an error anywhere in the `GET /auth/google` handler
 * shipped `?invite=<code>` to a third-party service, where anyone with project
 * access could read it and use it to create an account on an invite-only
 * platform. `common/redact-url.ts` owns the parameter list, which the pino
 * request serializer in `app.module.ts` applies to the same values on the
 * logging path, so the two stay in step by construction.
 *
 * Three places on an event hold a URL. `request.url` and `request.query_string`
 * come from the incoming request; `query_string` is typed loosely because
 * Sentry accepts a raw string, an object or an array of pairs, and each shape
 * has to be handled or a leak survives in the shape we did not cover.
 * Breadcrumbs carry the URL of each OUTGOING request, which is where a
 * presigned storage URL and its live `X-Amz-Signature` would otherwise show up.
 *
 * Returning the event (never null) keeps every error reportable; this only
 * changes what the report is allowed to say.
 */
function scrubSensitiveQueryParameters(
  event: Sentry.ErrorEvent,
): Sentry.ErrorEvent {
  const request = event.request;
  if (request) {
    if (typeof request.url === 'string') {
      request.url = redactSensitiveQueryParameters(request.url);
    }
    if (typeof request.query_string === 'string') {
      request.query_string = redactSensitiveQueryString(request.query_string);
    } else if (Array.isArray(request.query_string)) {
      request.query_string = request.query_string.map(
        ([name, value]): [string, string] => [
          name,
          isSensitiveQueryParameterName(name) ? REDACTED_QUERY_VALUE : value,
        ],
      );
    } else if (
      request.query_string &&
      typeof request.query_string === 'object'
    ) {
      request.query_string = Object.fromEntries(
        Object.entries(request.query_string).map(([name, value]) => [
          name,
          isSensitiveQueryParameterName(name) ? REDACTED_QUERY_VALUE : value,
        ]),
      );
    }
  }

  for (const breadcrumb of event.breadcrumbs ?? []) {
    const url: unknown = breadcrumb.data?.url;
    if (breadcrumb.data && typeof url === 'string') {
      breadcrumb.data.url = redactSensitiveQueryParameters(url);
    }
  }

  return event;
}

initSentry();
