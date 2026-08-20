/**
 * Shared CSV-injection guard for admin CSV exports. Mirrors the local
 * implementations already living in `mod-audit.service.ts`'s `auditFeedCsv`
 * and the roadmap admin CSV export (RFC-4180 quote/escape plus a spreadsheet
 * formula-injection guard) — factored out here so a new export (e.g.
 * `AdminReportsService`'s growth / reports-by-type CSVs) reuses the exact
 * same guard rather than a parallel reimplementation. The two existing call
 * sites are left as they are (each already correct and already tested); this
 * is the shared home for anything new.
 */

/** Spreadsheet apps evaluate a cell whose content starts with `=`, `+`, `-`,
 *  `@`, a tab, or a carriage return as a formula on open. Prefixing a `'`
 *  forces plain-text rendering; applied before the quote/escape so the
 *  apostrophe lands inside the quoted field. */
export function neutralizeCsvFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** RFC-4180 quote/escape a single field, after neutralizing it against
 *  formula injection. */
export function toCsvField(value: string): string {
  const guarded = neutralizeCsvFormula(value);
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** One CSV row from already-stringified fields. */
export function toCsvRow(fields: string[]): string {
  return fields.map((field) => toCsvField(field)).join(',');
}
