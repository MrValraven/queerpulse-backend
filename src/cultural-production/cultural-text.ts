/**
 * The one text rule of the Cultural Production routes (contract 7.2), shared
 * by the field rules (`cultural-input.ts`) and the guide section rules
 * (`cultural-guide-sections.ts`).
 */
import { sanitizeLeadText } from '../leads/lead-input';

/** The text rule of contract 7.2: NUL removed and unpaired surrogates
 *  replaced (`sanitizeLeadText`), CRLF and CR turned into LF, then trimmed
 *  at both ends. Inner line breaks stay. */
export function normalizeCulturalText(value: string): string {
  return sanitizeLeadText(value).replace(/\r\n?/g, '\n').trim();
}

/** The length of a text in code points, the unit every limit counts. */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}
