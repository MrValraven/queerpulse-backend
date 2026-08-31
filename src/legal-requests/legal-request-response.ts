import type { Paginated } from '../common/pagination';
import type { LegalRequest } from './entities/legal-request.entity';
import type {
  LegalRequestDataCategory,
  LegalRequestOutcome,
  LegalRequestType,
} from './legal-request-vocabulary';

/**
 * The ADMIN view of one register row (`/admin/legal-requests`), and the only
 * shape that ever carries a single demand's content.
 *
 * Hand-mapped from the entity rather than returned raw. This repo has no
 * global response serializer, so handing back a `LegalRequest` would put
 * `recorded_by_user_id` and `voided_by_user_id` on the wire, and this is the
 * one table where a leaked column is a member's name in a police file. The
 * mapper below is therefore an allowlist: a column added to the entity later
 * does not appear here until somebody writes the line.
 *
 * Two actor ids are deliberately absent. `recordedByUserId` and
 * `voidedByUserId` stay server-side and the pane reads `recordedByName`, the
 * write-time snapshot, which is what a colleague opening the register a year
 * later actually needs. `AdminDsarRequestDTO` omits its own decider column for
 * the same reason.
 *
 * NOTHING here reaches the public Transparency Report. The report publishes
 * counts over this table and no field of this DTO; `requestingBody`,
 * `jurisdiction`, `internalNote`, `notificationWithheldReason`,
 * `dataDisclosed` and `voidReason` have no public counterpart at any
 * aggregation.
 */
export interface AdminLegalRequestDTO {
  id: string;
  requestingBody: string;
  jurisdiction: string;
  requestType: LegalRequestType;
  /** `YYYY-MM-DD`. */
  receivedOn: string;
  accountsAffected: number;
  outcome: LegalRequestOutcome;
  dataDisclosed: LegalRequestDataCategory[];
  /** `YYYY-MM-DD`, or null while the named members have not been told. */
  memberNotifiedOn: string | null;
  accountsNotified: number;
  notificationWithheldReason: string | null;
  isUnderGagOrder: boolean;
  internalNote: string | null;
  /** Write-time snapshot of the recording admin's display name. Null on a row
   *  whose author has since erased their account. */
  recordedByName: string | null;
  /**
   * True once the record has been struck. A voided row is still listed, still
   * readable and still counted as a voided record by the public report: it is
   * dropped from the published figures, never from the register.
   */
  isVoided: boolean;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AdminLegalRequestPageDTO = Paginated<AdminLegalRequestDTO>;

export function toAdminLegalRequestDTO(
  record: LegalRequest,
): AdminLegalRequestDTO {
  // `?? null` rather than a bare `!== null` check: a row that has just been
  // inserted carries `undefined` in the columns the INSERT never named, and
  // reading that as "voided" would publish a fresh record as struck.
  const voidedAt = record.voidedAt ?? null;
  return {
    id: record.id,
    requestingBody: record.requestingBody,
    jurisdiction: record.jurisdiction,
    requestType: record.requestType,
    receivedOn: record.receivedOn,
    accountsAffected: record.accountsAffected,
    outcome: record.outcome,
    dataDisclosed: record.dataDisclosed ?? [],
    memberNotifiedOn: record.memberNotifiedOn ?? null,
    accountsNotified: record.accountsNotified,
    notificationWithheldReason: record.notificationWithheldReason ?? null,
    isUnderGagOrder: record.isUnderGagOrder,
    internalNote: record.internalNote ?? null,
    recordedByName: record.recordedByName ?? null,
    isVoided: voidedAt !== null,
    voidedAt: voidedAt ? voidedAt.toISOString() : null,
    voidReason: record.voidReason ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
