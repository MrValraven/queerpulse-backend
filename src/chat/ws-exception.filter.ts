import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import * as Sentry from '@sentry/node';
import { Socket } from 'socket.io';
import {
  ChatWsErrorCode,
  ChatWsErrorFrame,
  ChatWsException,
  buildChatWsErrorFrame,
} from './ws-error';

/**
 * Maps an `HttpException`'s HTTP status to the gateway's own error code
 * (ENG-206/ENG-220). Kept as its own function so the mapping is testable in
 * isolation from the filter's logging/reporting side effects.
 */
function codeForHttpStatus(status: number): ChatWsErrorCode {
  switch (status) {
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 429:
      return 'RATE_LIMITED';
    default:
      // Every other 5xx is a server fault; every other 4xx (400, 409, 422,
      // ...) collapses to the generic BAD_REQUEST the contract defines,
      // since there is no client action that differs between them.
      return status >= 500 ? 'SERVER_ERROR' : 'BAD_REQUEST';
  }
}

/**
 * Gateway-scoped catch-all filter.
 *
 * ENG-206/ENG-212/ENG-220: every exception a handler throws (or the
 * `ValidationPipe`'s `exceptionFactory` raises) is normalised into the ONE
 * `{ status: 'error', code, message, statusCode? }` shape documented on
 * `ChatWsErrorFrame`, and this filter is the only place that builds it for
 * anything other than a deliberately-thrown `ChatWsException` (which already
 * carries its own frame). Nothing here falls through to
 * `BaseWsExceptionFilter`: that base class emits an `exception` frame with
 * no `code` at all, which is the exact ambiguity ENG-206 exists to close. The
 * client could not tell a rate-limit refusal from an expired token and spent
 * a refresh-token rotation on every non-auth refusal it received.
 *
 * Logging is now PROPORTIONATE to fault (ENG-212): only `SERVER_ERROR` (an
 * unclassified throw, or an `HttpException` carrying a 5xx) is logged at
 * error level and sent to Sentry. A rate-limit refusal, a validation
 * failure, or a domain 403/404 is the protocol working as intended and gets
 * at most a debug line. Before this fix EVERY non-`HttpException` (which
 * includes the gateway's own `WsException`-based rate-limit refusals) was
 * flattened into a server fault, so one flooding client could burn the
 * Sentry quota and bury real infrastructure faults under refusal noise.
 */
@Catch()
export class WsAllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('WsUnhandledException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const frame = this.buildFrame(exception);
    this.report(exception, frame);
    const client = host.switchToWs().getClient<Socket>();
    client.emit('exception', frame);
  }

  private buildFrame(exception: unknown): ChatWsErrorFrame {
    // Checked BEFORE the plain-`WsException` branch below: `ChatWsException`
    // extends `WsException`, so the order matters. Every deliberate refusal
    // in this gateway already carries the right code and must keep it rather
    // than being reclassified as a bare BAD_REQUEST.
    if (exception instanceof ChatWsException) {
      return exception.getError() as ChatWsErrorFrame;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'string') {
        return buildChatWsErrorFrame(
          codeForHttpStatus(status),
          response,
          status,
        );
      }
      const responseBody = response as { message?: unknown; code?: unknown };
      const message = responseBody.message ?? exception.message;
      // ENG-242: some HTTP refusals (e.g. `NotRestrictedGuard`'s
      // `ACCOUNT_RESTRICTED_CODE`) carry a machine-readable domain `code`
      // alongside the coarse HTTP status. `ChatWsErrorCode` stays the
      // transport-level classification every gateway refusal already uses
      // (`FORBIDDEN`/`BAD_REQUEST`/…), so a present domain `code` travels in
      // the frame's own `domainCode` field instead of widening that union. The
      // client (`realtime.ts`'s exception handler) reads `domainCode` to
      // distinguish e.g. "you're moderation-restricted" from every other
      // FORBIDDEN, without matching on message text.
      //
      // It is deliberately NOT folded into `message`. Doing that reshaped
      // `message` to `{ message, code }` for coded refusals only, so `message`
      // was no longer reliably display copy: every consumer would have had to
      // test which of the two shapes it got before it could render anything.
      return buildChatWsErrorFrame(
        codeForHttpStatus(status),
        message,
        status,
        typeof responseBody.code === 'string' ? responseBody.code : undefined,
      );
    }
    if (exception instanceof WsException) {
      // The `ValidationPipe`'s `exceptionFactory` (see `ChatGateway`'s
      // `@UsePipes`) raises exactly this: a plain `WsException` wrapping the
      // class-validator error array. It is a malformed-input refusal, so it
      // stays BAD_REQUEST here: every non-`HttpException` used to flatten
      // into a "server fault" instead.
      return buildChatWsErrorFrame('BAD_REQUEST', exception.getError());
    }
    // Anything else (a thrown non-Error, an unexpected DB/library failure
    // that was never wrapped in a `ChatWsException`) is a genuine
    // infrastructure fault.
    return buildChatWsErrorFrame('SERVER_ERROR', 'Internal server error');
  }

  private report(exception: unknown, frame: ChatWsErrorFrame): void {
    if (frame.code !== 'SERVER_ERROR') {
      this.logger.debug(
        exception instanceof Error ? exception.message : String(exception),
      );
      return;
    }
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
