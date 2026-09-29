import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * ENG-456: why a mailbox never names its staff to a customer, whatever
 * either switch says. `unlinkedPersona` is a persona that keeps who runs it
 * private (`subprofiles.link_visibility` is not `linked`).
 */
export const STAFF_NAMES_LOCKED_REASONS = ['unlinkedPersona'] as const;
export type StaffNamesLockedReason =
  (typeof STAFF_NAMES_LOCKED_REASONS)[number];

/**
 * Task 20: the two attribution switches for one mailbox, read by
 * `GET /identities/:identityId/attribution` and echoed back by
 * `PATCH /identities/:identityId/attribution` and
 * `PUT /identities/:identityId/staff-preferences/me`. Both switches are read
 * live, on every render, by `IdentityAttributionService`; this DTO is the
 * settings surface, never the customer-facing read path itself.
 */
export class IdentityAttributionDto {
  @ApiProperty({
    description:
      "The mailbox owner's own switch. When true, a staff reply may show " +
      "a first name, still gated by that staff member's own preference.",
  })
  shouldShowStaffNames!: boolean;

  @ApiProperty({
    description:
      "The caller's own naming preference for this mailbox. True when " +
      'they have never changed it.',
  })
  shouldAllowMyName!: boolean;

  @ApiProperty({
    description: 'True when the caller is this mailbox owner.',
  })
  isOwner!: boolean;

  @ApiProperty({
    description:
      'True when the caller may change `shouldShowStaffNames`: the owner, or ' +
      'any staff member of a listing that has no owner (PRD-432). False on ' +
      'an unlinked persona, whose staff are never named.',
  })
  isAllowedToChangeStaffNames!: boolean;

  @ApiProperty({
    type: String,
    enum: STAFF_NAMES_LOCKED_REASONS,
    nullable: true,
    description:
      'Set when customers never see a staff name here, whatever both ' +
      'switches say (ENG-456). `shouldShowStaffNames` still reports the ' +
      'stored column, which applies again if the reason ends. Null otherwise.',
  })
  staffNamesLockedReason!: StaffNamesLockedReason | null;
}

/**
 * Body of `PATCH /identities/:identityId/attribution`: the owner, or any
 * staff member of an ownerless listing.
 */
export class UpdateIdentityAttributionDto {
  @ApiProperty({
    description: "The mailbox owner's naming switch to set.",
  })
  @IsBoolean()
  shouldShowStaffNames!: boolean;
}

/**
 * Body of `PUT /identities/:identityId/staff-preferences/me`, any staff
 * member, for their own row only.
 */
export class UpdateOwnStaffPreferenceDto {
  @ApiProperty({
    description: "The caller's own naming preference to set.",
  })
  @IsBoolean()
  shouldAllowNaming!: boolean;
}
