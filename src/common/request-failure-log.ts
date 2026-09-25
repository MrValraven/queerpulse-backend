import { HttpException } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Carries WHY a request failed from `AllExceptionsFilter` to the pino-http
 * request line, so a 4xx line names its cause, e.g.
 * `reason="Expired refresh token"`. The filter runs before the response finishes and
 * pino-http reads its `customProps` when it does, so the two meet on the
 * response object. Keyed weakly: an entry lives exactly as long as its
 * response.
 */
const failures = new WeakMap<ServerResponse, RequestFailure>();

interface RequestFailure {
  reason: string;
  code?: string;
}

// Long enough for a joined validation message list, short enough that a
// message echoing a large input cannot bloat the line.
const MAX_REASON_LENGTH = 300;

/** Called by the exception filter for every `HttpException` it handles. */
export function recordRequestFailure(
  response: ServerResponse,
  exception: HttpException,
): void {
  const body = exception.getResponse();
  let message: unknown = typeof body === 'string' ? body : exception.message;
  let code: string | undefined;
  if (typeof body === 'object' && body !== null) {
    const fields = body as { message?: unknown; code?: unknown };
    message = fields.message ?? message;
    if (typeof fields.code === 'string') code = fields.code;
  }
  const reason = Array.isArray(message)
    ? message.map(String).join('; ')
    : String(message);
  failures.set(response, {
    reason: reason.slice(0, MAX_REASON_LENGTH),
    ...(code ? { code } : {}),
  });
}

/**
 * pino-http `customProps`. Adds nothing to a successful request. A failed one
 * gets the recorded reason and code, plus the caller's user id when a session
 * was resolved. The id rides ONLY on failures on purpose: on every request it
 * would turn the log store into a per-member browsing trail, while on a
 * failure it is what lets someone's "it broke for me" report be found.
 *
 * pino-http also calls this once when the request STARTS (to bind
 * `req.log`), when the status is still the default 200, so that call falls
 * through to the empty object.
 */
export function requestFailureLogProps(
  req: IncomingMessage,
  res: ServerResponse,
): Record<string, string> {
  if (res.statusCode < 400) return {};
  const failure = failures.get(res);
  const userId = (req as IncomingMessage & { user?: { userId?: unknown } }).user
    ?.userId;
  return {
    ...(failure ?? {}),
    ...(typeof userId === 'string' ? { userId } : {}),
  };
}
