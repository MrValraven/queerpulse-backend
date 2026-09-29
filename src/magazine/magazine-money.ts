/**
 * Money handling for the magazine desk (CON-18).
 *
 * ONE rule holds this file together: an amount is a STRING from Postgres to
 * the wire and back. `magazine_payment.fee_amount`/`expenses_amount` are
 * `numeric(12,2)`, the `pg` driver hands `numeric` back as a string, and
 * nothing here ever parses one into a JS `number`. A binary float cannot hold
 * 0.10 exactly, and a magazine that cannot say what an issue cost to the cent
 * is the gap this fixes. Totals are summed in Postgres, never in JS.
 */

/** What the desk prices in unless a payment says otherwise. */
export const DEFAULT_MAGAZINE_CURRENCY = 'EUR';

/**
 * Accepted shape of an amount on the wire: plain digits with at most two
 * decimal places and no separators, sign, or currency mark. The currency
 * travels in its own field, and a negative fee is a credit note the desk has
 * no concept of.
 *
 * The empty string is allowed and means "clear this amount" — `@IsOptional()`
 * only skips `null`/`undefined`, so a field the editor emptied has to pass
 * validation before `upsertPayment` can turn it back into NULL.
 */
export const MONEY_AMOUNT_PATTERN = /^(\d{1,10}(\.\d{1,2})?)?$/;

/** ISO 4217 code: three letters, upper case. */
export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

const SYMBOL_BY_CURRENCY: Record<string, string> = {
  EUR: '€',
  GBP: '£',
  USD: '$',
  BRL: 'R$',
};

/**
 * "€420.00" for a currency with a known symbol, "CHF 420.00" otherwise.
 * Returns `null` for an unpriced row so callers can decide their own
 * fallback rather than printing a misleading zero.
 */
export function formatMoney(
  currency: string,
  amount: string | null,
): string | null {
  if (amount === null) {
    return null;
  }
  const code = currency.toUpperCase();
  const symbol = SYMBOL_BY_CURRENCY[code];
  return symbol ? `${symbol}${amount}` : `${code} ${amount}`;
}

/**
 * The display string for one money field: the priced amount when there is
 * one, otherwise whatever the desk actually typed before this row was ever
 * priced, otherwise an empty string.
 */
export function moneyDisplay(
  currency: string,
  amount: string | null,
  text: string | null,
): string {
  return formatMoney(currency, amount) ?? text ?? '';
}

/**
 * Splits the free-text fee an editor typed into a commission form into the
 * two payment columns: a clean amount when the text reads as one ("150",
 * "€150", "150 €", "150,50", "EUR 1200.5"), otherwise the trimmed text itself
 * (at most 200 characters) so the desk's wording is kept for a later pricing
 * pass. An empty fee clears both.
 */
export function splitCommissionFee(rawFee: string): {
  feeAmount: string | null;
  feeText: string | null;
} {
  const trimmed = rawFee.trim();
  if (trimmed === '') {
    return { feeAmount: null, feeText: null };
  }

  let normalized = trimmed.replace(/€|eur/gi, '').replace(/\s+/g, '');
  // A European decimal comma ("150,50") becomes the dot the wire format uses.
  if (/^\d{1,10},\d{1,2}$/.test(normalized)) {
    normalized = normalized.replace(',', '.');
  }
  if (normalized !== '' && MONEY_AMOUNT_PATTERN.test(normalized)) {
    return { feeAmount: normalized, feeText: null };
  }
  return { feeAmount: null, feeText: trimmed.slice(0, 200) };
}
