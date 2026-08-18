import { IsIn } from 'class-validator';

export class RespondCohostInviteDto {
  @IsIn(['accept', 'decline'])
  action!: 'accept' | 'decline';
}
