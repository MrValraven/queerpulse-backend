import type { WelcomeInviteLocale } from './dto/send-welcome-invite-email.dto';

/** The invite landing path the frontend serves (`inviteLink` in its route map). */
const INVITE_PATH_PREFIX = '/auth/invite/';

/** Invite expiry days follow the community's home calendar. */
const EXPIRY_TIME_ZONE = 'Europe/Lisbon';

/** `en-GB` writes "5 November 2026"; `pt-PT` writes "5 de novembro de 2026". */
const DATE_LOCALE_BY_LOCALE: Record<WelcomeInviteLocale, string> = {
  en: 'en-GB',
  pt: 'pt-PT',
};

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes the five HTML-significant characters. The Resend template prints
 * `name` unescaped (triple mustache) and an applicant typed it, so it is
 * escaped before it leaves the backend.
 */
export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) => HTML_ESCAPES[character] ?? character,
  );
}

/**
 * The full, clickable invite link: the canonical frontend origin plus the same
 * path the frontend builds in `inviteFullUrlFor`.
 */
export function buildInviteLink(frontendOrigin: string, code: string): string {
  return `${frontendOrigin.replace(/\/+$/, '')}${INVITE_PATH_PREFIX}${encodeURIComponent(code)}`;
}

/** The invite's expiry as a long date in the chosen language, Lisbon day. */
export function formatExpiresOn(
  expiresAt: Date,
  locale: WelcomeInviteLocale,
): string {
  return new Intl.DateTimeFormat(DATE_LOCALE_BY_LOCALE[locale], {
    dateStyle: 'long',
    timeZone: EXPIRY_TIME_ZONE,
  }).format(expiresAt);
}
