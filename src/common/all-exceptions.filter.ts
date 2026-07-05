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

      if (!isHttp || status >= 500) {
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
