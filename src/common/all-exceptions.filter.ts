import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as Sentry from '@sentry/node';

/**
 * Global catch-all filter that adds observability (structured error log +
 * optional Sentry capture) for unhandled and 5xx errors, then defers to Nest's
 * default exception handling so the client-facing error envelope is unchanged.
 *
 * WebSocket exceptions are handled by the gateway's own scoped filter (a more
 * specific filter always wins over this global one), so this only shapes HTTP.
 */
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('UnhandledException');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() === 'http') {
      const isHttp = exception instanceof HttpException;
      const status = isHttp ? exception.getStatus() : 500;

      // A platform lockdown rejection (503, code PLATFORM_LOCKED) is a
      // deliberate operator action, not an incident: while the switch is on,
      // every rejected request would otherwise log an error-level stack trace
      // and burn a Sentry event, which is exactly when the incident log needs
      // to stay readable. Do not "restore" this logging.
      const responseBody = isHttp ? exception.getResponse() : undefined;
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
    }

    super.catch(exception, host);
  }
}
