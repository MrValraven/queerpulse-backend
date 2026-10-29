import { IsIn } from 'class-validator';

/** The languages the welcome email template exists in. */
export const WELCOME_INVITE_LOCALES = ['en', 'pt'] as const;

export type WelcomeInviteLocale = (typeof WELCOME_INVITE_LOCALES)[number];

/**
 * Body of `POST /admin/join-requests/:id/invite/email`. It carries the
 * language and nothing else: the recipient address always comes from the join
 * request itself, so a reviewer's client can never aim the email somewhere
 * else.
 */
export class SendWelcomeInviteEmailDto {
  @IsIn(WELCOME_INVITE_LOCALES)
  locale!: WelcomeInviteLocale;
}
