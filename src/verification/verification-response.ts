import { MemberRef } from '../common/member-ref';
import { MemberVerification } from './entities/member-verification.entity';
import { VerificationLevel } from './verification-level';

/** The member's own verification standing (what the step-up UI reads). */
export interface VerificationStatusDTO {
  level: VerificationLevel;
  /** Convenience booleans so the client never re-derives the ladder. */
  phoneVerified: boolean;
  idVerified: boolean;
  method: string | null;
  provider: string | null;
  verifiedAt: string | null;
}

export function toVerificationStatusDTO(
  level: VerificationLevel,
  row: MemberVerification | null,
): VerificationStatusDTO {
  return {
    level,
    phoneVerified:
      level === VerificationLevel.Phone ||
      level === VerificationLevel.IdVerified,
    idVerified: level === VerificationLevel.IdVerified,
    method: row?.method ?? null,
    provider: row?.provider ?? null,
    verifiedAt: row?.verifiedAt?.toISOString() ?? null,
  };
}

/** Admin-facing row for the manual-review console. Carries the member ref and
 * the opaque provider ref (never any document data — there is none to carry). */
export interface AdminVerificationDTO {
  userId: string;
  member: MemberRef | null;
  level: VerificationLevel;
  method: string | null;
  provider: string | null;
  providerRef: string | null;
  verifiedAt: string | null;
  updatedAt: string;
}

export function toAdminVerificationDTO(
  row: MemberVerification,
  member: MemberRef | null,
): AdminVerificationDTO {
  return {
    userId: row.userId,
    member,
    level: row.level,
    method: row.method,
    provider: row.provider,
    providerRef: row.providerRef,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}
