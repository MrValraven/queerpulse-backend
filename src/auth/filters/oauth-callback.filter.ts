import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { OAuthCallbackError } from '../errors/oauth-callback.error';
import { signInErrorUrl } from '../safe-redirect';

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
 */
@Catch(OAuthCallbackError)
export class OAuthCallbackFilter implements ExceptionFilter {
  constructor(private readonly config: ConfigService) {}

  catch(exception: OAuthCallbackError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    res.redirect(
      signInErrorUrl(
        this.config.getOrThrow<string>('app.frontendUrl'),
        exception.code,
      ),
    );
  }
}
