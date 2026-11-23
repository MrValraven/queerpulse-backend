import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { OAuthCallbackError } from '../errors/oauth-callback.error';
import { decodeOAuthState } from '../oauth-state';
import { oauthFailureUrl } from '../safe-redirect';

/**
 * Turns an {@link OAuthCallbackError} thrown by `GoogleAuthGuard` into a
 * user-facing redirect. The Google callback is a top-level browser navigation,
 * so a JSON 401/500 would leave the user staring at a raw error body; instead we
 * bounce them to the SPA sign-in page with a machine-readable `?error=<code>`.
 *
 * Applied at the callback route via `@UseFilters(OAuthCallbackFilter)`. Passing
 * the class (not an instance) lets Nest instantiate it and inject
 * `ConfigService`; method-scoped filters catch exceptions thrown by that route's
 * guards, which is exactly where the error originates.
 *
 * A step-up reauth (`reauth: true` in `state`) lands back on the page the
 * member started from with `#reauthError=<code>` (PRD-502): cancelling Google's
 * screen on the delete-account page must not drop a signed-in member on the
 * sign-in page.
 */
@Catch(OAuthCallbackError)
export class OAuthCallbackFilter implements ExceptionFilter {
  constructor(private readonly config: ConfigService) {}

  catch(exception: OAuthCallbackError, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const rawState =
      typeof req?.query?.state === 'string' ? req.query.state : undefined;
    res.redirect(
      oauthFailureUrl(
        decodeOAuthState(rawState),
        this.config.getOrThrow<string>('app.frontendUrl'),
        exception.code,
      ),
    );
  }
}
