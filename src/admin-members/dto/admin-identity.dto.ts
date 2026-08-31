import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * The bodies behind the three identity-recovery levers (PRD-06, PRD-11,
 * PRD-13). All three share one requirement: a written reason.
 *
 * Every one of these actions is a correction to something the platform did on
 * purpose, and each writes a `mod_audit_logs` row that outlives the account it
 * names. A reason is what makes that row worth reading a year later, so it is
 * mandatory at the DTO boundary rather than optional. The 8-character floor is
 * there to refuse a reflexive "ok" while staying out of the operator's way.
 *
 * `forbidNonWhitelisted` is on globally, so these classes also NARROW the body:
 * a caller cannot smuggle a `googleId`, a `status` or a `userId` into any of
 * them. That matters most for {@link ApplyRelinkDto}, whose whole safety
 * argument is that no operator anywhere hands the server a Google subject.
 */

/** Shared floor/ceiling so the three reasons cannot drift apart. */
const REASON_MIN_LENGTH = 8;
const REASON_MAX_LENGTH = 2000;

/**
 * `POST /admin/members/:memberId/account-recovery/candidates/:candidateId/relink`.
 *
 * Carries a reason and NOTHING else. The identity being linked is named by the
 * `:candidateId` path param, which can only resolve to a row the sign-up path
 * wrote after Google asserted `email_verified: true` for this member's own
 * address. There is deliberately no `googleId` field here, and adding one would
 * undo the control the whole feature rests on.
 */
export class ApplyRelinkDto {
  @IsString()
  @MinLength(REASON_MIN_LENGTH)
  @MaxLength(REASON_MAX_LENGTH)
  reason!: string;
}

/**
 * `POST /admin/members/:memberId/account-recovery/candidates/:candidateId/dismiss`:
 * this identity is not the member, so stop offering it.
 *
 * A dismissal is a security signal in its own right (somebody who is not the
 * member holds a Google account on their address), so it is recorded and
 * audited rather than being a quiet delete.
 */
export class DismissRelinkDto {
  @IsString()
  @MinLength(REASON_MIN_LENGTH)
  @MaxLength(REASON_MAX_LENGTH)
  reason!: string;
}

/**
 * `POST /admin/members/:memberId/account-recovery/reactivate`: put back a member left
 * `Deactivated` with no open deactivation row (PRD-11).
 *
 * No target status field: the endpoint restores `Active` and only ever runs in
 * the one state where that is the correct answer. Letting an operator name the
 * status would make this a general-purpose account-status writer, which is
 * exactly what the deactivation ledger exists to prevent.
 */
export class ReactivateMemberDto {
  @IsString()
  @MinLength(REASON_MIN_LENGTH)
  @MaxLength(REASON_MAX_LENGTH)
  reason!: string;
}

/**
 * `POST /admin/email-suppressions/lookup` — is this address on the erasure
 * suppression list?
 *
 * The address travels in a BODY rather than a query string on purpose. A query
 * string lands in access logs, proxy logs and browser history, and the whole
 * point of the suppression list is that it holds a hash instead of an address
 * (see `EmailSuppression`). Putting the plaintext in a URL would re-create the
 * plaintext trail the table was designed to avoid.
 *
 * Normalized here with the same `trim().toLowerCase()` that
 * `hashSuppressedEmail` applies, so what an operator sees echoed back matches
 * what was hashed.
 */
export class LookupEmailSuppressionDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

/**
 * `POST /admin/email-suppressions/lift` — remove a suppression row so a person
 * who erased their account can sign up again (PRD-13).
 *
 * The permanence of the list is deliberate, so this is a correction lever. It
 * requires the address AND a reason, and it is audited. It does not restore
 * anything: the erased account is gone, and lifting only removes the block on
 * creating a NEW one.
 */
export class LiftEmailSuppressionDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(REASON_MIN_LENGTH)
  @MaxLength(REASON_MAX_LENGTH)
  reason!: string;
}
