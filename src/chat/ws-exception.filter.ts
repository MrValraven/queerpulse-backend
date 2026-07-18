import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseWsExceptionFilter } from '@nestjs/websockets';
import * as Sentry from '@sentry/node';
import { Socket } from 'socket.io';

/**
 * Gateway-scoped catch-all filter.
 *
 * Domain services (e.g. `MessagingService`) throw HTTP exceptions such as
 * `ForbiddenException`. On the WS path those would otherwise surface to the
 * client as a generic "Internal server error" (and the global `ValidationPipe`'s
 * `BadRequestException` does the same). This maps any `HttpException` into a
 * structured `exception` event and delegates everything else (including
 * `WsException`) to the base filter.
 *
 * It also carries the observability half of `AllExceptionsFilter`: that filter
 * bails out on anything non-HTTP, and a gateway-scoped filter wins over it
 * anyway, so unless this one logs and reports, the entire chat write path fails
 * silently — no log line, nothing in Sentry.
 */
@Catch()
export class WsAllExceptionsFilter extends BaseWsExceptionFilter {
  private readonly logger = new Logger('WsUnhandledException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const isHttp = exception instanceof HttpException;

    // Same threshold as the HTTP filter: client errors (4xx) are the protocol
    // working as intended, so only server faults are worth reporting.
    if (!isHttp || exception.getStatus() >= 500) {
      this.logger.error(
        exception instanceof Error
          ? (exception.stack ?? exception.message)
          : String(exception),
      );
      if (process.env.SENTRY_DSN) {
        Sentry.captureException(exception);
      }
    }

    if (isHttp) {
      const client = host.switchToWs().getClient<Socket>();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: unknown }).message ?? exception.message);
      client.emit('exception', {
        status: 'error',
        statusCode: exception.getStatus(),
        message,
      });
      return;
    }
    super.catch(exception, host);
  }
}
