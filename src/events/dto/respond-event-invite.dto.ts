import { Type } from 'class-transformer';
import { IsIn, IsOptional, ValidateNested } from 'class-validator';
import { AcceptInviteDetailsDto } from './accept-invite-details.dto';

export class RespondEventInviteDto {
  @IsIn(['accept', 'decline'])
  action!: 'accept' | 'decline';

  // Required when accepting (the service answers 400 without it) and ignored
  // when declining.
  @IsOptional()
  @ValidateNested()
  @Type(() => AcceptInviteDetailsDto)
  details?: AcceptInviteDetailsDto;
}
