import { ApiProperty } from '@nestjs/swagger';
import { IdentityKind } from '../entities/identity.entity';
import type { IdentityDescription } from '../identities.service';

/**
 * Task 15: one mailbox the caller may read and answer, as the header mailbox
 * switcher shows it (`GET /identities/mailboxes`). A mailbox is addressed by
 * `identityId` everywhere after this list, so every entry carries one.
 * Hand-mapped by `toMailboxSummary`.
 */
export class MailboxSummaryDto {
  @ApiProperty({ format: 'uuid' })
  identityId!: string;

  @ApiProperty({ enum: IdentityKind, enumName: 'IdentityKind' })
  kind!: IdentityKind;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "The identity's own name from `IdentitiesService.describeIdentities`. " +
      'Null when its owner row was deleted between the staffing read and ' +
      'this description; the client shows its own generic label.',
  })
  displayName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  handle!: string | null;

  @ApiProperty({ type: String, nullable: true })
  avatarUrl!: string | null;

  @ApiProperty({
    description: "Unread threads in this mailbox, by the nav badge's rules.",
  })
  unreadCount!: number;

  @ApiProperty({
    description:
      'True for the member themself and for the owner of a listing, ' +
      'persona or company. False for a co-manager, a persona co-owner and a ' +
      'company team member.',
  })
  isOwner!: boolean;

  @ApiProperty({
    description:
      'True for a persona that moderation removed: its staff keep reading ' +
      'its threads and can send nothing as it. False for every other mailbox.',
  })
  isReadOnly!: boolean;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description:
      "This mailbox owner's naming switch (Task 20). Null for the profile " +
      'mailbox, where naming has no meaning.',
  })
  shouldShowStaffNames!: boolean | null;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description:
      "The caller's own naming preference for this mailbox (Task 20), true " +
      'when they have never changed it. Null for the profile mailbox.',
  })
  shouldAllowMyName!: boolean | null;
}

/** Hand-maps one mailbox to its response shape. */
export function toMailboxSummary(input: {
  identityId: string;
  kind: IdentityKind;
  description: IdentityDescription | undefined;
  unreadCount: number;
  isOwner: boolean;
  isReadOnly: boolean;
  shouldShowStaffNames: boolean | null;
  shouldAllowMyName: boolean | null;
}): MailboxSummaryDto {
  return {
    identityId: input.identityId,
    kind: input.kind,
    displayName: input.description?.displayName ?? null,
    handle: input.description?.handle ?? null,
    avatarUrl: input.description?.avatarUrl ?? null,
    unreadCount: input.unreadCount,
    isOwner: input.isOwner,
    isReadOnly: input.isReadOnly,
    shouldShowStaffNames: input.shouldShowStaffNames,
    shouldAllowMyName: input.shouldAllowMyName,
  };
}
