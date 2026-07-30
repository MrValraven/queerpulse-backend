import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as Sentry from '@sentry/node';
import { STATUS_CODES } from 'node:http';
import type { Response } from 'express';

/**
 * Global catch-all filter with two jobs:
 *
 *  1. Observability — a structured error log + optional Sentry capture for
 *     unhandled and 5xx errors.
 *  2. Error-envelope normalization — every `HttpException` thrown with a plain
 *     OBJECT body is serialized to the ONE documented error contract this API
 *     guarantees:
 *
 *       { statusCode: number, error: string, message: string | string[],
 *         code?: string, ...domainSpecificFields }
 *
 *     Nest's default handling passes an object response through to the wire
 *     verbatim, so a hand-rolled body like `{ unmet: [...] }` or
 *     `{ reason: 'invalid' }` would ship WITHOUT the `statusCode`/`error`/
 *     `message` envelope every string-thrown exception gets — three different
 *     "error vocabularies" on the wire. This filter fills in those envelope
 *     fields for any object body that is missing them, so the frontend's
 *     `reasonFor`/`describeError` extraction (which reads `message`, and
 *     `code` for `PLATFORM_LOCKED`) always finds a `message`, while any
 *     domain-specific discriminator the frontend also reads (`code`, `unmet`,
 *     `reason`, `identities`) is preserved untouched.
 *
 * String-body exceptions (the common `throw new NotFoundException('…')`) and
 * non-HTTP exceptions (500s) already produce the canonical envelope via Nest's
 * default handling, so they are deferred to `super.catch` unchanged.
 *
 * WebSocket exceptions are handled by the gateway's own scoped filter (a more
 * specific filter always wins over this global one), so this only shapes HTTP.
 */
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('UnhandledException');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      super.catch(exception, host);
      return;
    }

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : 500;
    const responseBody = isHttp ? exception.getResponse() : undefined;

    // A platform lockdown rejection (503, code PLATFORM_LOCKED) is a
    // deliberate operator action, not an incident: while the switch is on,
    // every rejected request would otherwise log an error-level stack trace
    // and burn a Sentry event, which is exactly when the incident log needs
    // to stay readable. Do not "restore" this logging.
    const isLockdownRejection =
      isHttp &&
      status === 503 &&
      typeof responseBody === 'object' &&
      responseBody !== null &&
      (responseBody as { code?: unknown }).code === 'PLATFORM_LOCKED';

    if ((!isHttp || status >= 500) && !isLockdownRejection) {
      this.logger.error(
        exception instanceof Error
          ? (exception.stack ?? exception.message)
          : String(exception),
      );
      if (process.env.SENTRY_DSN) {
        Sentry.captureException(exception);
      }
    }

    // Only object-body HttpExceptions need normalizing; everything else already
    // ships the canonical envelope through Nest's default handling.
    if (
      isHttp &&
      typeof responseBody === 'object' &&
      responseBody !== null &&
      !Array.isArray(responseBody)
    ) {
      const response = host.switchToHttp().getResponse<Response>();
      response.status(status).json(normalizeErrorBody(status, responseBody));
      return;
    }

    super.catch(exception, host);
  }
}

/**
 * Fills in the canonical envelope fields (`statusCode`, `error`, `message`) on
 * a hand-rolled object error body without disturbing any field the thrower
 * (and the frontend) already relies on. Idempotent: a body that already carries
 * all three — e.g. the lockdown guard's `{ statusCode, error, code, message }` —
 * passes through unchanged.
 */
function normalizeErrorBody(
  status: number,
  body: object,
): Record<string, unknown> {
  const source = body as Record<string, unknown>;
  const reasonPhrase = STATUS_CODES[status] ?? 'Error';
  return {
    ...source,
    statusCode: status,
    error: typeof source.error === 'string' ? source.error : reasonPhrase,
    message:
      source.message === undefined || source.message === null
        ? reasonPhrase
        : source.message,
  };
}
