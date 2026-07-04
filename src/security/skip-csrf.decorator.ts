import { SetMetadata } from '@nestjs/common';

// Exempts a route from the CSRF double-submit check. Only for endpoints that
// carry their own request authentication (e.g. HMAC-signed provider webhooks)
// — never for cookie-authenticated browser routes.
export const SKIP_CSRF_KEY = 'skipCsrf';
export const SkipCsrf = () => SetMetadata(SKIP_CSRF_KEY, true);
