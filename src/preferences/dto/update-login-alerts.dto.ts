import { IsBoolean } from 'class-validator';

/**
 * `PUT /me/login-alerts` — the single sign-in-alert switch.
 *
 * Turning it off stops `AuthService.issueTokens` from emitting
 * `SECURITY_NEW_SIGN_IN` at all, so no bell row is written and no push is sent.
 * It never affects the sign-in itself, and it never hides anything from
 * `/account/sessions`: the device list is always complete.
 */
export class UpdateLoginAlertsDto {
  @IsBoolean()
  enabled!: boolean;
}
