import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

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
}

/** Body of `PATCH /identities/:identityId/attribution`, owner only. */
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
