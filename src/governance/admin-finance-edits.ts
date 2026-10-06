import { BadRequestException } from '@nestjs/common';
import { toStoredPlainText } from '../communities/community-plain-text';
import {
  FinanceEventNote,
  FinanceLine,
  FinanceLineItem,
  FinanceMetricSource,
  FinancePartner,
  FinanceReserve,
  FinanceStat,
} from './entities/governance-finance-report.entity';
import {
  FinanceEventNoteEditDto,
  FinanceLedgerEditDto,
  FinanceLineItemEditDto,
  FinancePartnerEditDto,
  FinanceReserveEditDto,
  FinanceStatEditDto,
} from './dto/update-admin-finances.dto';

/**
 * PRD-447. Pure edit helpers behind `GovernanceFinanceService.updateAdminFinances`.
 * No repository and no transaction, so each rule here is testable on plain
 * arrays. The service turns every {@link FinanceAuditEntry} into one
 * `governance_finance_changes` row.
 *
 * Everything an admin types here reaches the unauthenticated Governance page,
 * so text is cleaned once at this write boundary with `toStoredPlainText`, the
 * same rule `GovernanceOverviewService` applies to authored decisions.
 */

/** One field that changed, before it becomes an audit row. */
export interface FinanceAuditEntry {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface FinanceEditResult<Value> {
  value: Value;
  audit: FinanceAuditEntry[];
  isChanged: boolean;
  /** A money or count figure moved (a ledger amount, or a row added). Only
   *  this restamps the public "figures entered on" date; a label, note or
   *  prose change leaves it alone. */
  isFigureChanged: boolean;
}

/** Cleaned text that must still say something once markup is stripped. */
function requiredText(value: string, fieldName: string): string {
  const stored = toStoredPlainText(value);
  if (!stored.length) {
    throw new BadRequestException(`${fieldName} needs real text.`);
  }
  return stored;
}

/** The euro value inside a stored amount ("€1,840", "1840.5"); 0 when none. */
function amountValue(amount: string): number {
  const numeric = Number(amount.replace(/[^0-9.]/g, ''));
  return Number.isFinite(numeric) ? numeric : 0;
}

/** An amount ("1840.5", or a seeded "€1,840") in whole cents (184050). */
function toCents(amount: string): number {
  return Math.round(amountValue(amount) * 100);
}

/** Cents back to the canonical plain amount the editor sends ("1840.5"). */
function toCanonicalAmount(cents: number): string {
  return String(Math.round(cents) / 100);
}

/** The breakdown as it is stored: cleaned names and periods, canonical amounts. */
function cleanLineItems(items: FinanceLineItemEditDto[]): FinanceLineItem[] {
  return items.map((item) => ({
    name: requiredText(item.name, 'A line item name'),
    period: toStoredPlainText(item.period),
    amount: toCanonicalAmount(toCents(item.amount)),
  }));
}

/** The items' total, summed in cents so "0.1" and "0.2" make "0.3". */
function sumLineItems(items: FinanceLineItem[]): string {
  return toCanonicalAmount(
    items.reduce((cents, item) => cents + toCents(item.amount), 0),
  );
}

/** A breakdown's audit value: "3 items · 120", or "0 items" when empty. */
function summarizeLineItems(items: FinanceLineItem[]): string {
  if (items.length === 0) return '0 items';
  const countLabel = items.length === 1 ? '1 item' : `${items.length} items`;
  return `${countLabel} · ${sumLineItems(items)}`;
}

/** A stored breakdown in the key order {@link cleanLineItems} writes, so two
 *  breakdowns compare equal as JSON whenever their items match. */
function storedLineItems(line: FinanceLine): FinanceLineItem[] {
  return (line.items ?? []).map(({ name, period, amount }) => ({
    name,
    period,
    amount,
  }));
}

/**
 * Applies index-addressed edits to one ledger. Edits at an existing index
 * correct that row; edits at `lines.length`, `lines.length + 1`, ... append new
 * rows in that order. Any other index is a 400, so a stale form can never
 * write past a gap.
 *
 * An edit carrying `items` replaces the row's breakdown whole and marks it
 * `manual`, so the public page shows it. While the breakdown holds items the
 * row's amount is their sum, recomputed here in cents and written over any
 * `amount` sent beside it; `[]` clears the breakdown and leaves the amount.
 * Saving a still-seeded breakdown unchanged is a person confirming it, the
 * same rule a seeded headline figure follows.
 *
 * The array is rebuilt with fresh row objects: TypeORM's dirty check compares
 * the loaded jsonb by reference, so an in-place mutation would not persist.
 */
export function applyLedgerEdits(
  kind: 'income' | 'expense',
  lines: FinanceLine[],
  edits: FinanceLedgerEditDto[] | undefined,
): FinanceEditResult<FinanceLine[]> {
  if (!edits || edits.length === 0) {
    return {
      value: lines,
      audit: [],
      isChanged: false,
      isFigureChanged: false,
    };
  }
  const appended = edits
    .filter((edit) => edit.index >= lines.length)
    .sort((first, second) => first.index - second.index);
  appended.forEach((edit, position) => {
    if (edit.index !== lines.length + position) {
      throw new BadRequestException(
        `No ${kind} ledger row at index ${edit.index}`,
      );
    }
    const hasItems = (edit.items?.length ?? 0) > 0;
    if (edit.label === undefined || (edit.amount === undefined && !hasItems)) {
      throw new BadRequestException(
        `A new ${kind} ledger row needs a label and an amount or line items`,
      );
    }
  });
  edits.forEach((edit) => {
    const line = lines[edit.index];
    if (!line || edit.items !== undefined || edit.amount === undefined) return;
    const hasManualBreakdown =
      line.itemsSource === FinanceMetricSource.Manual &&
      (line.items?.length ?? 0) > 0;
    // A manual breakdown totals its row, so a typed amount sent without items comes from a stale form.
    if (hasManualBreakdown && toCents(edit.amount) !== toCents(line.amount)) {
      throw new BadRequestException(
        'The amount on this ledger row is the sum of its breakdown items. Reload to see the latest breakdown.',
      );
    }
  });

  const audit: FinanceAuditEntry[] = [];
  let isChanged = false;
  let isFigureChanged = false;

  const corrected = lines.map((line, index) => {
    const edit = edits.find((candidate) => candidate.index === index);
    if (!edit) return line;
    const next = { ...line };
    if (edit.label !== undefined) {
      const label = requiredText(edit.label, 'A ledger label');
      if (label !== line.label) {
        audit.push({
          field: `${kind}[${index}].label`,
          oldValue: line.label,
          newValue: label,
        });
        next.label = label;
        isChanged = true;
      }
    }
    let isBreakdownSaved = false;
    let itemsSum: string | undefined;
    if (edit.items !== undefined) {
      const items = cleanLineItems(edit.items);
      const storedItems = storedLineItems(line);
      const isBreakdownChanged =
        JSON.stringify(items) !== JSON.stringify(storedItems);
      const isSeededConfirmed =
        items.length > 0 && line.itemsSource !== FinanceMetricSource.Manual;
      if (isBreakdownChanged || isSeededConfirmed) {
        audit.push({
          field: `${kind}[${index}].items`,
          oldValue: summarizeLineItems(storedItems),
          newValue: summarizeLineItems(items),
        });
        next.items = items;
        next.itemsSource = FinanceMetricSource.Manual;
        isBreakdownSaved = true;
        isChanged = true;
      }
      if (items.length > 0) itemsSum = sumLineItems(items);
    }
    // A row with a breakdown totals itself, so its sum wins over a typed amount.
    // A row keeping its saved breakdown keeps its stored sum: the check above
    // already refused a different figure, so only a respelling reaches here.
    const isKeepingManualBreakdown =
      edit.items === undefined &&
      line.itemsSource === FinanceMetricSource.Manual &&
      (line.items?.length ?? 0) > 0;
    const amount =
      itemsSum ?? (isKeepingManualBreakdown ? undefined : edit.amount);
    if (amount !== undefined && amount !== line.amount) {
      audit.push({
        field: `${kind}[${index}]`,
        oldValue: line.amount,
        newValue: amount,
      });
      next.amount = amount;
      next.source = FinanceMetricSource.Manual;
      isChanged = true;
      isFigureChanged = true;
    }
    if (isBreakdownSaved) {
      next.total = { label: '', amount: next.amount };
    }
    if (edit.note !== undefined && edit.note !== line.note) {
      next.note = toStoredPlainText(edit.note);
      isChanged = true;
    }
    if (edit.enabled !== undefined && edit.enabled !== (line.enabled ?? true)) {
      audit.push({
        field: `${kind}[${index}].enabled`,
        oldValue: String(line.enabled ?? true),
        newValue: String(edit.enabled),
      });
      next.enabled = edit.enabled;
      isChanged = true;
    }
    return next;
  });

  // A new row with a breakdown totals itself, like a corrected one.
  const appendedRows = appended.map((edit) => {
    const items = edit.items === undefined ? [] : cleanLineItems(edit.items);
    const amount = items.length > 0 ? sumLineItems(items) : edit.amount!;
    return { edit, items, amount };
  });
  // An appended row's bar is sized against the largest amount in the ledger,
  // the same reading the seeded rows' curated `width` gives.
  const largestAmount = Math.max(
    0,
    ...corrected.map((line) => amountValue(line.amount)),
    ...appendedRows.map((row) => amountValue(row.amount)),
  );
  const added = appendedRows.map(({ edit, items, amount }): FinanceLine => {
    const label = requiredText(edit.label!, 'A ledger label');
    audit.push({
      field: `${kind}[${edit.index}]`,
      oldValue: null,
      newValue: amount,
    });
    audit.push({
      field: `${kind}[${edit.index}].label`,
      oldValue: null,
      newValue: label,
    });
    if (items.length > 0) {
      audit.push({
        field: `${kind}[${edit.index}].items`,
        oldValue: null,
        newValue: summarizeLineItems(items),
      });
    }
    return {
      label,
      amount,
      note: edit.note === undefined ? '' : toStoredPlainText(edit.note),
      width:
        largestAmount > 0
          ? Math.round((amountValue(amount) / largestAmount) * 100)
          : 0,
      items,
      total: { label: '', amount },
      source: FinanceMetricSource.Manual,
      enabled: edit.enabled ?? true,
      ...(edit.items === undefined
        ? {}
        : { itemsSource: FinanceMetricSource.Manual }),
    };
  });
  if (added.length > 0) {
    isChanged = true;
    isFigureChanged = true;
  }

  return {
    value: [...corrected, ...added],
    audit,
    isChanged,
    isFigureChanged,
  };
}

/** A whole-section replacement: audited as one row holding both JSON
 *  snapshots. The sections (stats, event notes, partners, reserve) are the
 *  report's words and disclosures, so none of them counts as a figure. */
function replaceSection<Value>(
  field: string,
  before: Value,
  after: Value,
): FinanceEditResult<Value> {
  const beforeJson = JSON.stringify(before);
  const afterJson = JSON.stringify(after);
  if (beforeJson === afterJson) {
    return {
      value: before,
      audit: [],
      isChanged: false,
      isFigureChanged: false,
    };
  }
  return {
    value: after,
    audit: [{ field, oldValue: beforeJson, newValue: afterJson }],
    isChanged: true,
    isFigureChanged: false,
  };
}

export function replaceStats(
  before: FinanceStat[],
  submitted: FinanceStatEditDto[],
): FinanceEditResult<FinanceStat[]> {
  return replaceSection(
    'stats',
    before,
    submitted.map((stat) => ({
      n: requiredText(stat.n, 'A stat figure'),
      l: requiredText(stat.l, 'A stat label'),
      trend: toStoredPlainText(stat.trend),
      up: stat.up,
    })),
  );
}

export function replaceEventNotes(
  before: FinanceEventNote[],
  submitted: FinanceEventNoteEditDto[],
): FinanceEditResult<FinanceEventNote[]> {
  return replaceSection(
    'eventNotes',
    before,
    submitted.map((note) => ({
      title: requiredText(note.title, 'An event note title'),
      body: toStoredPlainText(note.body),
    })),
  );
}

/**
 * The disclosed partners, as a full replacement list. Each partner carries its
 * restriction in one of two forms:
 *
 *  - `scope`, the words the admin typed. Sent whenever the admin edited the
 *    restriction, and it always wins.
 *  - `scopeKey` alone, for a partner whose translated restriction the admin
 *    left as it was. The key is kept so every reader still sees the
 *    restriction in their own language. Only a key the stored list already
 *    carries is accepted: the public page resolves it through `t()`, so an
 *    arbitrary key would print as raw text.
 *
 * Every saved partner is marked `manual`: an admin who saves the list with a
 * seeded partner in it is confirming that partner, the same rule a seeded
 * headline figure follows, so it reaches the public page.
 */
export function replacePartners(
  before: FinancePartner[] | null,
  submitted: FinancePartnerEditDto[],
): FinanceEditResult<FinancePartner[]> {
  const storedScopeKeys = new Set(
    (before ?? [])
      .map((partner) => partner.scopeKey)
      .filter((scopeKey): scopeKey is string => Boolean(scopeKey)),
  );
  return replaceSection(
    'partners',
    before ?? [],
    submitted.map((partner): FinancePartner => {
      const name = requiredText(partner.name, 'A partner name');
      if (partner.scope === undefined && partner.scopeKey !== undefined) {
        if (!storedScopeKeys.has(partner.scopeKey)) {
          throw new BadRequestException(
            `Unknown partner restriction key: ${partner.scopeKey}`,
          );
        }
        return {
          name,
          amount: partner.amount,
          scopeKey: partner.scopeKey,
          source: FinanceMetricSource.Manual,
        };
      }
      return {
        name,
        amount: partner.amount,
        scope: requiredText(partner.scope ?? '', 'A partner restriction'),
        source: FinanceMetricSource.Manual,
      };
    }),
  );
}

export function replaceReserve(
  before: FinanceReserve | null,
  submitted: FinanceReserveEditDto | null,
): FinanceEditResult<FinanceReserve | null> {
  return replaceSection(
    'reserve',
    before,
    submitted === null
      ? null
      : { current: submitted.current, target: submitted.target },
  );
}
