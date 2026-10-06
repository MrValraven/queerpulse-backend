import { BadRequestException } from '@nestjs/common';
import { toStoredPlainText } from '../communities/community-plain-text';
import {
  FinanceEventNote,
  FinanceLine,
  FinanceMetricSource,
  FinancePartner,
  FinanceReserve,
  FinanceStat,
} from './entities/governance-finance-report.entity';
import {
  FinanceEventNoteEditDto,
  FinanceLedgerEditDto,
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

/**
 * Applies index-addressed edits to one ledger. Edits at an existing index
 * correct that row; edits at `lines.length`, `lines.length + 1`, ... append new
 * rows in that order. Any other index is a 400, so a stale form can never
 * write past a gap.
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
    return { value: lines, audit: [], isChanged: false };
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
    if (edit.label === undefined || edit.amount === undefined) {
      throw new BadRequestException(
        `A new ${kind} ledger row needs a label and an amount`,
      );
    }
  });

  const audit: FinanceAuditEntry[] = [];
  let isChanged = false;

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
    if (edit.amount !== undefined && edit.amount !== line.amount) {
      audit.push({
        field: `${kind}[${index}]`,
        oldValue: line.amount,
        newValue: edit.amount,
      });
      next.amount = edit.amount;
      next.source = FinanceMetricSource.Manual;
      isChanged = true;
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

  // An appended row's bar is sized against the largest amount in the ledger,
  // the same reading the seeded rows' curated `width` gives.
  const largestAmount = Math.max(
    0,
    ...corrected.map((line) => amountValue(line.amount)),
    ...appended.map((edit) => amountValue(edit.amount!)),
  );
  const added = appended.map((edit): FinanceLine => {
    const amount = edit.amount!;
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
    return {
      label,
      amount,
      note: edit.note === undefined ? '' : toStoredPlainText(edit.note),
      width:
        largestAmount > 0
          ? Math.round((amountValue(amount) / largestAmount) * 100)
          : 0,
      items: [],
      total: { label: '', amount },
      source: FinanceMetricSource.Manual,
      enabled: edit.enabled ?? true,
    };
  });
  if (added.length > 0) isChanged = true;

  return { value: [...corrected, ...added], audit, isChanged };
}

/** A whole-section replacement: audited as one row holding both JSON snapshots. */
function replaceSection<Value>(
  field: string,
  before: Value,
  after: Value,
): FinanceEditResult<Value> {
  const beforeJson = JSON.stringify(before);
  const afterJson = JSON.stringify(after);
  if (beforeJson === afterJson) {
    return { value: before, audit: [], isChanged: false };
  }
  return {
    value: after,
    audit: [{ field, oldValue: beforeJson, newValue: afterJson }],
    isChanged: true,
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

export function replacePartners(
  before: FinancePartner[] | null,
  submitted: FinancePartnerEditDto[],
): FinanceEditResult<FinancePartner[]> {
  return replaceSection(
    'partners',
    before ?? [],
    submitted.map((partner) => ({
      name: requiredText(partner.name, 'A partner name'),
      amount: partner.amount,
      scope: requiredText(partner.scope, 'A partner restriction'),
    })),
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
