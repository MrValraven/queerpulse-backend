import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  COHOST_INVITE_COMMITMENT_IDS,
  COHOST_INVITE_ROLE_IDS,
} from '../cohost-invite-options';

export class CreateCohostInviteDto {
  @IsString()
  inviteeSlug!: string;

  @IsIn(COHOST_INVITE_ROLE_IDS)
  role!: string;

  @IsIn(COHOST_INVITE_COMMITMENT_IDS)
  commitment!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;

  @IsOptional()
  @IsISO8601()
  replyByDate?: string;
}
