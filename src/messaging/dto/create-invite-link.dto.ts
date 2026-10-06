import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  GROUP_INVITE_LINK_MAX_USES_OPTIONS,
  type GroupInviteLinkMaxUses,
} from '../group-invite-link-usage';

/**
 * `POST /conversations/:id/invite-link` body (PRD-400, use cap). Every field
 * is optional, so the existing empty `{}` body still creates an unlimited
 * link.
 */
export class CreateInviteLinkDto {
  /** How many people may join with the new link: one of
   *  `GROUP_INVITE_LINK_MAX_USES_OPTIONS`. Null or omitted means unlimited. */
  @ApiPropertyOptional({
    enum: GROUP_INVITE_LINK_MAX_USES_OPTIONS,
    nullable: true,
    description: 'Use cap for the new link; null or omitted means unlimited.',
  })
  @IsOptional()
  @IsIn(GROUP_INVITE_LINK_MAX_USES_OPTIONS)
  maxUses?: GroupInviteLinkMaxUses | null;
}
