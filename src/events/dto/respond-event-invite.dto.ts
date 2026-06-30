import { IsIn } from 'class-validator';

export class RespondEventInviteDto {
  @IsIn(['accept', 'decline'])
  action: 'accept' | 'decline';
}
