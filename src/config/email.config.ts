import { registerAs } from '@nestjs/config';

/** The sender every sign-in code email uses when RESEND_FROM is unset. */
export const DEFAULT_RESEND_FROM = 'QueerPulse <hello@queerpulse.com>';

// Sign-in code email through Resend. The template ids point at the published
// English and Portuguese templates in the Resend dashboard. EMAIL_CODE_SECRET
// keys the HMAC that stores each code as a hash.
//
// `enabled` switches the whole email-code sign-in on or off. It is on when
// RESEND_API_KEY and both template ids are set (RESEND_FROM has a default), or
// when `devLog` is on. With it off, every /auth/email-code route answers 503
// `email_code_unavailable` and /platform-status reports `emailCodeSignIn:
// false`, so the frontend hides the email-code options.
//
// `devLog` is the local opt-in: EMAIL_CODE_DEV_LOG=true outside production
// turns the feature on without Resend, and the mailer then logs the code on one
// `[dev]` line and sends nothing. Production ignores it.
export default registerAs('email', () => {
  const resendApiKey = process.env.RESEND_API_KEY;
  const signInTemplateIdEn = process.env.RESEND_SIGNIN_TEMPLATE_ID_EN;
  const signInTemplateIdPt = process.env.RESEND_SIGNIN_TEMPLATE_ID_PT;
  const isResendConfigured = Boolean(
    resendApiKey && signInTemplateIdEn && signInTemplateIdPt,
  );
  const devLog =
    process.env.NODE_ENV !== 'production' &&
    process.env.EMAIL_CODE_DEV_LOG === 'true';
  return {
    resendApiKey,
    from: process.env.RESEND_FROM || DEFAULT_RESEND_FROM,
    signInTemplateIdEn,
    signInTemplateIdPt,
    codeSecret: process.env.EMAIL_CODE_SECRET,
    devLog,
    enabled: isResendConfigured || devLog,
  };
});
