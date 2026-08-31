import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CON-18 — reads the old free-text money across into the `numeric` columns
 * `AddMagazinePaymentNumericMoney` just added.
 *
 * The rule this migration is built around: NOTHING IS DISCARDED. `fee_text`
 * and `expenses_text` keep every character they held, whether the parse
 * succeeded or not, so a row that reads "18 travel, receipts with Marta"
 * still says so beside its 18.00. That also makes `down()` exact — it clears
 * the three new columns and the old values are simply still there.
 *
 * Parsing is deliberately CONSERVATIVE. A value converts only when it holds
 * exactly one number and that number is unambiguous:
 *  - "€420", "EUR 420", "420"      -> 420.00, currency EUR
 *  - "420,50" / "420.50"           -> 420.50 (one or two trailing digits is
 *                                     a decimal in either notation)
 *  - "18 travel"                   -> 18.00, and the words stay in the text
 *  - "1.250" / "1,250"             -> LEFT ALONE. Three trailing digits is
 *                                     1250 to a Portuguese editor and 1.25
 *                                     rounded to nobody; guessing here would
 *                                     be a factor-of-1000 error in a ledger.
 *  - "€200 + €50 expenses", ""     -> LEFT ALONE (no number, or several).
 * Anything left alone keeps its text and stays out of every total, and
 * `IssueCostsResponse.unpricedCount` is how the desk sees that it happened.
 *
 * The parser is intentionally self-contained rather than imported from
 * `magazine-money.ts`: a migration is a record of what ran on a given day,
 * and it must not change meaning because application code was refactored
 * later.
 *
 * Every bucket is counted and logged. A silent conversion over money is not
 * something anyone should have to take on trust.
 */

interface PaymentTextRow {
  id: string;
  fee_text: string | null;
  expenses_text: string | null;
}

interface ParsedMoney {
  /** Decimal string ready for `numeric(12,2)`, or `null` when not converted. */
  amount: string | null;
  /** ISO 4217 read off the text, or `null` when the text named none. */
  currency: string | null;
}

const CURRENCY_BY_MARK: Record<string, string> = {
  '€': 'EUR',
  '£': 'GBP',
  $: 'USD',
  EUR: 'EUR',
  GBP: 'GBP',
  USD: 'USD',
  BRL: 'BRL',
};

/** Every distinct ISO code the text names, by symbol or by code. */
function currenciesIn(text: string): string[] {
  const found = new Set<string>();
  if (/R\$/.test(text)) {
    found.add('BRL');
  }
  for (const mark of ['€', '£']) {
    if (text.includes(mark)) {
      found.add(CURRENCY_BY_MARK[mark]!);
    }
  }
  // A bare "$" only counts when it is not the "R$" already matched above.
  if (/(^|[^R])\$/.test(text)) {
    found.add('USD');
  }
  for (const match of text.toUpperCase().matchAll(/\b(EUR|GBP|USD|BRL)\b/g)) {
    found.add(CURRENCY_BY_MARK[match[1]!]!);
  }
  return [...found];
}

/**
 * Normalises one number token to a plain decimal string, or returns `null`
 * when its separators are ambiguous. See the class doc for the "three
 * trailing digits" rule, which is where a naive parser loses a thousandfold.
 */
function normaliseNumber(token: string): string | null {
  const lastDot = token.lastIndexOf('.');
  const lastComma = token.lastIndexOf(',');
  const decimalAt = Math.max(lastDot, lastComma);

  if (decimalAt === -1) {
    return /^\d{1,10}$/.test(token) ? token : null;
  }

  const wholePart = token.slice(0, decimalAt).replace(/[.,]/g, '');
  const fractionPart = token.slice(decimalAt + 1);
  if (!/^\d{1,10}$/.test(wholePart) || !/^\d+$/.test(fractionPart)) {
    return null;
  }
  // Exactly three digits after the final separator, and only one separator in
  // the whole token: grouping and decimal are indistinguishable. Refuse.
  const separatorCount = (token.match(/[.,]/g) ?? []).length;
  if (fractionPart.length === 3) {
    return separatorCount === 1 ? null : `${wholePart}${fractionPart}`;
  }
  if (fractionPart.length > 3) {
    return null;
  }
  return `${wholePart}.${fractionPart}`;
}

function parseMoneyText(raw: string | null): ParsedMoney {
  const text = (raw ?? '').trim();
  const currencies = currenciesIn(text);
  // Two currencies in one field is a note, never an amount.
  const currency = currencies.length === 1 ? currencies[0]! : null;
  if (text === '' || currencies.length > 1) {
    return { amount: null, currency };
  }

  const numbers = text.match(/\d[\d.,]*\d|\d/g) ?? [];
  const onlyNumber = numbers[0];
  // Zero numbers is prose ("to be agreed"); two or more is a note the desk
  // wrote ("€200 fee + €50 expenses"), and picking one of them would invent
  // a figure nobody typed.
  if (numbers.length !== 1 || onlyNumber === undefined) {
    return { amount: null, currency };
  }
  return { amount: normaliseNumber(onlyNumber), currency };
}

export class BackfillMagazinePaymentAmounts1794833710000 implements MigrationInterface {
  name = 'BackfillMagazinePaymentAmounts1794833710000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `queryRunner.query` is untyped in this TypeORM version; the SELECT
    // above names exactly these three columns.
    const rows = (await queryRunner.query(
      `SELECT "id", "fee_text", "expenses_text" FROM "magazine_payment"`,
    )) as PaymentTextRow[];

    const tally = {
      rows: rows.length,
      feeConverted: 0,
      feeEmpty: 0,
      feeUnparsed: 0,
      expensesConverted: 0,
      expensesEmpty: 0,
      expensesUnparsed: 0,
      currencyReadFromText: 0,
      currencyLeftAtDefault: 0,
    };

    for (const row of rows) {
      const fee = parseMoneyText(row.fee_text);
      const expenses = parseMoneyText(row.expenses_text);

      const feeBucket = bucketOf(row.fee_text, fee.amount);
      tally.feeConverted += feeBucket === 'converted' ? 1 : 0;
      tally.feeEmpty += feeBucket === 'empty' ? 1 : 0;
      tally.feeUnparsed += feeBucket === 'unparsed' ? 1 : 0;

      const expensesBucket = bucketOf(row.expenses_text, expenses.amount);
      tally.expensesConverted += expensesBucket === 'converted' ? 1 : 0;
      tally.expensesEmpty += expensesBucket === 'empty' ? 1 : 0;
      tally.expensesUnparsed += expensesBucket === 'unparsed' ? 1 : 0;

      // One currency per payment row. The fee decides it, because the fee is
      // the commission; expenses only get a say when the fee named none.
      const currency = fee.currency ?? expenses.currency;
      if (currency === null) {
        tally.currencyLeftAtDefault += 1;
      } else {
        tally.currencyReadFromText += 1;
      }

      if (
        fee.amount === null &&
        expenses.amount === null &&
        currency === null
      ) {
        continue;
      }
      await queryRunner.query(
        `UPDATE "magazine_payment"
            SET "fee_amount" = $2,
                "expenses_amount" = $3,
                "currency" = COALESCE($4, "currency")
          WHERE "id" = $1`,
        [row.id, fee.amount, expenses.amount, currency],
      );
    }

    // Deliberately loud: this is the one place anyone can see what the
    // conversion did to real money before the totals start being trusted.
    console.log(
      `[BackfillMagazinePaymentAmounts] ${JSON.stringify(tally, null, 2)}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Exact, because the text columns were never written to.
    await queryRunner.query(
      `UPDATE "magazine_payment"
          SET "fee_amount" = NULL,
              "expenses_amount" = NULL,
              "currency" = 'EUR'`,
    );
  }
}

/** Which report bucket one field falls in. */
function bucketOf(
  text: string | null,
  amount: string | null,
): 'converted' | 'empty' | 'unparsed' {
  if (amount !== null) {
    return 'converted';
  }
  return (text ?? '').trim() === '' ? 'empty' : 'unparsed';
}
