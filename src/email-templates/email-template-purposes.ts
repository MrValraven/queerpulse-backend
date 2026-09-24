/**
 * What each kind of email template is for, and so which `{token}`s it may use.
 * Mirrored in the frontend at
 * `src/features/admin/emailTemplates/emailTemplatePurposes.ts`; change both.
 *
 * A purpose is a plain varchar on the row, so adding one here needs no
 * migration. Each new purpose also needs the surface that fills its tokens.
 */
export const EMAIL_TEMPLATE_PURPOSES = {
  invite_approved: ['name', 'inviteLink', 'expiresOn'],
  general: [],
} as const satisfies Record<string, readonly string[]>;

export type EmailTemplatePurpose = keyof typeof EMAIL_TEMPLATE_PURPOSES;

export const EMAIL_TEMPLATE_PURPOSE_CODES = Object.keys(
  EMAIL_TEMPLATE_PURPOSES,
) as EmailTemplatePurpose[];

/** Letters then letters/digits inside single braces. CSS such as `{margin:0}`
 *  or `{ color: red }` never matches, so an HTML body's styles are not tokens. */
export const EMAIL_PLACEHOLDER_PATTERN = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

/** Every `{token}` name in `text`, in order of first appearance, deduplicated. */
export function placeholdersIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(EMAIL_PLACEHOLDER_PATTERN)) {
    const token = match[1];
    if (token !== undefined && !found.includes(token)) found.push(token);
  }
  return found;
}
