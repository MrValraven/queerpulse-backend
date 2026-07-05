import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseWsExceptionFilter } from '@nestjs/websockets';
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
 */
@Catch()
export class WsAllExceptionsFilter extends BaseWsExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof HttpException) {
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
